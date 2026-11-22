/**
 * Epic 11: case-level mandates. A mandate exists here before any session starts.
 *
 * - Create: plain-language public facts and private instructions go through the Epic 1 mapper and
 *   validator into a draft version. A draft has no authority.
 * - Correct: a principal's direct edit to an extracted value, permission mode or record is a new,
 *   principal-authored draft version (with its own quoted source), validated again. The old text is
 *   never re-mapped over it.
 * - Confirm: only the principal's control, for the exact draft version and content hash reviewed.
 *   Conflicts and unresolved permissions block confirmation; other issues must be acknowledged.
 *   Each confirmation is the next revision. Earlier versions and revisions are kept.
 * - Sessions start from the active (latest confirmed) revision and record which one they used.
 *
 * Storage is append-only behind LibraryBackend; SQLite is the local implementation.
 */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { StructuredLlm } from "../llm/types.ts";
import { mapToDraft, type MappingError } from "../mapping/mapper.ts";
import { PermissionMode, type ConfirmedMandate, type MandateDraft, type PrincipalSide, type Value } from "../schema/records.ts";

type Mode = (typeof PermissionMode.options)[number];
import { validateDraft, type ValidationIssue } from "../schema/validate.ts";
import { confirmMandate } from "./confirm.ts";
import { readiness, type Readiness } from "./revisions.ts";

export interface LibraryInput {
  title: string;
  principalRole: string;
  counterpartyRole: string;
  /** Facts the other party may see (a listing, a brief). */
  publicText: string;
  /** The principal's private instructions (limits, permissions). May be empty. */
  privateText: string;
  /** Whether the principal receives or pays the negotiated amount. Null: not known yet. */
  principalSide?: PrincipalSide | null;
}

/** One principal-authored edit to a draft record. */
export type Correction =
  | { recordId: string; value: string }
  | { recordId: string; mode: Mode }
  | { recordId: string; remove: true };

interface MandateRow {
  id: string;
  caseId: string;
  title: string;
  createdAt: string;
}

interface VersionRow {
  id: string;
  mandateId: string;
  seq: number;
  createdAt: string;
  origin: "text" | "correction";
  input: LibraryInput;
  corrections: Correction[];
  basedOnVersionId: string | null;
  draft: MandateDraft;
  draftHash: string;
}

interface LibraryEventRow {
  id: string;
  mandateId: string;
  versionId: string;
  kind: "confirmed" | "discarded";
  revision: number | null;
  createdAt: string;
  confirmed: ConfirmedMandate | null;
}

/** The principal's lifecycle actions on a saved mandate. Append-only, like versions and confirmations. */
export type LifecycleAction = "paused" | "resumed" | "closed" | "reopened" | "deleted";

interface LifecycleRow {
  id: string;
  mandateId: string;
  kind: LifecycleAction;
  createdAt: string;
}

/**
 * Where a saved mandate stands for the principal:
 * - draft: no confirmed revision yet, so it cannot be used
 * - live: confirmed and available for negotiations
 * - paused: confirmed, but Kritva starts nothing new with it until resumed
 * - closed: finished; it stays in the list and can be reopened
 */
export type MandateState = "draft" | "live" | "paused" | "closed";

export interface LibraryBackend {
  insertLifecycle(row: LifecycleRow): void;
  listLifecycle(mandateId: string): LifecycleRow[];
  insertMandate(row: MandateRow): void;
  listMandates(): MandateRow[];
  getMandate(id: string): MandateRow | null;
  insertVersion(row: VersionRow): void;
  listVersions(mandateId: string): VersionRow[];
  insertEvent(row: LibraryEventRow): void;
  listEvents(mandateId: string): LibraryEventRow[];
  transaction<T>(fn: () => T): T;
}

export type VersionStatus = "draft" | "confirmed" | "superseded" | "discarded";

