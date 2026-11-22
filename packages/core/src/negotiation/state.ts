/**
 * The negotiation's current position, derived only from recorded events. Strategy, the
 * console and the outcome card all read this projection; none keep their own history.
 */
import { findAmounts } from "./reply-check.ts";
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

/** Start with the public listing and overlay only terms the other party has received. */
export function publicDealTerms(state: NegotiationState): OfferTerm[] {
  const terms = new Map(state.view.defaultPackage.map((term) => [term.termId, term]));
  for (const term of state.lastCommunicated?.terms ?? []) {
    if (state.view.terms.has(term.termId)) terms.set(term.termId, term);
  }
  return [...terms.values()];
}

export interface Outcome {
  kind: "in_progress" | "pending_approval" | "agreement" | "no_agreement";
  terms: OfferTerm[] | null;
  termsHash: string | null;
  agreementId: string | null;
  approvalRequestId: string | null;
}

/**
 * Other counterparties' live offers for the same deal (docs/Kritva_Multiple_Counterparties.md). Set
 * by the engine for a session in a deal group; never projected from this session's own record.
 */
export interface Competition {
  /** Live offers within the mandate's limits from other open sessions: the value on the negotiated term and every other term. */
  rivals: Array<{ amount: number; otherTerms: OfferTerm[] }>;
  /** The mandate allows telling this counterparty about one of them. */
  mayCite: boolean;
}

