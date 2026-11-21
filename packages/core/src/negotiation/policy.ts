/**
 * Thin-slice strategy: a deterministic policy that turns the counterparty's interpreted
 * move into the agent's next move. Epics 3–8 deepen this; the contract stays the same.
 *
 * The policy only ever proposes values inside the confirmed mandate. It reads limits and
 * authority from the mandate, never from conversation content.
 */
import { hashTerms, type DecisionKind, type OfferTerm } from "../record/events.ts";
import type { Value } from "../schema/records.ts";
import { applicableLimit, type DealCheck } from "../dealspace/check.ts";
import { numericValue, violatesFixedRule, withTerm, type MandateView } from "./mandate-view.ts";
import { approvedFor, clearedNow, type NegotiationState, type StatedOffer } from "./state.ts";

export interface Interpretation {
  intent: "offer" | "accept_stated_terms" | "question" | "request_change" | "reject" | "greeting" | "other";
  /** Terms the counterparty proposed or asked to change, already mapped to mandate terms. */
  offerTerms: OfferTerm[];
  acceptsStatedTerms: boolean;
  asksPrivateInfo: boolean;
  claimsAuthority: boolean;
  questions: string[];
  /** Things the counterparty asked for that no mandate term covers (e.g. an added service). */
  newTerms: Array<{ name: string; description: string | null; value: Value | null }>;
  /** Needs, constraints, reasons, claims and the like, each with the counterparty's exact words. */
  notes?: Array<{ kind: string; quote: string; summary: string; termId: string | null; value: Value | null; condition: string | null; basis: "stated" | "inferred" }>;
  /** Answers to questions the agent asked earlier. */
  answers?: Array<{ questionId: string; quote: string | null; resolution: "answered" | "partial" | "refused" }>;
}

/** The counterparty's proposal as a whole: their terms on top of the agent's current package, and its deal-space check. */
export interface DealInput {
  package: OfferTerm[];
  check: DealCheck;
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
  notice: "approval_rejected" | "terms_changed" | "rephrase" | "check_with_principal" | "paused" | null;
  /** Term names to ask the counterparty about (missing details a rule depends on). Values are never suggested. */
  clarify: string[];
  /** Requests the mandate does not address: taken to the principal, never promised or priced. */
  unresolved: string[];
  /** A prepared question to ask (selection is a placeholder until strategy, Epic 8). */
  ask: { questionId: string; text: string } | null;
}