export interface LibraryVersion {
  versionId: string;
  seq: number;
  origin: "text" | "correction";
  status: VersionStatus;
  revision: number | null;
  createdAt: string;
  draftHash: string;
}

export interface LibraryDetail {
  mandateId: string;
  caseId: string;
  title: string;
  createdAt: string;
  input: LibraryInput;
  versions: LibraryVersion[];
  /** live, paused, closed, or draft while nothing is confirmed. */
  state: MandateState;
  deleted: boolean;
  /** The latest version, whatever its status. */
  latest: { versionId: string; status: VersionStatus; draft: MandateDraft; draftHash: string; readiness: Readiness; blockers: string[] } | null;
  active: { revision: number; versionId: string; confirmedAt: string; mandate: ConfirmedMandate } | null;
}

export type LibraryResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string; errors?: ValidationIssue[] };

export class MandateLibrary {
  readonly #backend: LibraryBackend;
  readonly #mappingLlm: StructuredLlm;
  readonly #now: () => Date;

  constructor(options: { backend: LibraryBackend; mappingLlm: StructuredLlm; now?: () => Date }) {
    this.#backend = options.backend;
    this.#mappingLlm = options.mappingLlm;
    this.#now = options.now ?? (() => new Date());
  }

  /** Saved mandates, newest activity last. Deleted mandates are left out. */
  list(): Array<{ mandateId: string; title: string; caseId: string; activeRevision: number | null; hasOpenDraft: boolean; state: MandateState; updatedAt: string; principalSide: PrincipalSide | null }> {
    return this.#backend.listMandates().flatMap((m) => {
      const d = this.get(m.id)!;
      if (d.deleted) return [];
      const lifecycle = this.#backend.listLifecycle(m.id);
      const updatedAt = [m.createdAt, ...d.versions.map((v) => v.createdAt), ...lifecycle.map((e) => e.createdAt)].sort().at(-1)!;
      const principalSide = principalSideOf(d.active?.mandate ?? d.latest?.draft ?? null) ?? d.input.principalSide ?? null;
      return [{ mandateId: m.id, title: d.title, caseId: m.caseId, activeRevision: d.active?.revision ?? null, hasOpenDraft: d.latest?.status === "draft", state: d.state, updatedAt, principalSide }];
    });
  }

  /**
   * Pause, resume, close, reopen or delete. Only confirmed mandates can be paused or closed; a
   * deleted mandate leaves the list and cannot start negotiations, but its versions and the
   * negotiations that used it keep their record.
   */
  setLifecycle(mandateId: string, action: LifecycleAction): LibraryResult<LibraryDetail> {
    const d = this.get(mandateId);
    if (!d || d.deleted) return { ok: false, code: "not_found", message: "That mandate does not exist." };
    const allowed: Record<LifecycleAction, MandateState[]> = {
      paused: ["live"],
      resumed: ["paused"],
      closed: ["live", "paused"],
      reopened: ["closed"],
      deleted: ["draft", "live", "paused", "closed"],
    };
    if (!allowed[action].includes(d.state)) return { ok: false, code: "invalid_state", message: d.state === "draft" ? "Make this mandate live first." : `This mandate is already ${d.state}.` };
    this.#backend.insertLifecycle({ id: `llc_${randomUUID()}`, mandateId, kind: action, createdAt: this.#now().toISOString() });
    return { ok: true, value: this.get(mandateId)! };
  }

  get(mandateId: string): LibraryDetail | null {
    const m = this.#backend.getMandate(mandateId);
    if (!m) return null;
    const versions = this.#backend.listVersions(mandateId);
    const events = this.#backend.listEvents(mandateId);
    const latestSeq = versions.at(-1)?.seq ?? 0;
    const view = versions.map((v): LibraryVersion => {
      const confirmed = events.find((e) => e.kind === "confirmed" && e.versionId === v.id);
      const discarded = events.some((e) => e.kind === "discarded" && e.versionId === v.id);
      const status: VersionStatus = confirmed ? "confirmed" : discarded ? "discarded" : v.seq === latestSeq ? "draft" : "superseded";
      return { versionId: v.id, seq: v.seq, origin: v.origin, status, revision: confirmed?.revision ?? null, createdAt: v.createdAt, draftHash: v.draftHash };
    });
    const lastConfirmed = events.filter((e) => e.kind === "confirmed").sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0)).at(-1);
    const latest = versions.at(-1);
    const latestView = latest ? view.at(-1)! : null;
    const lifecycle = this.#backend.listLifecycle(mandateId);
    const deleted = lifecycle.some((e) => e.kind === "deleted");
    const last = lifecycle.filter((e) => e.kind !== "deleted").at(-1)?.kind;
    const state: MandateState = !lastConfirmed ? "draft" : last === "paused" ? "paused" : last === "closed" ? "closed" : "live";
    return {
      mandateId: m.id,
      caseId: m.caseId,
      // The title follows the latest wording, so a renamed mandate shows its new name.
      title: latest?.input.title || m.title,
      state,
      deleted,
      createdAt: m.createdAt,
      input: latest?.input ?? { title: m.title, principalRole: "", counterpartyRole: "", publicText: "", privateText: "" },
      versions: view,
      latest: latest && latestView ? { versionId: latest.id, status: latestView.status, draft: latest.draft, draftHash: latest.draftHash, readiness: readiness(latest.draft), blockers: blockers(latest.draft) } : null,
      active: lastConfirmed && lastConfirmed.confirmed ? { revision: lastConfirmed.revision!, versionId: lastConfirmed.versionId, confirmedAt: lastConfirmed.createdAt, mandate: lastConfirmed.confirmed } : null,
    };
  }

  /** The confirmed revision sessions should use now. Unconfirmed drafts never appear here. */
  active(mandateId: string): { revision: number; mandate: ConfirmedMandate } | null {
    const d = this.get(mandateId);
    return d?.active ? { revision: d.active.revision, mandate: d.active.mandate } : null;
  }

  /** Maps plain-language input into a new mandate with one draft version. A failed mapping saves nothing. */
  async create(input: LibraryInput): Promise<LibraryResult<LibraryDetail>> {
    const cleaned = clean(input);
    if (!cleaned.ok) return cleaned;
    const mandateId = `man_${randomUUID()}`;
    const caseId = slug(cleaned.value.title) || "case";
    const mapped = await this.#map(caseId, cleaned.value);
    if (!mapped.ok) return mapped;
    const at = this.#now().toISOString();
    this.#backend.transaction(() => {
      this.#backend.insertMandate({ id: mandateId, caseId, title: cleaned.value.title, createdAt: at });
      this.#backend.insertVersion(version(mandateId, 1, at, "text", cleaned.value, [], null, mapped.value));
    });
    return { ok: true, value: this.get(mandateId)! };
  }

  /** Maps edited text into the next draft version. The active revision is unchanged until confirmed. */
  async remap(mandateId: string, input: LibraryInput): Promise<LibraryResult<LibraryDetail>> {
    const m = this.#backend.getMandate(mandateId);
    if (!m) return { ok: false, code: "not_found", message: "That mandate does not exist." };
    const cleaned = clean(input);
    if (!cleaned.ok) return cleaned;
    const mapped = await this.#map(m.caseId, cleaned.value);
    if (!mapped.ok) return mapped;
    const versions = this.#backend.listVersions(mandateId);
    this.#backend.insertVersion(version(mandateId, (versions.at(-1)?.seq ?? 0) + 1, this.#now().toISOString(), "text", cleaned.value, [], versions.at(-1)?.id ?? null, mapped.value));
    return { ok: true, value: this.get(mandateId)! };
  }

  /**
   * Applies the principal's direct edits to the latest draft as a new version. Each edited value gets
   * a principal-authored source that quotes it, so it stays traceable; the result is validated again.
   */
  correct(mandateId: string, input: { versionId: string; corrections: Correction[] }): LibraryResult<LibraryDetail> {
    const versions = this.#backend.listVersions(mandateId);
    const base = versions.at(-1);
    if (!base || base.id !== input.versionId) return { ok: false, code: "stale_draft", message: "The draft changed since you opened it. Review the latest version." };
    if (input.corrections.length === 0 || input.corrections.length > 50) return { ok: false, code: "invalid_corrections", message: "Make between 1 and 50 corrections." };
    const applied = applyCorrections(base.draft, input.corrections, base.seq + 1);
    if (!applied.ok) return applied;
    const checked = validateDraft(applied.value);
    if (!checked.ok) return { ok: false, code: "invalid_draft", message: "The corrected draft is not valid. Nothing was saved.", errors: checked.errors };
    this.#backend.insertVersion(version(mandateId, base.seq + 1, this.#now().toISOString(), "correction", base.input, input.corrections, base.id, checked.draft));
    return { ok: true, value: this.get(mandateId)! };
  }

  /** Only the principal's control calls this, for the exact version and content the principal reviewed. */
  confirm(mandateId: string, input: { versionId: string; draftHash: string; acknowledgedIssueIds: string[] }): LibraryResult<{ detail: LibraryDetail; revision: number; mandate: ConfirmedMandate }> {
    const detail = this.get(mandateId);
    if (!detail || !detail.latest) return { ok: false, code: "not_found", message: "That mandate does not exist." };
    if (detail.latest.versionId !== input.versionId || detail.latest.status !== "draft") return { ok: false, code: "stale_draft", message: "This draft is not the latest open draft. Review the latest version before confirming." };
    if (detail.latest.draftHash !== input.draftHash) return { ok: false, code: "changed_draft", message: "The draft changed after you reviewed it. Review it again before confirming." };
    if (detail.latest.blockers.length > 0) return { ok: false, code: "blocked", message: detail.latest.blockers.join(" ") };
    const checked = validateDraft(detail.latest.draft);
    if (!checked.ok) return { ok: false, code: "invalid_draft", message: "The draft is not valid.", errors: checked.errors };
    const principal = checked.draft.parties.find((p) => p.isPrincipal)!;
    const confirmed = confirmMandate(checked.draft, { confirmedBy: principal.id, acknowledgedIssueIds: input.acknowledgedIssueIds, at: this.#now() });
    if (!confirmed.ok) return { ok: false, code: "not_confirmed", message: "Acknowledge every open issue before confirming.", errors: confirmed.errors };
    const revision = (detail.active?.revision ?? 0) + 1;
    try {
      this.#backend.insertEvent({ id: `lev_${randomUUID()}`, mandateId, versionId: input.versionId, kind: "confirmed", revision, createdAt: this.#now().toISOString(), confirmed: confirmed.mandate });
    } catch {
      return { ok: false, code: "write_failed", message: "The confirmation could not be saved. The mandate is still unconfirmed." };
    }
    return { ok: true, value: { detail: this.get(mandateId)!, revision, mandate: confirmed.mandate } };
  }

  /**
   * Saves an already-confirmed mandate (for example a prepared case file) as revision 1 of a
   * library mandate with a fixed ID. Idempotent: if that ID exists, nothing changes. The confirmed
   * content is stored exactly as given; nothing is re-mapped or inferred.
   */
  importConfirmed(input: { mandateId: string; title: string; input: LibraryInput; mandate: ConfirmedMandate }): LibraryDetail {
    const existing = this.get(input.mandateId);
    if (existing) return existing;
    const at = this.#now().toISOString();
    const draft = { ...structuredClone(input.mandate), approval: { status: "unapproved" as const } } as unknown as MandateDraft;
    const row = version(input.mandateId, 1, at, "text", input.input, [], null, draft);
    this.#backend.transaction(() => {
      this.#backend.insertMandate({ id: input.mandateId, caseId: input.mandate.caseId, title: input.title, createdAt: at });
      this.#backend.insertVersion(row);
      this.#backend.insertEvent({ id: `lev_${randomUUID()}`, mandateId: input.mandateId, versionId: row.id, kind: "confirmed", revision: 1, createdAt: at, confirmed: input.mandate });
    });
    return this.get(input.mandateId)!;
  }

  discard(mandateId: string, versionId: string): LibraryResult<LibraryDetail> {
    const detail = this.get(mandateId);
    if (!detail?.latest || detail.latest.versionId !== versionId || detail.latest.status !== "draft") return { ok: false, code: "stale_draft", message: "Only the latest open draft can be discarded." };
    this.#backend.insertEvent({ id: `lev_${randomUUID()}`, mandateId, versionId, kind: "discarded", revision: null, createdAt: this.#now().toISOString(), confirmed: null });
    return { ok: true, value: this.get(mandateId)! };
  }

  async #map(caseId: string, input: LibraryInput): Promise<LibraryResult<MandateDraft>> {
    const principal = { id: "principal", role: input.principalRole, name: null, isPrincipal: true };
    const counterparty = { id: "counterparty", role: input.counterpartyRole, name: null, isPrincipal: false };
    const sources = [
      { id: "public-facts", authorPartyId: principal.id, disclosure: "public" as const, format: "unspecified" as const, label: "Public facts", text: input.publicText },
      ...(input.privateText ? [{ id: "private-instructions", authorPartyId: principal.id, disclosure: "private" as const, format: "unspecified" as const, label: "Private instructions", text: input.privateText }] : []),
    ];
    const mapped = await mapToDraft({ caseId, parties: [principal, counterparty], sources }, { llm: this.#mappingLlm });
    if (!mapped.ok) return { ok: false, code: mapped.error.code, message: mappingMessage(mapped.error) };
    return { ok: true, value: withPrincipalSide(mapped.draft, input.principalSide ?? null) };
  }
}

