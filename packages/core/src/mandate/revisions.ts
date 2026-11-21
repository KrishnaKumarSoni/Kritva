/**
 * Changing the principal's instructions mid-session (Epic 4, Stories 2 and 3).
 *
 * 1. Draft: the new instruction text is mapped with Epic 1's mapper into a draft and recorded.
 *    A draft never has authority, and a failed mapping records nothing.
 * 2. Review: the draft shows its rules, open issues and what each would allow.
 * 3. Confirm or reject: only the principal's control does either. Confirming creates the next
 *    mandate revision; pending proposals are checked again; history is kept.
 */
import { readAuthority } from "../governance/authority.ts";
import type { StructuredLlm } from "../llm/types.ts";
import { mapToDraft, type MappingError } from "../mapping/mapper.ts";
import type { NegotiationEngine } from "../negotiation/engine.ts";
import type { PayloadOf, RecordedEvent } from "../record/events.ts";
import { newEventId, type NegotiationRecord } from "../record/store.ts";
import type { ConfirmedMandate, MandateDraft } from "../schema/records.ts";
import { validateDraft, type ValidationIssue } from "../schema/validate.ts";
import { confirmMandate } from "./confirm.ts";

export type DraftStatus = "open" | "confirmed" | "rejected" | "stale";

export interface DraftView {
  draftId: string;
  status: DraftStatus;
  basedOnRevision: number;
  instructions: string;
  draft: MandateDraft;
  readiness: Readiness;
  createdAt: string;
}

/** What a mandate would allow, and what must be clarified before the affected action. */
export interface Readiness {
  propose: Array<{ termId: string; name: string; mode: string }>;
  accept: string;
  unresolved: Array<{ termId: string; name: string; reason: string }>;
  exceptions: Array<{ limitId: string; termName: string; exception: "not_allowed" | "with_approval" }>;
  openIssues: Array<{ id: string; kind: string; message: string }>;
}

export function readiness(mandate: MandateDraft | ConfirmedMandate): Readiness {
  const asConfirmed = { ...mandate, approval: { status: "confirmed", confirmedBy: "", confirmedAt: new Date(0).toISOString(), acknowledgedIssueIds: [] } } as unknown as ConfirmedMandate;
  const authority = readAuthority(asConfirmed);
  const nameOf = (id: string) => mandate.terms.find((t) => t.id === id)?.name ?? id;
  const principalTerms = [...new Set(mandate.positions.filter((p) => mandate.parties.find((x) => x.id === p.partyId)?.isPrincipal).map((p) => p.termId))];
  return {
    propose: principalTerms.map((termId) => ({ termId, name: nameOf(termId), mode: authority.propose(termId) })),
    accept: authority.accept(),
    unresolved: [...authority.unresolvedTerms].map(([termId, reason]) => ({ termId, name: nameOf(termId), reason })),
    exceptions: mandate.limits
      .filter((l) => l.kind === "minimum" || l.kind === "maximum" || l.kind === "must_equal")
      .map((l) => ({ limitId: l.id, termName: nameOf(l.termId), exception: authority.exceptionFor(l.id) })),
    openIssues: mandate.issues.map((i) => ({ id: i.id, kind: i.kind, message: i.message })),
  };
}

export class MandateRevisions {
  readonly #record: NegotiationRecord;
  readonly #engine: NegotiationEngine;
  readonly #mappingLlm: StructuredLlm;

  constructor(options: { record: NegotiationRecord; engine: NegotiationEngine; mappingLlm: StructuredLlm }) {
    this.#record = options.record;
    this.#engine = options.engine;
    this.#mappingLlm = options.mappingLlm;
  }

  /** The private instruction text currently in force, for editing. */
  async currentInstructions(sessionId: string): Promise<string> {
    const ctx = await this.#record.context(sessionId);
    return (ctx.mandate?.sources ?? []).filter((s) => s.disclosure === "private" && s.authorPartyId === principalOf(ctx.mandate!)).map((s) => s.text).join("\n\n");
  }

