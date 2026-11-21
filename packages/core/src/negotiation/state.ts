/**
 * The negotiation's current position, derived only from recorded events. Strategy, the
 * console and the outcome card all read this projection; none keep their own history.
 */
import type { OfferTerm, PayloadOf, RecordedEvent, SessionStatus } from "../record/events.ts";
import type { SessionContext } from "../record/rules.ts";
import { buildDealSpace, type DealSpace } from "../dealspace/catalog.ts";
import type { Value } from "../schema/records.ts";
import { readMandate, type MandateView } from "./mandate-view.ts";

export interface StatedOffer {
  offerId: string;
  basis: "counter" | "final_terms";
  terms: OfferTerm[];
  termsHash: string;
  communicated: boolean;
}

export interface Outcome {
  kind: "in_progress" | "pending_approval" | "agreement" | "no_agreement";
  terms: OfferTerm[] | null;
  termsHash: string | null;
  agreementId: string | null;
  approvalRequestId: string | null;
}

export interface NegotiationState {
  sessionId: string;
  status: SessionStatus;
  mandateRevision: number;
  view: MandateView;
  /** The agent's latest stated value on the negotiable term (starts at the opening value). */
  currentAsk: number | null;
  /** Every value the agent has put forward on the negotiable term, oldest first. */
  askHistory: number[];
  /** The counterparty's offers on the negotiable term, oldest first. */
  counterpartyAmounts: number[];
  countersMade: number;
  /** The agent has already offered to split the difference (guidance allows it once). */
  splitUsed: boolean;
  /** Counterparty offers on the negotiable term since the agent's ask last changed, this one included. */
  offersSinceAsk: number;
  lastProposed: StatedOffer | null;
  /** The latest complete terms the agent stated for confirmation. */
  pendingFinal: StatedOffer | null;
  pendingApproval: { requestId: string; offerId: string; termsHash: string; acceptanceId: string | null; purpose: "acceptance" | "exception"; breachedRuleIds: string[]; requestedAction: string } | null;
  /** Every principal decision on an approval request, with the exact terms and revision it covers. */
  approvals: Array<{ requestId: string; responseId: string; offerId: string; termsHash: string; mandateRevision: number; purpose: "acceptance" | "exception"; breachedRuleIds: string[]; decision: "approved" | "rejected" }>;
  /** The status to return to when a pause ends. */
  statusBeforePause: SessionStatus | null;
  acceptances: Array<{ id: string; offerId: string; termsHash: string }>;
  outcome: Outcome;
  /** Deal space of the mandate revision in force. */
  space: DealSpace;
  /** The counterparty's latest value per term (their requests, not the principal's terms). */
  counterpartyTerms: Map<string, Value>;
  /** Terms the counterparty asked about that the mandate does not cover. */
  requestedTerms: Array<{ id: string; name: string; value: Value | null }>;
  /** Latest deal-space check per offer, with the revision it was made against. */
  checks: Map<string, { eventId: string; result: "fits" | "conflicts" | "needs_clarification"; mandateRevision: number; termsHash: string; checkedTerms: OfferTerm[] }>;
  checkFindings: Map<string, PayloadOf<"proposal_checked">["findings"]>;
  /** The most recent check of a counterparty proposal. */
  lastCounterpartyCheck: { offerId: string; checkedTerms: OfferTerm[]; result: "fits" | "conflicts" | "needs_clarification"; findings: PayloadOf<"proposal_checked">["findings"] } | null;
}

/** The principal's approval of these exact terms under the mandate revision in force, if any. */
export function approvedFor(state: NegotiationState, termsHash: string): NegotiationState["approvals"][number] | null {
  return state.approvals.findLast((a) => a.decision === "approved" && a.termsHash === termsHash && a.mandateRevision === state.mandateRevision) ?? null;
}

/**
 * True when these terms may be used now: they pass the deal-space check, or the only conflicts
 * are rules the principal approved an exception to for exactly these terms and this revision.
 */
export function clearedNow(state: NegotiationState, offerId: string, termsHash: string): boolean {
  if (fitsNow(state, offerId, termsHash)) return true;
  const check = state.checks.get(offerId);
  const approval = approvedFor(state, termsHash);
  if (!check || !approval || approval.purpose !== "exception" || check.mandateRevision !== state.mandateRevision || check.termsHash !== termsHash) return false;
  const findings = state.checkFindings.get(offerId) ?? [];
  return findings.every((f) => f.status === "fits" || (f.status === "conflict" && f.ruleId !== null && approval.breachedRuleIds.includes(f.ruleId)));
}