/**
 * Whether the principal receives or pays: as stated on the mandate, else read from the principal's own
 * unconditional limit on an amount (a minimum receives, a maximum pays). Null when neither says.
 */
export function principalSideOf(m: Pick<MandateDraft, "parties" | "limits"> & { principalSide?: PrincipalSide | null } | null): PrincipalSide | null {
  if (!m) return null;
  if (m.principalSide) return m.principalSide;
  const principal = m.parties.find((p) => p.isPrincipal);
  const limit = m.limits.find((l) => l.partyId === principal?.id && l.conditionIds.length === 0 && (l.kind === "minimum" || l.kind === "maximum") && (l.value?.type === "money" || l.value?.type === "quantity"));
  return limit ? (limit.kind === "minimum" ? "receives" : "pays") : null;
}

/**
 * Puts the principal's side on a mapped draft. A limit that points the other way (a minimum for a
 * principal who pays, a maximum for one who receives) is a conflict to resolve before confirming.
 */
export function withPrincipalSide(draft: MandateDraft, side: PrincipalSide | null): MandateDraft {
  if (!side) return { ...draft, principalSide: null };
  const principal = draft.parties.find((p) => p.isPrincipal);
  const wrong = side === "pays" ? "minimum" : "maximum";
  const contradicting = draft.limits.filter((l) => l.partyId === principal?.id && l.kind === wrong && (l.value?.type === "money" || l.value?.type === "quantity"));
  const issues = contradicting.length === 0 ? draft.issues : [
    ...draft.issues,
    {
      id: "issue_principal_side",
      kind: "conflict" as const,
      message: side === "pays"
        ? `This says you are paying, but the instructions set a lowest amount you would accept, which only makes sense when you are being paid. Say which it is: are you paying, or being paid?`
        : `This says you are being paid, but the instructions set a highest amount you would pay, which only makes sense when you are paying. Say which it is: are you paying, or being paid?`,
      relatedIds: contradicting.map((l) => l.id),
      sourceRefs: contradicting.flatMap((l) => l.sourceRefs).slice(0, 20),
    },
  ];
  return { ...draft, principalSide: side, issues };
}

