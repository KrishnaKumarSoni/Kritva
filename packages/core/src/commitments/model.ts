/**
 * Epic 7: commitments. Every offer, its versions and its status, derived only from the shared
 * record (no second offers store). Statuses are computed from events, so replaying an event
 * cannot change a status twice.
 *
 * Offer status:
 * - enquiry / interest: the counterparty asked about terms without committing to them.
 * - proposed: a counterparty offer that is open.
 * - pending_clarification: material terms or the counterparty's own conditions are unresolved.
 * - internal: the agent prepared it but it was never delivered (blocked, or never sent).
 * - awaiting_approval: put to the principal; not offered or not agreed yet.
 * - delivered: the counterparty received it and it is open.
 * - accepted / agreed / rejected: as recorded.
 * - superseded: a later version from the same party replaced it. History is kept.
 * - withdrawn: the negotiation ended without agreement while it was open.
 * - expired: it no longer passes a check under the mandate in force.
 */
import type { OfferTerm, PayloadOf, RecordedEvent } from "../record/events.ts";
import type { SessionContext } from "../record/rules.ts";
import type { Value } from "../schema/records.ts";

export type OfferStatus =
  | "enquiry"
  | "interest"
  | "proposed"
  | "pending_clarification"
  | "internal"
  | "awaiting_approval"
  | "delivered"
  | "accepted"
  | "agreed"
  | "rejected"
  | "superseded"
  | "withdrawn"
  | "expired";

export interface OfferRecord {
  offerId: string;
  party: "principal" | "counterparty";
  kind: "offer" | "enquiry" | "interest" | "counter" | "final_terms";
  terms: OfferTerm[];
  termsHash: string;
  sourceMessageId: string | null;
  mandateRevision: number;
  previousOfferId: string | null;
  version: number;
  conditions: string[];
  status: OfferStatus;
  blocked: boolean;
  approval: "none" | "requested" | "approved" | "rejected";
  at: string;
}

export type SessionOutcome = "negotiating" | "paused" | "pending_approval" | "agreement" | "no_agreement";

export interface Obligation {
  description: string;
  termId: string | null;
  status: "pending";
}

export interface CommitmentsModel {
  offers: OfferRecord[];
  currentCounterpartyOffer: OfferRecord | null;
  currentPrincipalOffer: OfferRecord | null;
  outcome: SessionOutcome;
  /** Who paused or ended, why, and what was left open (from the recorded status change). */
  stopped: { by: string | null; reason: string; unresolved: string[] } | null;
  agreement: { agreementId: string; terms: OfferTerm[]; approvalId: string | null; obligations: Obligation[] } | null;
}

