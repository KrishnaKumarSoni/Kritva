/**
 * Thin-slice strategy: a deterministic policy that turns the counterparty's interpreted
 * move into the agent's next move. Epics 3–8 deepen this; the contract stays the same.
 *
 * The policy only ever proposes values inside the confirmed mandate. It reads limits and
 * authority from the mandate, never from conversation content.
 */
import type { DecisionKind, OfferTerm } from "../record/events.ts";
import type { Value } from "../schema/records.ts";
import { numericValue, violatesFixedRule, withTerm, type MandateView } from "./mandate-view.ts";
import type { NegotiationState, StatedOffer } from "./state.ts";

export interface Interpretation {
  intent: "offer" | "accept_stated_terms" | "question" | "request_change" | "reject" | "greeting" | "other";
  /** Terms the counterparty proposed or asked to change, already mapped to mandate terms. */
  offerTerms: OfferTerm[];
  acceptsStatedTerms: boolean;
  asksPrivateInfo: boolean;
  claimsAuthority: boolean;
  questions: string[];
}

export type Move =
  | "counter"
  | "state_final_terms"
  | "request_approval"
  | "confirm_agreement"
  | "hold"
  | "answer"
  | "await_approval"
  | "closed";

export interface Plan {
  move: Move;
  decision: { kind: DecisionKind; reason: string };
  offer: { terms: OfferTerm[]; basis: "counter" | "final_terms" } | null;
  /** Stated terms the counterparty just accepted. */
  acceptanceOf: StatedOffer | null;
  declined: Array<{ termId: string; requested: Value }>;
  refuseDisclosure: boolean;
  ignoreAuthorityClaim: boolean;
  questions: string[];
  /** The counterparty amount this move responds to, if any. */
  respondingTo: number | null;
  /** Something the reply must tell the counterparty first. */
  notice: "approval_rejected" | "terms_changed" | "rephrase" | null;
}

export function decide(state: NegotiationState, interp: Interpretation): Plan {
  const view = state.view;
  const n = view.negotiable;
  const plan: Plan = {
    move: "answer",
    decision: { kind: "answer", reason: "Answer the counterparty." },
    offer: null,
    acceptanceOf: null,
    declined: [],
    refuseDisclosure: interp.asksPrivateInfo,
    ignoreAuthorityClaim: interp.claimsAuthority,
    questions: interp.questions,
    respondingTo: null,
    notice: null,
  };

  if (state.outcome.kind === "agreement") {
    return { ...plan, move: "closed", decision: { kind: "answer", reason: "An agreement is already recorded; nothing changes." } };
  }

  // When the counterparty accepts, values that merely repeat the stated terms are not changes.
  const stated = state.pendingFinal ?? state.lastProposed;
  const proposedTerms = interp.acceptsStatedTerms && stated
    ? interp.offerTerms.filter((t) => {
        const s = stated.terms.find((x) => x.termId === t.termId);
        return !s || JSON.stringify(s.value) !== JSON.stringify(t.value);
      })
    : interp.offerTerms;

  // Split the counterparty's terms into the negotiable amount and requests on other terms.
  let amount: number | null = null;
  for (const t of proposedTerms) {
    if (n && t.termId === n.termId && "amount" in t.value) {
      amount = t.value.amount as number;
      continue;
    }
    const current = view.defaultPackage.find((d) => d.termId === t.termId);
    const unchanged = current && JSON.stringify(current.value) === JSON.stringify(t.value);
    if (!unchanged) plan.declined.push({ termId: t.termId, requested: t.value });
  }
  plan.respondingTo = amount;
  const declineReason = plan.declined.length > 0 ? " Requested changes to other terms are outside the mandate." : "";

  // Already waiting on the principal: repeating acceptance changes nothing.
  if (state.status === "awaiting_approval" && amount === null && plan.declined.length === 0) {
    return { ...plan, move: "await_approval", decision: { kind: "hold", reason: "Waiting for the principal's approval." } };
  }

  // Accepting the stated terms, with nothing changed.
  if (interp.acceptsStatedTerms && amount === null && plan.declined.length === 0) {
    const final = state.pendingFinal;
    if (final && final.communicated) {
      if (view.acceptRequiresApproval) {
        return { ...plan, move: "request_approval", acceptanceOf: final, decision: { kind: "request_approval", reason: "Counterparty accepted the stated terms; the mandate requires the principal's approval." } };
      }
      return { ...plan, move: "confirm_agreement", acceptanceOf: final, decision: { kind: "record_agreement", reason: "Counterparty accepted the stated terms; the mandate allows accepting." } };
    }
    return {
      ...plan,
      move: "state_final_terms",
      offer: { terms: finalPackage(view, state.currentAsk), basis: "final_terms" },
      decision: { kind: "state_final_terms", reason: "Counterparty agreed in principle; state the complete terms for confirmation." },
    };
  }

  if (amount !== null && n && state.currentAsk !== null) {
    const ask = state.currentAsk;
    const atLeast = (x: number, y: number) => (n.direction === "up" ? x >= y : x <= y);
    const step = niceStep(n.opening);

    if (atLeast(amount, ask)) {
      return finalAt(plan, view, ask, `Offer meets the current ask.${declineReason}`);
    }
    if (!n.canConcede) {
      return holdAt(plan, view, ask, `No authority to move from the current ask.${declineReason}`);
    }
    if (!atLeast(amount, n.limit)) {
      if (ask === n.limit) return holdAt(plan, view, ask, `Offer is outside the limit; the ask is already at the limit.${declineReason}`);
      const next = clampToLimit(n, roundToward(n, ask - towardSign(n) * Math.abs(ask - n.limit) / 2, step));
      return counterAt(plan, view, next === ask ? n.limit : next, `Offer is outside the limit; counter without revealing it.${declineReason}`);
    }
    const repeated = state.counterpartyAmounts.slice(0, -1).includes(amount);
    if (state.countersMade >= 2 || repeated || Math.abs(ask - amount) <= step) {
      return finalAt(plan, view, amount, `Offer is within the mandate; state complete terms.${declineReason}`);
    }
    const middle = roundToward(n, (ask + amount) / 2, step);
    if (middle === ask || middle === amount) return finalAt(plan, view, amount, `Offer is within the mandate; state complete terms.${declineReason}`);
    return counterAt(plan, view, middle, `Offer is within the mandate but below the ask; counter in between.${declineReason}`);
  }

  if (plan.declined.length > 0) {
    return { ...plan, move: "answer", decision: { kind: "decline_request", reason: "Requested term changes are outside the mandate." } };
  }
  if (interp.asksPrivateInfo) {
    return { ...plan, move: "answer", decision: { kind: "decline_request", reason: "Private limits are never disclosed." } };
  }
  return plan;
}

