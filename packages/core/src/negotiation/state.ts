/**
 * The negotiation's current position, derived only from recorded events. Strategy, the
 * console and the outcome card all read this projection; none keep their own history.
 */
import type { OfferTerm, PayloadOf, RecordedEvent, SessionStatus } from "../record/events.ts";
import type { SessionContext } from "../record/rules.ts";
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
  lastProposed: StatedOffer | null;
  /** The latest complete terms the agent stated for confirmation. */
  pendingFinal: StatedOffer | null;
  pendingApproval: { requestId: string; offerId: string; termsHash: string; acceptanceId: string | null } | null;
  acceptances: Array<{ id: string; offerId: string; termsHash: string }>;
  outcome: Outcome;
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
  let lastProposed: StatedOffer | null = null;
  let pendingFinal: StatedOffer | null = null;
  let pendingApproval: NegotiationState["pendingApproval"] = null;
  const acceptances: NegotiationState["acceptances"] = [];
  let agreement: { id: string; payload: PayloadOf<"agreement_recorded"> } | null = null;
  const answered = new Set<string>();

  const amountOf = (terms: OfferTerm[]) => {
    const t = n ? terms.find((x) => x.termId === n.termId) : undefined;
    return t && "amount" in t.value ? (t.value.amount as number) : null;
  };

  for (const e of ctx.events as RecordedEvent[]) {
    switch (e.type) {
      case "offer_extracted": {
        const p = ctx.effective.get(e.id) as PayloadOf<"offer_extracted">;
        const amount = amountOf(p.terms);
        if (amount !== null) counterpartyAmounts.push(amount);
        break;
      }
      case "offer_proposed": {
        const p = ctx.effective.get(e.id) as PayloadOf<"offer_proposed">;
        lastProposed = { offerId: e.id, basis: p.basis, terms: p.terms, termsHash: p.termsHash, communicated: false };
        const amount = amountOf(p.terms);
        if (amount !== null && amount !== currentAsk) {
          currentAsk = amount;
          askHistory.push(amount);
          if (p.basis === "counter") countersMade += 1;
        }
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
        pendingApproval = { requestId: e.id, offerId: p.offerId, termsHash: p.termsHash, acceptanceId: p.acceptanceId };
        break;
      }
      case "approval_responded": {
        const p = e.payload as PayloadOf<"approval_responded">;
        answered.add(p.requestId);
        if (pendingApproval?.requestId === p.requestId) pendingApproval = null;
        break;
      }
      case "agreement_recorded":
        agreement = { id: e.id, payload: e.payload as PayloadOf<"agreement_recorded"> };
        break;
      case "status_changed":
        // Leaving the approval wait (terms changed, or rejected) supersedes the pending request.
        if ((e.payload as PayloadOf<"status_changed">).to !== "awaiting_approval") pendingApproval = null;
        break;
    }
  }
  if (lastProposed) lastProposed.communicated = ctx.isCommunicated(lastProposed.offerId);
  if (pendingFinal) pendingFinal.communicated = ctx.isCommunicated(pendingFinal.offerId);
  // Final terms are pending only while they are the latest thing the agent proposed.
  if (pendingFinal && lastProposed && pendingFinal.offerId !== lastProposed.offerId) pendingFinal = null;

  let outcome: Outcome = { kind: "in_progress", terms: null, termsHash: null, agreementId: null, approvalRequestId: null };
  if (agreement) {
    outcome = { kind: "agreement", terms: agreement.payload.terms, termsHash: agreement.payload.termsHash, agreementId: agreement.id, approvalRequestId: null };
  } else if (pendingApproval) {
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
    lastProposed,
    pendingFinal,
    pendingApproval,
    acceptances,
    outcome,
  };
}