/** True only for a passing check made against the mandate revision now in force. */
export function fitsNow(state: NegotiationState, offerId: string, termsHash: string): boolean {
  const c = state.checks.get(offerId);
  return Boolean(c && c.result === "fits" && c.mandateRevision === state.mandateRevision && c.termsHash === termsHash);
}

export function projectState(ctx: SessionContext): NegotiationState {
  if (!ctx.mandate) throw new Error("Session has no mandate.");
  const view = readMandate(ctx.mandate);
  const n = view.negotiable;
  const sessionId = ctx.events[0]?.sessionId ?? "";

  let currentAsk: number | null = n?.opening ?? null;
  const askHistory: number[] = currentAsk === null ? [] : [currentAsk];
  const counterpartyAmounts: number[] = [];
  let countersMade = 0;
  let splitUsed = false;
  let offersSinceAsk = 0;
  let lastProposed: StatedOffer | null = null;
  let pendingFinal: StatedOffer | null = null;
  let pendingApproval: NegotiationState["pendingApproval"] = null;
  const acceptances: NegotiationState["acceptances"] = [];
  let agreement: { id: string; payload: PayloadOf<"agreement_recorded"> } | null = null;
  const answered = new Set<string>();
  const counterpartyTerms = new Map<string, Value>();
  const requestedTerms: NegotiationState["requestedTerms"] = [];
  const checks: NegotiationState["checks"] = new Map();
  const checkFindings: NegotiationState["checkFindings"] = new Map();
  const approvals: NegotiationState["approvals"] = [];
  const requests = new Map<string, PayloadOf<"approval_requested">>();
  let statusBeforePause: SessionStatus | null = null;
  let lastCounterpartyCheck: NegotiationState["lastCounterpartyCheck"] = null;

  const amountOf = (terms: OfferTerm[]) => {
    const t = n ? terms.find((x) => x.termId === n.termId) : undefined;
    return t && "amount" in t.value ? (t.value.amount as number) : null;
  };

  // Offers the terms gate blocked were never sent; they stay in the record as internal offers only.
  const blocked = new Set<string>();
  for (const e of ctx.events) {
    if (e.type !== "action_checked") continue;
    const c = e.payload as PayloadOf<"action_checked">;
    if (c.phase === "terms" && c.decision !== "allow" && c.offerId) blocked.add(c.offerId);
  }

  for (const e of ctx.events as RecordedEvent[]) {
    if (e.type === "offer_proposed" && blocked.has(e.id)) continue;
    switch (e.type) {
      case "term_requested": {
        const p = e.payload as PayloadOf<"term_requested">;
        requestedTerms.push({ id: e.id, name: p.name, value: p.value });
        break;
      }
      case "proposal_checked": {
        const p = e.payload as PayloadOf<"proposal_checked">;
        checks.set(p.offerId, { eventId: e.id, result: p.result, mandateRevision: p.mandateRevision, termsHash: p.termsHash, checkedTerms: p.checkedTerms });
        checkFindings.set(p.offerId, p.findings);
        if (ctx.byId.get(p.offerId)?.type === "offer_extracted") lastCounterpartyCheck = { offerId: p.offerId, checkedTerms: p.checkedTerms, result: p.result, findings: p.findings };
        break;
      }
      case "offer_extracted": {
        const p = ctx.effective.get(e.id) as PayloadOf<"offer_extracted">;
        for (const t of p.terms) counterpartyTerms.set(t.termId, t.value);
        const amount = amountOf(p.terms);
        // A corrected offer was a mistake, not a position: it leaves the offer history.
        if (p.correctsPrevious && counterpartyAmounts.length > 0) counterpartyAmounts.pop();
        if (amount !== null) {
          counterpartyAmounts.push(amount);
          offersSinceAsk += 1;
        }
        break;
      }
      case "offer_proposed": {
        const p = ctx.effective.get(e.id) as PayloadOf<"offer_proposed">;
        lastProposed = { offerId: e.id, basis: p.basis, terms: p.terms, termsHash: p.termsHash, communicated: false };
        const amount = amountOf(p.terms);
        // Only what the counterparty actually received counts as the agent's ask; an exception
        // package waiting for the principal, or a blocked offer, never moved the ask.
        if (amount !== null && amount !== currentAsk && ctx.isCommunicated(e.id)) {
          currentAsk = amount;
          askHistory.push(amount);
          offersSinceAsk = 0;
          if (p.basis === "counter") countersMade += 1;
        }
        if (p.tactic === "split_difference" && ctx.isCommunicated(e.id)) splitUsed = true;
        if (p.basis === "final_terms") pendingFinal = lastProposed;
        break;
      }
      case "acceptance_recorded": {
        const p = e.payload as PayloadOf<"acceptance_recorded">;
        acceptances.push({ id: e.id, offerId: p.offerId, termsHash: p.termsHash });
        break;
      }
      case "approval_requested": {
        const p = e.payload as PayloadOf<"approval_requested">;
        requests.set(e.id, p);
        pendingApproval = {
          requestId: e.id,
          offerId: p.offerId,
          termsHash: p.termsHash,
          acceptanceId: p.acceptanceId,
          purpose: p.purpose ?? "acceptance",
          breachedRuleIds: p.breachedRuleIds ?? [],
          requestedAction: p.requestedAction ?? "",
        };
        break;
      }
      case "approval_responded": {
        const p = e.payload as PayloadOf<"approval_responded">;
        const request = requests.get(p.requestId);
        approvals.push({
          requestId: p.requestId,
          responseId: e.id,
          offerId: p.offerId,
          termsHash: p.termsHash,
          mandateRevision: p.mandateRevision,
          purpose: request?.purpose ?? "acceptance",
          breachedRuleIds: request?.breachedRuleIds ?? [],
          decision: p.decision,
        });
        answered.add(p.requestId);
        if (pendingApproval?.requestId === p.requestId) pendingApproval = null;
        break;
      }
      case "agreement_recorded":
        agreement = { id: e.id, payload: e.payload as PayloadOf<"agreement_recorded"> };
        break;
      case "status_changed": {
        const s = e.payload as PayloadOf<"status_changed">;
        if (s.to === "paused") statusBeforePause = s.from;
        else if (s.from === "paused") statusBeforePause = null;
        // Leaving the approval wait for any reason but a pause supersedes the pending request.
        if (s.to !== "awaiting_approval" && s.to !== "paused") pendingApproval = null;
        break;
      }
    }
  }
  if (lastProposed) lastProposed.communicated = ctx.isCommunicated(lastProposed.offerId);
  if (pendingFinal) pendingFinal.communicated = ctx.isCommunicated(pendingFinal.offerId);
  // Final terms are pending only while they are the latest thing the agent proposed.
  if (pendingFinal && lastProposed && pendingFinal.offerId !== lastProposed.offerId) pendingFinal = null;

  let outcome: Outcome = { kind: "in_progress", terms: null, termsHash: null, agreementId: null, approvalRequestId: null };
  if (agreement) {
    outcome = { kind: "agreement", terms: agreement.payload.terms, termsHash: agreement.payload.termsHash, agreementId: agreement.id, approvalRequestId: null };
  } else if (pendingApproval && pendingApproval.purpose === "acceptance") {
    // An exception request is internal to the principal; to everyone else the negotiation is still open.
    const terms = ctx.offerTerms(pendingApproval.offerId)?.terms ?? null;
    outcome = { kind: "pending_approval", terms, termsHash: pendingApproval.termsHash, agreementId: null, approvalRequestId: pendingApproval.requestId };
  } else if (ctx.status === "no_agreement" || ctx.status === "ended") {
    outcome = { kind: "no_agreement", terms: null, termsHash: null, agreementId: null, approvalRequestId: null };
  }

  return {
    sessionId,
    status: ctx.status,
    mandateRevision: ctx.mandateRevision,
    view,
    currentAsk,
    askHistory,
    counterpartyAmounts,
    countersMade,
    splitUsed,
    offersSinceAsk,
    lastProposed,
    pendingFinal,
    pendingApproval,
    acceptances,
    outcome,
    space: buildDealSpace(ctx.mandate),
    approvals,
    statusBeforePause,
    checkFindings,
    counterpartyTerms,
    requestedTerms,
    checks,
    lastCounterpartyCheck,
  };
}