export function projectCommitments(ctx: SessionContext, options: { negotiableTermId: string | null; termName: (id: string) => string; format: (v: Value) => string }): CommitmentsModel {
  const offers: OfferRecord[] = [];
  const byId = new Map<string, OfferRecord>();
  let revision = 1;
  let agreement: CommitmentsModel["agreement"] = null;
  let stopped: CommitmentsModel["stopped"] = null;

  for (const e of ctx.events as RecordedEvent[]) {
    switch (e.type) {
      case "session_started":
      case "mandate_revised":
        revision = (e.payload as { mandateRevision: number }).mandateRevision;
        break;
      case "offer_extracted": {
        const p = ctx.effective.get(e.id) as PayloadOf<"offer_extracted">;
        const prev = p.previousOfferId ? byId.get(p.previousOfferId) : undefined;
        const record: OfferRecord = {
          offerId: e.id,
          party: "counterparty",
          kind: p.kind ?? "offer",
          terms: p.terms,
          termsHash: p.termsHash,
          sourceMessageId: p.sourceMessageId,
          mandateRevision: revision,
          previousOfferId: p.previousOfferId ?? null,
          version: prev ? prev.version + 1 : 1,
          conditions: p.conditions ?? [],
          status: "proposed",
          blocked: false,
          approval: "none",
          at: e.recordedAt,
        };
        offers.push(record);
        byId.set(e.id, record);
        break;
      }
      case "offer_proposed": {
        const p = e.payload as PayloadOf<"offer_proposed">;
        const prev = p.previousOfferId ? byId.get(p.previousOfferId) : undefined;
        const record: OfferRecord = {
          offerId: e.id,
          party: "principal",
          kind: p.basis,
          terms: p.terms,
          termsHash: p.termsHash,
          sourceMessageId: null,
          mandateRevision: revision,
          previousOfferId: p.previousOfferId ?? null,
          version: prev ? prev.version + 1 : 1,
          conditions: [],
          status: "internal",
          blocked: false,
          approval: "none",
          at: e.recordedAt,
        };
        offers.push(record);
        byId.set(e.id, record);
        break;
      }
      case "action_checked": {
        const p = e.payload as PayloadOf<"action_checked">;
        // Blocked or held back by the terms gate: never sent.
        if (p.offerId && p.phase === "terms" && p.decision !== "allow") {
          const o = byId.get(p.offerId);
          if (o) o.blocked = true;
        }
        break;
      }
      case "approval_requested": {
        const o = byId.get((e.payload as PayloadOf<"approval_requested">).offerId);
        if (o) o.approval = "requested";
        break;
      }
      case "approval_responded": {
        const p = e.payload as PayloadOf<"approval_responded">;
        const o = byId.get(p.offerId);
        if (o) o.approval = p.decision;
        break;
      }
      case "agreement_recorded": {
        const p = e.payload as PayloadOf<"agreement_recorded">;
        agreement = { agreementId: e.id, terms: p.terms, approvalId: p.approvalId, obligations: obligationsFor(p.terms, options) };
        break;
      }
      case "status_changed": {
        const p = e.payload as PayloadOf<"status_changed">;
        if (p.to === "paused" || p.to === "no_agreement" || p.to === "ended") stopped = { by: p.requestedBy ?? null, reason: p.reason, unresolved: p.unresolved ?? [] };
        else if (p.from === "paused") stopped = null;
        break;
      }
    }
  }

  // Statuses, derived from the full history.
  const accepted = new Set(ctx.events.filter((e) => e.type === "acceptance_recorded").map((e) => (e.payload as PayloadOf<"acceptance_recorded">).offerId));
  const agreedOffer = agreement ? (ctx.events.find((e) => e.type === "agreement_recorded")!.payload as PayloadOf<"agreement_recorded">).offerId : null;
  const lastOf = (party: OfferRecord["party"], filter: (o: OfferRecord) => boolean = () => true) => [...offers].reverse().find((o) => o.party === party && filter(o)) ?? null;
  const latestCounterparty = lastOf("counterparty");
  const latestDelivered = lastOf("principal", (o) => ctx.isCommunicated(o.offerId));
  const checks = latestChecks(ctx);

  const ended = ctx.status === "no_agreement" || ctx.status === "ended";
  const agreedTerms = agreement?.terms ?? [];
  const withinAgreement = (o: OfferRecord) => o.terms.every((t) => agreedTerms.some((a) => a.termId === t.termId && JSON.stringify(a.value) === JSON.stringify(t.value)));
  for (const o of offers) {
    const check = checks.get(o.offerId);
    if (o.party === "counterparty") {
      if (o.offerId !== latestCounterparty?.offerId) o.status = "superseded";
      else if (agreement) o.status = withinAgreement(o) ? "agreed" : "superseded";
      else if (ended) o.status = stopped?.by === "counterparty" ? "withdrawn" : "rejected";
      else if (o.kind === "enquiry" || o.kind === "interest") o.status = o.kind;
      else if (o.conditions.length > 0 || check?.result === "needs_clarification") o.status = "pending_clarification";
      else o.status = "proposed";
      continue;
    }
    const delivered = ctx.isCommunicated(o.offerId);
    if (o.offerId === agreedOffer) o.status = "agreed";
    else if (o.approval === "rejected") o.status = "rejected";
    else if (o.approval === "requested") o.status = "awaiting_approval";
    else if (!delivered) o.status = "internal";
    else if (latestDelivered && o.offerId !== latestDelivered.offerId) o.status = "superseded";
    else if (accepted.has(o.offerId)) o.status = "accepted";
    else if (ended) o.status = "withdrawn";
    else if (check && check.mandateRevision !== ctx.mandateRevision) o.status = "expired";
    else o.status = "delivered";
  }

  const outcome: SessionOutcome = agreement
    ? "agreement"
    : ctx.status === "paused"
      ? "paused"
      : ctx.status === "no_agreement" || ctx.status === "ended"
        ? "no_agreement"
        : ctx.status === "awaiting_approval"
          ? "pending_approval"
          : "negotiating";

  return {
    offers,
    currentCounterpartyOffer: latestCounterparty,
    currentPrincipalOffer: latestDelivered,
    outcome,
    stopped: outcome === "paused" || outcome === "no_agreement" ? stopped : null,
    agreement,
  };
}

/**
 * What still has to happen after an agreement: paying the agreed amount, and carrying out each
 * agreed logistics term. Recorded as pending; nothing here marks them done.
 */
function obligationsFor(terms: OfferTerm[], options: { negotiableTermId: string | null; termName: (id: string) => string; format: (v: Value) => string }): Obligation[] {
  const out: Obligation[] = [];
  // Payment first, then each logistics term.
  const ordered = [...terms].sort((a, b) => Number(b.value.type === "money") - Number(a.value.type === "money"));
  for (const t of ordered) {
    if (t.value.type === "money") out.push({ description: `Payment of ${options.format(t.value)}`, termId: t.termId, status: "pending" });
    else if (t.value.type === "boolean") continue;
    else out.push({ description: `${capitalize(options.termName(t.termId))}: ${options.format(t.value)}`, termId: t.termId, status: "pending" });
  }
  return out;
}

function latestChecks(ctx: SessionContext): Map<string, { result: string; mandateRevision: number }> {
  const out = new Map<string, { result: string; mandateRevision: number }>();
  for (const e of ctx.events) {
    if (e.type !== "proposal_checked") continue;
    const p = e.payload as PayloadOf<"proposal_checked">;
    out.set(p.offerId, { result: p.result, mandateRevision: p.mandateRevision });
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** For a session that ended without agreement: each side's last offer and the main difference. Never a hidden limit. */
export function noAgreementSummary(model: CommitmentsModel, options: { negotiableTermId: string | null; termName: (id: string) => string; format: (v: Value) => string }) {
  const theirs = model.currentCounterpartyOffer;
  const ours = model.currentPrincipalOffer;
  const differences: string[] = [];
  if (theirs && ours) {
    for (const t of ours.terms) {
      const other = theirs.terms.find((x) => x.termId === t.termId);
      if (other && JSON.stringify(other.value) !== JSON.stringify(t.value)) {
        differences.push(`${options.termName(t.termId)}: ours ${options.format(t.value)}, theirs ${options.format(other.value)}`);
      }
    }
  }
  return {
    lastPrincipalOffer: ours ? ours.terms.map((t) => `${options.termName(t.termId)}: ${options.format(t.value)}`) : [],
    lastCounterpartyOffer: theirs ? theirs.terms.map((t) => `${options.termName(t.termId)}: ${options.format(t.value)}`) : [],
    differences,
  };
}