export function decide(state: NegotiationState, interp: Interpretation, deal: DealInput): Plan {
  const view = state.view;
  const n = view.negotiable;
  const nameOf = (id: string) => state.space.terms.find((t) => t.termId === id)?.name ?? id;
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
    clarify: [],
    unresolved: interp.newTerms.map((t) => t.name),
    ask: null,
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

  // Sort the counterparty's terms by what the deal-space check says about each one.
  let amount: number | null = null;
  const extras: OfferTerm[] = [];
  const findingsFor = (termId: string) => deal.check.findings.filter((f) => f.termId === termId);
  for (const t of proposedTerms) {
    if (n && t.termId === n.termId && "amount" in t.value) {
      amount = t.value.amount as number;
      continue;
    }
    const current = view.defaultPackage.find((d) => d.termId === t.termId);
    if (current && JSON.stringify(current.value) === JSON.stringify(t.value)) continue;
    const findings = findingsFor(t.termId);
    if (findings.some((f) => f.status === "conflict")) plan.declined.push({ termId: t.termId, requested: t.value });
    else if (findings.some((f) => f.status === "needs_clarification" && f.basis === "condition")) extras.push(t);
    else if (findings.some((f) => f.status === "needs_clarification")) plan.unresolved.push(nameOf(t.termId));
    else extras.push(t);
  }
  // Details a rule depends on that the proposal leaves out: ask for them, without suggesting values.
  for (const f of deal.check.findings) {
    if (f.status === "needs_clarification" && f.basis === "condition" && f.relatedTermId && !deal.package.some((t) => t.termId === f.relatedTermId)) {
      const name = nameOf(f.relatedTermId);
      if (!plan.clarify.includes(name)) plan.clarify.push(name);
    }
  }
  // A change to another term can break the price it was tied to: treat that price as the offer to answer.
  if (amount === null && n && proposedTerms.length > 0 && findingsFor(n.termId).some((f) => f.status !== "fits")) {
    const tied = deal.package.find((t) => t.termId === n.termId);
    if (tied && "amount" in tied.value) amount = tied.value.amount as number;
  }
  plan.respondingTo = amount;
  const declineReason = plan.declined.length > 0 ? " Requested changes to other terms are outside the mandate." : "";

  // Already waiting on the principal: repeating acceptance changes nothing.
  if (state.status === "awaiting_approval" && amount === null && plan.declined.length === 0 && extras.length === 0) {
    return { ...plan, move: "await_approval", decision: { kind: "hold", reason: "Waiting for the principal's approval." } };
  }

  // Accepting the stated terms, with nothing changed.
  if (interp.acceptsStatedTerms && amount === null && plan.declined.length === 0 && extras.length === 0 && plan.unresolved.length === 0) {
    const final = state.pendingFinal;
    // Accept only terms that were delivered and are cleared under the mandate in force.
    if (final && final.communicated && clearedNow(state, final.offerId, final.termsHash)) {
      // The principal already approved these exact terms (e.g. an exception): no second approval.
      if (view.acceptRequiresApproval && !approvedFor(state, final.termsHash)) {
        return { ...plan, move: "request_approval", acceptanceOf: final, decision: { kind: "request_approval", reason: "Counterparty accepted the stated terms; the mandate requires the principal's approval." } };
      }
      return { ...plan, move: "confirm_agreement", acceptanceOf: final, decision: { kind: "record_agreement", reason: "Counterparty accepted the stated terms; the mandate allows accepting." } };
    }
    return {
      ...plan,
      move: "state_final_terms",
      offer: { terms: finalPackage(view, state.currentAsk === null ? null : Math.max(state.currentAsk, n?.limit ?? -Infinity), packageExtras(state, extras)), basis: "final_terms" },
      decision: { kind: "state_final_terms", reason: "Counterparty agreed in principle; state the complete terms for confirmation." },
    };
  }

  if (amount !== null && n && state.currentAsk !== null) {
    const atLeast = (x: number, y: number) => (n.direction === "up" ? x >= y : x <= y);
    // An ask below the limit now in force (after a mandate change) is raised back to it.
    const ask = atLeast(state.currentAsk, n.limit) ? state.currentAsk : n.limit;
    const step = niceStep(n.opening);
    const keep = packageExtras(state, extras);
    // How far this particular package may go: conditional relaxations apply only when their conditions hold.
    const limit = applicableLimit(state.space, n.termId, deal.package)?.amount ?? n.limit;
    const settled = !findingsFor(n.termId).some((f) => f.status === "needs_clarification" && f.basis === "condition");
    if (!settled && !atLeast(amount, n.limit)) {
      return { ...plan, move: "answer", decision: { kind: "answer", reason: "The offer depends on a detail the counterparty has not given; ask for it." } };
    }

    if (atLeast(amount, ask)) {
      return finalAt(plan, view, ask, keep, `Offer meets the current ask.${declineReason}`);
    }
    if (!n.canConcede) {
      return holdAt(plan, view, ask, keep, `No authority to move from the current ask.${declineReason}`);
    }
    if (!atLeast(amount, limit)) {
      if (ask === limit) {
        // Already holding at the limit. If the mandate lets the principal approve an exception to
        // this limit, put the counterparty's terms to the principal; the gate turns this into an
        // approval request, and nothing is offered unless the principal approves.
        const binding = applicableLimit(state.space, n.termId, deal.package);
        const candidate = finalPackage(view, amount, keep);
        const alreadyRejected = state.approvals.some((a) => a.decision === "rejected" && a.termsHash === hashTerms(candidate) && a.mandateRevision === state.mandateRevision);
        if (binding && !alreadyRejected && view.authority.exceptionFor(binding.ruleId) === "with_approval" && state.counterpartyAmounts.slice(0, -1).length > 0) {
          return finalAt(plan, view, amount, keep, `Offer is outside the limit; the mandate allows asking the principal for an exception.${declineReason}`);
        }
        return holdAt(plan, view, ask, keep, `Offer is outside the limit; the ask is already at the limit.${declineReason}`);
      }
      const next = clampToLimit({ ...n, limit }, roundToward(n, ask - towardSign(n) * Math.abs(ask - limit) / 2, step));
      return counterAt(plan, view, next === ask ? limit : next, keep, `Offer is outside the limit; counter without revealing it.${declineReason}`);
    }
    const repeated = state.counterpartyAmounts.slice(0, -1).includes(amount);
    if (state.countersMade >= 2 || repeated || Math.abs(ask - amount) <= step) {
      return finalAt(plan, view, amount, keep, `Offer is within the mandate; state complete terms.${declineReason}`);
    }
    const middle = roundToward(n, (ask + amount) / 2, step);
    if (middle === ask || middle === amount) return finalAt(plan, view, amount, keep, `Offer is within the mandate; state complete terms.${declineReason}`);
    return counterAt(plan, view, middle, keep, `Offer is within the mandate but below the ask; counter in between.${declineReason}`);
  }

  if (plan.declined.length > 0) {
    return { ...plan, move: "answer", decision: { kind: "decline_request", reason: "Requested term changes are outside the mandate." } };
  }
  if (plan.unresolved.length > 0) {
    return { ...plan, move: "answer", decision: { kind: "answer", reason: "The request is not covered by the mandate; take it to the principal without promising anything." } };
  }
  if (plan.clarify.length > 0) {
    return { ...plan, move: "answer", decision: { kind: "answer", reason: "A detail the terms depend on is missing; ask for it." } };
  }
  if (interp.asksPrivateInfo) {
    return { ...plan, move: "answer", decision: { kind: "decline_request", reason: "Private limits are never disclosed." } };
  }
  return plan;
}