function finalPackage(view: MandateView, amount: number | null): OfferTerm[] {
  const n = view.negotiable;
  const base = [...view.defaultPackage].sort((a, b) => a.termId.localeCompare(b.termId));
  return n && amount !== null ? withTerm(base, n.termId, numericValue(n, amount)) : base;
}

function finalAt(plan: Plan, view: MandateView, amount: number, reason: string): Plan {
  return { ...plan, move: "state_final_terms", offer: { terms: finalPackage(view, amount), basis: "final_terms" }, decision: { kind: "state_final_terms", reason } };
}

function counterAt(plan: Plan, view: MandateView, amount: number, reason: string): Plan {
  return { ...plan, move: "counter", offer: { terms: finalPackage(view, amount), basis: "counter" }, decision: { kind: "counter", reason } };
}

function holdAt(plan: Plan, view: MandateView, amount: number, reason: string): Plan {
  return { ...plan, move: "hold", offer: { terms: finalPackage(view, amount), basis: "counter" }, decision: { kind: "hold", reason } };
}

/** A round increment for the term's scale: 500 for tens of thousands, 50 for thousands, and so on. */
export function niceStep(reference: number): number {
  if (reference <= 0) return 1;
  return Math.max(1, 10 ** (Math.floor(Math.log10(reference)) - 2) * 5);
}

const towardSign = (n: { direction: "up" | "down" }) => (n.direction === "up" ? 1 : -1);

/** Rounds to the step in the principal's favour. */
function roundToward(n: { direction: "up" | "down" }, value: number, step: number): number {
  return n.direction === "up" ? Math.ceil(value / step) * step : Math.floor(value / step) * step;
}

function clampToLimit(n: { direction: "up" | "down"; limit: number }, value: number): number {
  return n.direction === "up" ? Math.max(n.limit, value) : Math.min(n.limit, value);
}

/** Plan-level check: every value the agent offers satisfies the mandate. Runs before wording. */
export function planViolations(view: MandateView, plan: Plan): string[] {
  const problems: string[] = [];
  if (!plan.offer) return problems;
  const n = view.negotiable;
  for (const t of plan.offer.terms) {
    if (!view.terms.has(t.termId)) problems.push(`offer names an unknown term ${t.termId}`);
    if (violatesFixedRule(view, t.termId, t.value)) problems.push(`offer breaks a fixed rule on ${view.terms.get(t.termId)?.name ?? t.termId}`);
    if (n && t.termId === n.termId && "amount" in t.value) {
      const amount = t.value.amount as number;
      if (n.direction === "up" ? amount < n.limit : amount > n.limit) problems.push("offer crosses the principal's limit");
    }
  }
  return problems;
}