export interface NegotiationState {
  /** Other counterparties' live offers, when the session is in a deal group. */
  competition?: Competition | null;
  sessionId: string;
  status: SessionStatus;
  mandateRevision: number;
  view: MandateView;
  /** The agent's latest stated value on the negotiable term (starts at the opening value). */
  currentAsk: number | null;
  /** The latest terms the counterparty actually received, if an offer was delivered. */
  lastCommunicated: StatedOffer | null;
  /** Every value the agent has put forward on the negotiable term, oldest first. */
  askHistory: number[];
  /** The counterparty's offers on the negotiable term, oldest first. */
  counterpartyAmounts: number[];
  /** Every amount the counterparty wrote or said in its own messages (budgets, costs, offers). */
  counterpartySaidAmounts: number[];
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
  approvals: Array<{ requestId: string; responseId: string; offerId: string; termsHash: string; mandateRevision: number; purpose: "acceptance" | "exception"; breachedRuleIds: string[]; decision: "approved" | "rejected" | "countered" }>;
  /** What following up on a pending offer needs, and where the follow-up stands. */
  followUp: FollowUpState;
  /** A voice call is connected right now. */
  callConnected: boolean;
  /** An approval request the counterparty's change of terms made void, while its replacement is open. */
  supersededApproval: { offerId: string; terms: OfferTerm[] } | null;
  /** Call recordings kept for the principal, oldest first. */
  recordings: Array<{ id: string; source: "browser" | "twilio" | "vobiz"; file: string; contentType: string; durationMs: number | null; recordedAt: string }>;
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

export interface FollowUpState {
  /** How long the offer stands, for the offer named in validityOfferId. */
  validUntil: string | null;
  validity: string | null;
  validityOfferId: string | null;
  contact: "chat" | "call" | "whatsapp" | null;
  phone: string | null;
  bestTime: string | null;
  keepContact: boolean | null;
  /** Offers whose wrap-up ("not final until ... confirms") was already said. */
  closedOfferIds: string[];
  /** The principal's latest decision on an approval request. */
  decision: {
    responseId: string;
    requestId: string;
    decision: "approved" | "countered" | "declined";
    offerId: string;
    counterOfferId: string | null;
    messageToCounterparty: string | null;
    purpose: "acceptance" | "exception";
    recordedAt: string;
  } | null;
  /** A reply went to the counterparty after that decision. */
  followedUp: boolean;
  attempts: Array<{ channel: "text" | "call"; attempt: number; outcome: PayloadOf<"follow_up_attempted">["outcome"]; providerCallId: string | null; recordedAt: string }>;
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
  const counterpartySaidAmounts = new Set<number>();
  let countersMade = 0;
  let splitUsed = false;
  let offersSinceAsk = 0;
  let lastProposed: StatedOffer | null = null;
  let lastCommunicated: StatedOffer | null = null;
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
  const followUp: FollowUpState = { validUntil: null, validity: null, validityOfferId: null, contact: null, phone: null, bestTime: null, keepContact: null, closedOfferIds: [], decision: null, followedUp: false, attempts: [] };
  let callConnected = false;
  let supersededApproval: NegotiationState["supersededApproval"] = null;
  const recordings: NegotiationState["recordings"] = [];

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
    if (e.type === "message" && followUp.decision && (e.payload as PayloadOf<"message">).direction === "outbound") followUp.followedUp = true;
    if (e.type === "message" && (e.payload as PayloadOf<"message">).direction === "inbound") {
      for (const a of findAmounts((e.payload as PayloadOf<"message">).text)) counterpartySaidAmounts.add(a);
    }
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
        const extracted = ctx.payloadOf(p.offerId, "offer_extracted");
        if (extracted && (!extracted.kind || extracted.kind === "offer")) lastCounterpartyCheck = { offerId: p.offerId, checkedTerms: p.checkedTerms, result: p.result, findings: p.findings };
        break;
      }
      case "offer_extracted": {
        const p = ctx.effective.get(e.id) as PayloadOf<"offer_extracted">;
        if (p.kind && p.kind !== "offer") break;
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
        const communicated = ctx.isCommunicated(e.id);
        lastProposed = { offerId: e.id, basis: p.basis, terms: p.terms, termsHash: p.termsHash, communicated };
        if (communicated) lastCommunicated = lastProposed;
        const amount = amountOf(p.terms);
        // Only what the counterparty actually received counts as the agent's ask; an exception
        // package waiting for the principal, or a blocked offer, never moved the ask.
        if (amount !== null && amount !== currentAsk && communicated) {
          currentAsk = amount;
          askHistory.push(amount);
          offersSinceAsk = 0;
          if (p.basis === "counter") countersMade += 1;
        }
        if (p.tactic === "split_difference" && communicated) splitUsed = true;
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
          decision: p.decision === "approved" || p.decision === "countered" ? p.decision : "rejected",
        });
        followUp.decision = {
          responseId: e.id,
          requestId: p.requestId,
          decision: p.decision === "approved" || p.decision === "countered" ? p.decision : "declined",
          offerId: p.offerId,
          counterOfferId: p.counterOfferId ?? null,
          messageToCounterparty: p.messageToCounterparty ?? null,
          purpose: request?.purpose ?? "acceptance",
          recordedAt: e.recordedAt,
        };
        followUp.followedUp = false;
        followUp.attempts = [];
        supersededApproval = null;
        answered.add(p.requestId);
        if (pendingApproval?.requestId === p.requestId) pendingApproval = null;
        break;
      }
      case "follow_up_noted": {
        const p = e.payload as PayloadOf<"follow_up_noted">;
        // Each event adds what it says; validity belongs to the offer it was given for.
        if (p.validUntil !== null || p.validity !== null) {
          followUp.validUntil = p.validUntil;
          followUp.validity = p.validity;
          followUp.validityOfferId = p.offerId;
        }
        if (p.contact !== null) followUp.contact = p.contact;
        if (p.phone !== null) followUp.phone = p.phone;
        if (p.bestTime !== null) followUp.bestTime = p.bestTime;
        if (p.keepContact !== null) followUp.keepContact = p.keepContact;
        if (p.closed && p.offerId && !followUp.closedOfferIds.includes(p.offerId)) followUp.closedOfferIds.push(p.offerId);
        break;
      }
      case "follow_up_attempted": {
        const p = e.payload as PayloadOf<"follow_up_attempted">;
        if (followUp.decision?.responseId === p.responseId) followUp.attempts.push({ channel: p.channel, attempt: p.attempt, outcome: p.outcome, providerCallId: p.providerCallId, recordedAt: e.recordedAt });
        break;
      }
      case "recording_saved": {
        const p = e.payload as PayloadOf<"recording_saved">;
        recordings.push({ id: e.id, source: p.source, file: p.file, contentType: p.contentType, durationMs: p.durationMs, recordedAt: e.recordedAt });
        break;
      }
      case "voice_connection":
        callConnected = (e.payload as PayloadOf<"voice_connection">).status === "connected";
        break;
      case "agreement_recorded":
        agreement = { id: e.id, payload: e.payload as PayloadOf<"agreement_recorded"> };
        break;
      case "status_changed": {
        const s = e.payload as PayloadOf<"status_changed">;
        if (s.to === "paused") statusBeforePause = s.from;
        else if (s.from === "paused") statusBeforePause = null;
        // Leaving the approval wait for any reason but a pause supersedes the pending request.
        if (s.to !== "awaiting_approval" && s.to !== "paused" && pendingApproval) {
          const terms = ctx.offerTerms(pendingApproval.offerId)?.terms;
          supersededApproval = s.to === "active" && terms ? { offerId: pendingApproval.offerId, terms } : null;
          pendingApproval = null;
        }
        break;
      }
    }
  }
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
    lastCommunicated,
    askHistory,
    counterpartyAmounts,
    counterpartySaidAmounts: [...counterpartySaidAmounts],
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
    followUp,
    callConnected,
    recordings,
    supersededApproval,
  };
}