/** The principal's package with the negotiated amount and any counterparty terms that fit. */
function finalPackage(view: MandateView, amount: number | null, extras: OfferTerm[] = []): OfferTerm[] {
  const n = view.negotiable;
  let pkg = [...view.defaultPackage].sort((a, b) => a.termId.localeCompare(b.termId));
  for (const t of extras) pkg = withTerm(pkg, t.termId, t.value);
  return n && amount !== null ? withTerm(pkg, n.termId, numericValue(n, amount)) : pkg;
}

/** Counterparty terms already agreed into the agent's package earlier, plus new ones that fit. */
function packageExtras(state: NegotiationState, extras: OfferTerm[]): OfferTerm[] {
  const n = state.view.negotiable;
  const earlier = (state.lastProposed?.terms ?? []).filter((t) => t.termId !== n?.termId && !state.view.defaultPackage.some((d) => d.termId === t.termId));
  const merged = new Map(earlier.map((t) => [t.termId, t]));
  for (const t of extras) merged.set(t.termId, t);
  return [...merged.values()];
}

function finalAt(plan: Plan, view: MandateView, amount: number, extras: OfferTerm[], reason: string): Plan {
  return { ...plan, move: "state_final_terms", offer: { terms: finalPackage(view, amount, extras), basis: "final_terms" }, decision: { kind: "state_final_terms", reason } };
}

function counterAt(plan: Plan, view: MandateView, amount: number, extras: OfferTerm[], reason: string): Plan {
  return { ...plan, move: "counter", offer: { terms: finalPackage(view, amount, extras), basis: "counter" }, decision: { kind: "counter", reason } };
}

function holdAt(plan: Plan, view: MandateView, amount: number, extras: OfferTerm[], reason: string): Plan {
  return { ...plan, move: "hold", offer: { terms: finalPackage(view, amount, extras), basis: "counter" }, decision: { kind: "hold", reason } };
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
export function planViolations(state: NegotiationState, plan: Plan): string[] {
  const problems: string[] = [];
  if (!plan.offer) return problems;
  const view = state.view;
  const n = view.negotiable;
  for (const t of plan.offer.terms) {
    if (!view.terms.has(t.termId)) problems.push(`offer names an unknown term ${t.termId}`);
    if (violatesFixedRule(view, t.termId, t.value)) problems.push(`offer breaks a fixed rule on ${view.terms.get(t.termId)?.name ?? t.termId}`);
    if (n && t.termId === n.termId && "amount" in t.value) {
      const amount = t.value.amount as number;
      // The limit that applies to this exact package, conditional relaxations included only when they hold.
      const limit = applicableLimit(state.space, n.termId, plan.offer.terms)?.amount ?? n.limit;
      if (n.direction === "up" ? amount < limit : amount > limit) problems.push("offer crosses the principal's limit");
    }
  }
  return problems;
}