  /** Maps new instructions into a draft. Nothing changes authority, and a failure records nothing. */
  async propose(input: { sessionId: string; instructions: string }): Promise<{ ok: true; draft: DraftView } | { ok: false; error: MappingError | { code: string; message: string; validationErrors: ValidationIssue[] } }> {
    const ctx = await this.#record.context(input.sessionId);
    const mandate = ctx.mandate;
    if (!mandate) return { ok: false, error: { code: "session_not_found", message: "The session does not exist.", validationErrors: [] } };
    const principalId = principalOf(mandate);
    const revision = ctx.mandateRevision + 1;
    // Public sources stay; the principal's private instructions are replaced by the new text.
    const sources = [
      ...mandate.sources.filter((s) => !(s.disclosure === "private" && s.authorPartyId === principalId)),
      { id: `instructions-r${revision}-${Date.now().toString(36)}`, authorPartyId: principalId, disclosure: "private" as const, format: "unspecified" as const, label: "Principal instructions", text: input.instructions.trim() },
    ];
    const mapped = await mapToDraft({ caseId: mandate.caseId, parties: mandate.parties, sources }, { llm: this.#mappingLlm });
    if (!mapped.ok) return { ok: false, error: mapped.error };
    const appended = await this.#record.append(
      input.sessionId,
      { id: newEventId(), type: "mandate_draft_proposed", channel: null, payload: { draft: mapped.draft, basedOnRevision: ctx.mandateRevision, instructions: input.instructions.trim() } },
      { kind: "principal", partyId: principalId },
    );
    if (!appended.ok) return { ok: false, error: { code: appended.error.code, message: appended.error.message, validationErrors: appended.error.errors } };
    return { ok: true, draft: toView(appended.event, "open") };
  }

  async drafts(sessionId: string): Promise<DraftView[]> {
    const ctx = await this.#record.context(sessionId);
    return ctx.events
      .filter((e) => e.type === "mandate_draft_proposed")
      .map((e) => {
        const p = e.payload as PayloadOf<"mandate_draft_proposed">;
        const confirmed = ctx.events.some((x) => x.type === "mandate_revised" && (x.payload as PayloadOf<"mandate_revised">).draftId === e.id);
        const rejected = ctx.events.some((x) => x.type === "mandate_draft_rejected" && (x.payload as PayloadOf<"mandate_draft_rejected">).draftId === e.id);
        const status: DraftStatus = confirmed ? "confirmed" : rejected ? "rejected" : p.basedOnRevision !== ctx.mandateRevision ? "stale" : "open";
        return toView(e, status);
      });
  }

  /** Only the principal's control calls this. The draft becomes the next mandate revision. */
  async confirm(input: { sessionId: string; draftId: string; acknowledgedIssueIds: string[] }) {
    const ctx = await this.#record.context(input.sessionId);
    const draft = ctx.payloadOf(input.draftId, "mandate_draft_proposed");
    if (!draft || !ctx.mandate) return { ok: false as const, code: "not_found", message: "That draft does not exist." };
    const checked = validateDraft(draft.draft);
    if (!checked.ok) return { ok: false as const, code: "invalid_draft", message: "The draft is not valid." };
    const confirmed = confirmMandate(checked.draft, { confirmedBy: principalOf(ctx.mandate), acknowledgedIssueIds: input.acknowledgedIssueIds });
    if (!confirmed.ok) return { ok: false as const, code: "not_confirmed", message: "Every open issue must be acknowledged before confirming.", errors: confirmed.errors };
    return this.#engine.reviseMandate({ sessionId: input.sessionId, mandate: confirmed.mandate, reason: "The principal confirmed revised instructions.", draftId: input.draftId });
  }

  async reject(input: { sessionId: string; draftId: string }) {
    const ctx = await this.#record.context(input.sessionId);
    if (!ctx.mandate) return { ok: false as const, code: "not_found", message: "The session does not exist." };
    const result = await this.#record.append(
      input.sessionId,
      { id: newEventId(), type: "mandate_draft_rejected", channel: null, payload: { draftId: input.draftId, reason: "The principal rejected the draft." } },
      { kind: "principal", partyId: principalOf(ctx.mandate) },
    );
    return result.ok ? { ok: true as const } : { ok: false as const, code: result.error.code, message: result.error.message };
  }
}

function principalOf(mandate: { parties: Array<{ id: string; isPrincipal: boolean }> }): string {
  return mandate.parties.find((p) => p.isPrincipal)!.id;
}

function toView(e: RecordedEvent, status: DraftStatus): DraftView {
  const p = e.payload as PayloadOf<"mandate_draft_proposed">;
  return { draftId: e.id, status, basedOnRevision: p.basedOnRevision, instructions: p.instructions, draft: p.draft, readiness: readiness(p.draft), createdAt: e.recordedAt };
}