/** What must be fixed (not just acknowledged) before a draft can be confirmed. */
export function blockers(draft: MandateDraft): string[] {
  const out: string[] = [];
  for (const i of draft.issues) if (i.kind === "conflict") out.push(`Resolve the conflict first: ${i.message}`);
  for (const u of readiness(draft).unresolved) if (!out.some((x) => x.includes(u.reason))) out.push(`Clarify ${u.name}: ${u.reason}`);
  return out;
}

function mappingMessage(error: MappingError): string {
  return error.code === "invalid_request" ? "Some of the input is missing or too long." : "The instructions could not be turned into a draft. Your text is unchanged; try again or simplify it.";
}

function clean(input: LibraryInput): LibraryResult<LibraryInput> {
  const value = {
    principalSide: input.principalSide === "receives" || input.principalSide === "pays" ? input.principalSide : null,
    title: (input.title ?? "").trim().slice(0, 120),
    principalRole: (input.principalRole ?? "").trim().slice(0, 60),
    counterpartyRole: (input.counterpartyRole ?? "").trim().slice(0, 60),
    publicText: (input.publicText ?? "").trim(),
    privateText: (input.privateText ?? "").trim(),
  };
  if (!value.title) return { ok: false, code: "invalid_input", message: "Give the mandate a short name." };
  if (!value.principalRole || !value.counterpartyRole) return { ok: false, code: "invalid_input", message: "Say who you are and who you are negotiating with." };
  if (!value.publicText) return { ok: false, code: "invalid_input", message: "Describe what is being negotiated (the public facts)." };
  if (value.publicText.length > 10_000 || value.privateText.length > 10_000) return { ok: false, code: "invalid_input", message: "Each text can be up to 10,000 characters." };
  return { ok: true, value };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function hashDraft(draft: MandateDraft): string {
  return createHash("sha256").update(JSON.stringify(draft)).digest("hex");
}

function version(mandateId: string, seq: number, at: string, origin: VersionRow["origin"], input: LibraryInput, corrections: Correction[], basedOn: string | null, draft: MandateDraft): VersionRow {
  return { id: `mver_${randomUUID()}`, mandateId, seq, createdAt: at, origin, input, corrections, basedOnVersionId: basedOn, draft, draftHash: hashDraft(draft) };
}

type ValuedCollection = "positions" | "limits" | "targets" | "preferences" | "conditions";
const VALUED: ValuedCollection[] = ["positions", "limits", "targets", "preferences", "conditions"];
const REMOVABLE = ["positions", "limits", "targets", "preferences", "conditions", "goals", "facts", "alternatives", "permissions"] as const;

function applyCorrections(source: MandateDraft, corrections: Correction[], seq: number): LibraryResult<MandateDraft> {
  const draft = structuredClone(source);
  const principal = draft.parties.find((p) => p.isPrincipal)!;
  const touched = new Set<string>();
  let n = 0;
  for (const c of corrections) {
    if ("remove" in c) {
      let found = false;
      for (const key of REMOVABLE) {
        const list = draft[key] as Array<{ id: string }>;
        const i = list.findIndex((r) => r.id === c.recordId);
        if (i >= 0) {
          list.splice(i, 1);
          found = true;
        }
      }
      if (!found) return { ok: false, code: "invalid_corrections", message: "A correction refers to an item that is not in the draft." };
      touched.add(c.recordId);
      continue;
    }
    if ("mode" in c) {
      const p = draft.permissions.find((x) => x.id === c.recordId);
      if (!p || !PermissionMode.safeParse(c.mode).success) return { ok: false, code: "invalid_corrections", message: "A permission correction is not valid." };
      n += 1;
      const text = `${p.description ?? p.action.replace(/_/g, " ")}: ${MODE_TEXT[c.mode]}`;
      const sourceId = `correction-${seq}-${n}`;
      draft.sources.push({ id: sourceId, authorPartyId: principal.id, disclosure: "private", format: "prose", label: "Correction by the principal", text });
      p.mode = c.mode;
      p.status = "stated";
      p.sourceRefs = [{ sourceId, quote: text }];
      touched.add(c.recordId);
      continue;
    }
    let record: { id: string; termId: string | null; value: Value | null; sourceRefs: Array<{ sourceId: string; quote: string }>; disclosure: "public" | "private"; status: string } | undefined;
    for (const key of VALUED) {
      record = (draft[key] as unknown as Array<NonNullable<typeof record>>).find((r) => r.id === c.recordId);
      if (record) break;
    }
    if (!record || !record.termId) return { ok: false, code: "invalid_corrections", message: "Only values tied to a term can be edited directly. Edit the text instead." };
    const term = draft.terms.find((t) => t.id === record!.termId);
    if (!term) return { ok: false, code: "invalid_corrections", message: "A correction refers to an unknown term." };
    const parsed = parseValue(c.value, term.valueType, term.currency, term.unit);
    if (!parsed) return { ok: false, code: "invalid_corrections", message: `“${c.value}” is not a valid ${term.valueType.replace("_", " ")} for ${term.name}.` };
    n += 1;
    const text = `${term.name}: ${c.value.trim()}`;
    const sourceId = `correction-${seq}-${n}`;
    draft.sources.push({ id: sourceId, authorPartyId: principal.id, disclosure: record.disclosure, format: "prose", label: "Correction by the principal", text });
    record.value = parsed;
    record.status = "stated";
    record.sourceRefs = [{ sourceId, quote: text }];
    touched.add(c.recordId);
  }
  // A conflict the principal has acted on is theirs to have resolved; the validator re-checks it.
  draft.issues = draft.issues.filter((i) => !(i.kind === "conflict" || i.kind === "ambiguous" || i.kind === "missing") || !i.relatedIds.some((id) => touched.has(id)));
  // Issues pointing only at removed records no longer apply.
  const ids = new Set(REMOVABLE.flatMap((k) => (draft[k] as Array<{ id: string }>).map((r) => r.id)));
  draft.issues = draft.issues.map((i) => ({ ...i, relatedIds: i.relatedIds.filter((id) => ids.has(id) || draft.terms.some((t) => t.id === id) || draft.sources.some((s) => s.id === id)) }));
  return { ok: true, value: draft };
}

const MODE_TEXT: Record<Mode, string> = {
  autonomous: "allowed without asking",
  requires_approval: "ask me first",
  prohibited: "not allowed",
};

function parseValue(text: string, type: string, currency: string | null, unit: string | null): Value | null {
  const t = text.trim();
  if (!t) return null;
  const number = Number(t.replace(/[^\d.]/g, ""));
  switch (type) {
    case "money":
      return Number.isFinite(number) && /\d/.test(t) ? { type: "money", amount: number, currency } : null;
    case "quantity":
      return Number.isFinite(number) && /\d/.test(t) ? { type: "quantity", amount: number, unit } : null;
    case "boolean":
      if (/^(yes|true|included|y)$/i.test(t)) return { type: "boolean", value: true };
      if (/^(no|false|not included|n)$/i.test(t)) return { type: "boolean", value: false };
      return null;
    case "date_text":
      return { type: "date_text", value: t.slice(0, 200) };
    default:
      return { type: "text", value: t.slice(0, 500) };
  }
}

// ---------------------------------------------------------------- SQLite (local development)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS library_mandates (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS library_versions (
  id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES library_mandates(id), seq INTEGER NOT NULL,
  created_at TEXT NOT NULL, body TEXT NOT NULL, UNIQUE (mandate_id, seq)
);
CREATE TABLE IF NOT EXISTS library_events (
  id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES library_mandates(id), version_id TEXT NOT NULL REFERENCES library_versions(id),
  kind TEXT NOT NULL CHECK (kind IN ('confirmed', 'discarded')), revision INTEGER, created_at TEXT NOT NULL, body TEXT NOT NULL,
  UNIQUE (mandate_id, revision), UNIQUE (version_id, kind)
);
CREATE TABLE IF NOT EXISTS library_lifecycle (
  id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES library_mandates(id),
  kind TEXT NOT NULL CHECK (kind IN ('paused', 'resumed', 'closed', 'reopened', 'deleted')), created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS library_lifecycle_no_update BEFORE UPDATE ON library_lifecycle BEGIN SELECT RAISE(ABORT, 'lifecycle events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS library_versions_no_update BEFORE UPDATE ON library_versions BEGIN SELECT RAISE(ABORT, 'versions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS library_events_no_update BEFORE UPDATE ON library_events BEGIN SELECT RAISE(ABORT, 'library events are append-only'); END;
`;

export class SqliteLibraryBackend implements LibraryBackend {
  readonly #db: DatabaseSync;
  #depth = 0;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.#db.exec("BEGIN IMMEDIATE");
    this.#depth += 1;
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  insertMandate(row: MandateRow): void {
    this.#db.prepare("INSERT INTO library_mandates (id, case_id, title, created_at) VALUES (?, ?, ?, ?)").run(row.id, row.caseId, row.title, row.createdAt);
  }
  listMandates(): MandateRow[] {
    return (this.#db.prepare("SELECT * FROM library_mandates ORDER BY created_at, id").all() as Array<Record<string, string>>).map((r) => ({ id: r.id!, caseId: r.case_id!, title: r.title!, createdAt: r.created_at! }));
  }
  getMandate(id: string): MandateRow | null {
    const r = this.#db.prepare("SELECT * FROM library_mandates WHERE id = ?").get(id) as Record<string, string> | undefined;
    return r ? { id: r.id!, caseId: r.case_id!, title: r.title!, createdAt: r.created_at! } : null;
  }
  insertVersion(row: VersionRow): void {
    this.#db.prepare("INSERT INTO library_versions (id, mandate_id, seq, created_at, body) VALUES (?, ?, ?, ?, ?)").run(row.id, row.mandateId, row.seq, row.createdAt, JSON.stringify(row));
  }
  listVersions(mandateId: string): VersionRow[] {
    return (this.#db.prepare("SELECT body FROM library_versions WHERE mandate_id = ? ORDER BY seq").all(mandateId) as Array<{ body: string }>).map((r) => JSON.parse(r.body) as VersionRow);
  }
  insertEvent(row: LibraryEventRow): void {
    this.#db.prepare("INSERT INTO library_events (id, mandate_id, version_id, kind, revision, created_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)").run(row.id, row.mandateId, row.versionId, row.kind, row.revision, row.createdAt, JSON.stringify(row));
  }
  insertLifecycle(row: LifecycleRow): void {
    this.#db.prepare("INSERT INTO library_lifecycle (id, mandate_id, kind, created_at) VALUES (?, ?, ?, ?)").run(row.id, row.mandateId, row.kind, row.createdAt);
  }
  listLifecycle(mandateId: string): LifecycleRow[] {
    return (this.#db.prepare("SELECT * FROM library_lifecycle WHERE mandate_id = ? ORDER BY created_at, rowid").all(mandateId) as Array<Record<string, string>>).map((r) => ({ id: r.id!, mandateId: r.mandate_id!, kind: r.kind as LifecycleAction, createdAt: r.created_at! }));
  }
  listEvents(mandateId: string): LibraryEventRow[] {
    return (this.#db.prepare("SELECT body FROM library_events WHERE mandate_id = ? ORDER BY created_at, id").all(mandateId) as Array<{ body: string }>).map((r) => JSON.parse(r.body) as LibraryEventRow);
  }
  close(): void {
    this.#db.close();
  }
}
