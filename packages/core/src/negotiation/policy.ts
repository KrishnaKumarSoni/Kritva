/**
 * Strategy (Epic 8): a deterministic chooser that turns the counterparty's interpreted move
 * into one action: ask, clarify, propose, counter, accept, decline, request approval, pause or end.
 *
 * Order of precedence: the confirmed mandate and governance first (hard limits, authority),
 * then the principal's stated interests, then tactic parameters from strategy guidance (data,
 * never code). The chooser only proposes values inside the mandate and reads limits and
 * authority from it, never from conversation content; the outgoing gate still checks every move.
 */
import { hashTerms, type DecisionKind, type OfferTerm } from "../record/events.ts";
import type { Value } from "../schema/records.ts";
import { applicableLimit, sameValue, type DealCheck } from "../dealspace/check.ts";
import { numericValue, violatesFixedRule, withTerm, type MandateView, type NegotiableTerm } from "./mandate-view.ts";
import { assessPackage, type Assessment } from "../strategy/assess.ts";
import { MINIMAL_GUIDANCE, type StrategyGuidance } from "../strategy/guidance.ts";
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
  /** Whether an amount is a committed offer, a question about a price, or only interest. */
  offerKind?: "offer" | "enquiry" | "interest";
  /** Conditions the counterparty attached that the terms cannot express ("if I get a truck"). */
  offerConditions?: string[];
  /** The counterparty corrects their previous offer ("sorry, I meant X"). */
  correctsPrevious?: boolean;
  /** The counterparty declines to continue or withdraws. */
  endsNegotiation?: boolean;
  /** A pressure move: asking for the lowest price, calling an offer final, or citing a cheaper option. */
  pressure?: "none" | "lowest_price" | "final_offer" | "cheaper_elsewhere";
}

/** The counterparty's proposal as a whole: their terms on top of the agent's current package, and its deal-space check. */
export interface DealInput {
  package: OfferTerm[];
  check: DealCheck;
}

export type Move =
  | "end_negotiation"
  | "counter"
  | "state_final_terms"
  | "request_approval"
  | "confirm_agreement"
  | "hold"
  | "answer"
  | "await_approval"
  | "closed";

export type Tactic = "concession_step" | "split_difference" | "halve_distance";

export type Action = "ask" | "clarify" | "propose" | "counter" | "accept" | "decline" | "request_approval" | "pause" | "end" | "wait" | "answer";

export interface Plan {
  move: Move;
  /** The strategy action this plan carries out (Epic 8). */
  action?: Action;
  /** The package assessment behind it, when there was a package to assess. */
  assessment?: Assessment | null;
  /** For an end: who asked for it, why, and what was left open. */
  end?: { requestedBy: "counterparty" | "agent" | "principal"; reason: string; unresolved: string[]; line: string | null } | null;
  /** A question the strategy wants asked that is not one Epic 5 prepared (recorded before asking). */
  strategyQuestion?: { text: string; kind: "terms_probe" | "comparison" | "conditional"; purpose: string; key?: string };
  decision: { kind: DecisionKind; reason: string };
  offer: { terms: OfferTerm[]; basis: "counter" | "final_terms"; tactic?: Tactic | null } | null;
  /** Stated terms the counterparty just accepted. */
  acceptanceOf: StatedOffer | null;
  declined: Array<{ termId: string; requested: Value }>;
  refuseDisclosure: boolean;
  ignoreAuthorityClaim: boolean;
  questions: string[];
  /** The counterparty amount this move responds to, if any. */
  respondingTo: number | null;
  /** Something the reply must tell the counterparty first. */
  notice: "approval_rejected" | "terms_changed" | "rephrase" | "check_with_principal" | "paused" | "ended" | null;
  /** Term names to ask the counterparty about (missing details a rule depends on). Values are never suggested. */
  clarify: string[];
  /** Requests the mandate does not address: taken to the principal, never promised or priced. */
  unresolved: string[];
  /** A prepared question to ask (selection is a placeholder until strategy, Epic 8). */
  ask: { questionId: string; text: string } | null;
  /** A short acknowledgment to open with (for example after they decline to answer a question). */
  acknowledge?: string;
  /** First reply of the session: Kritva introduces itself once as the principal's AI assistant. */
  introduce?: boolean;
  /** How many replies the agent has sent before this one; varies fallback wording. */
  turnIndex?: number;
}

/** What the strategy can see beyond the turn: guidance, and questions this turn prepared. */
export interface StrategyContext {
  guidance: StrategyGuidance;
  /** Questions prepared from this message (e.g. about a non-price obstacle), not yet asked. */
  freshQuestions: Array<{ questionId: string; text: string; kind: string }>;
  /** A question about a counterparty condition was already asked in this session: never ask it again. */
  conditionAsked?: boolean;
  locale: string;
}

const DEFAULT_CONTEXT: StrategyContext = { guidance: MINIMAL_GUIDANCE, freshQuestions: [], locale: "en" };

/**
 * Epic 8: choose one move from the recorded state. Hard constraints first, then the principal's
 * stated interests, then guidance tactics. The move is a proposal only: the outgoing gate decides
 * whether it may be sent, and nothing here grants authority.
 */
export function decide(state: NegotiationState, interp: Interpretation, deal: DealInput, context: StrategyContext = DEFAULT_CONTEXT): Plan {
  const view = state.view;
  const n = view.negotiable;
  const g = context.guidance;
  const nameOf = (id: string) => state.space.terms.find((t) => t.termId === id)?.name ?? id;
  const plan: Plan = {
    move: "answer",
    action: "answer",
    decision: { kind: "answer", reason: "Answer the counterparty." },
    offer: null,
    acceptanceOf: null,
    declined: [],
    refuseDisclosure: interp.asksPrivateInfo,
    ignoreAuthorityClaim: interp.claimsAuthority,
    // A question about a price that comes with an offer is answered by the move itself, not as a factual question.
    questions: interp.offerTerms.length > 0 ? interp.questions.filter((q) => !/\d/.test(q)) : interp.questions,
    respondingTo: null,
    notice: null,
    clarify: [],
    unresolved: interp.newTerms.map((t) => t.name),
    ask: null,
    assessment: null,
    end: null,
  };

  if (state.outcome.kind === "agreement") {
    return { ...plan, move: "closed", action: "answer", decision: { kind: "answer", reason: "An agreement is already recorded; nothing changes." } };
  }
  if (state.outcome.kind === "no_agreement") {
    return { ...plan, move: "closed", action: "answer", notice: "ended", refuseDisclosure: false, questions: [], unresolved: [], decision: { kind: "answer", reason: "The negotiation ended without agreement; nothing is offered." } };
  }

  // The counterparty declines to continue: end without agreement, and say so plainly. A final offer
  // that still puts terms on the table is an offer, not a withdrawal.
  if (interp.endsNegotiation && !(interp.offerTerms.length > 0 && interp.pressure === "final_offer")) {
    return endWith(plan, "counterparty", "The counterparty declined to continue.", unresolvedTerms(state, deal), null);
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
    if (current && sameValue(current.value, t.value)) continue;
    const findings = findingsFor(t.termId);
    if (findings.some((f) => f.status === "conflict")) plan.declined.push({ termId: t.termId, requested: t.value });
    else if (findings.some((f) => f.status === "needs_clarification" && f.basis === "condition")) extras.push(t);
    else if (findings.some((f) => f.status === "needs_clarification")) plan.unresolved.push(nameOf(t.termId));
    else extras.push(t);
  }
  for (const f of deal.check.findings) {
    if (f.status === "needs_clarification" && f.basis === "condition" && f.relatedTermId && !deal.package.some((t) => t.termId === f.relatedTermId)) {
      const name = nameOf(f.relatedTermId);
      if (!plan.clarify.includes(name)) plan.clarify.push(name);
    }
  }
  if (amount === null && n && proposedTerms.length > 0 && findingsFor(n.termId).some((f) => f.status !== "fits")) {
    const tied = deal.package.find((t) => t.termId === n.termId);
    if (tied && "amount" in tied.value) amount = tied.value.amount as number;
  }
  plan.respondingTo = amount;
  if (interp.offerTerms.length > 0) {
    const a = assessPackage(state, deal.package, context.locale);
    plan.assessment = a;
  }
  const declineReason = plan.declined.length > 0 ? " Requested changes to other terms are outside the mandate." : "";

  // Already waiting on the principal: repeating acceptance changes nothing.
  if (state.status === "awaiting_approval" && amount === null && plan.declined.length === 0 && extras.length === 0) {
    return { ...plan, move: "await_approval", action: "wait", decision: { kind: "hold", reason: "Waiting for the principal's approval." } };
  }

  // Accepting the stated terms, with nothing changed.
  if (interp.acceptsStatedTerms && amount === null && plan.declined.length === 0 && extras.length === 0 && plan.unresolved.length === 0) {
    const final = state.pendingFinal;
    if (final && final.communicated && clearedNow(state, final.offerId, final.termsHash)) {
      plan.assessment = assessPackage(state, final.terms, context.locale);
      if (view.acceptRequiresApproval && !approvedFor(state, final.termsHash)) {
        return { ...plan, move: "request_approval", action: "accept", acceptanceOf: final, decision: { kind: "request_approval", reason: "Counterparty accepted the stated terms; the mandate requires the principal's approval." } };
      }
      return { ...plan, move: "confirm_agreement", action: "accept", acceptanceOf: final, decision: { kind: "record_agreement", reason: "Counterparty accepted the stated terms; the mandate allows accepting." } };
    }
    return {
      ...plan,
      move: "state_final_terms",
      action: "propose",
      offer: { terms: finalPackage(view, state.currentAsk === null ? null : Math.max(state.currentAsk, n?.limit ?? -Infinity), packageExtras(state, extras)), basis: "final_terms" },
      decision: { kind: "state_final_terms", reason: "Counterparty agreed in principle; state the complete terms for confirmation." },
    };
  }

  // A condition the counterparty attached that the terms cannot express: settle it before committing.
  // (Term-level problems — a declined, unresolved or unclear term — are handled below and take precedence.)
  if ((interp.offerConditions ?? []).length > 0 && !context.conditionAsked && n && state.currentAsk !== null && plan.declined.length === 0 && plan.unresolved.length === 0 && plan.clarify.length === 0) {
    const ask = context.freshQuestions.find((q) => q.kind === "conditional" || q.kind === "authority");
    const condition = interp.offerConditions![0]!;
    return {
      ...holdAt(plan, view, state.currentAsk, packageExtras(state, extras), "The offer depends on a condition the counterparty has not settled; ask about it before committing."),
      action: "clarify",
      ask: ask ? { questionId: ask.questionId, text: ask.text } : null,
      strategyQuestion: ask ? undefined : { text: "What do you need to settle before you can commit to this?", kind: "conditional", purpose: `Learn when the counterparty's condition ("${condition.slice(0, 120)}") will be settled.`, key: `strategy:conditional:${condition.toLowerCase().slice(0, 120)}` },
    };
  }

  if (amount !== null && n && state.currentAsk !== null) {
    const atLeast = (x: number, y: number) => (n.direction === "up" ? x >= y : x <= y);
    const ask = atLeast(state.currentAsk, n.limit) ? state.currentAsk : n.limit;
    const q = g.increment ?? niceStep(n.opening);
    const keep = packageExtras(state, extras);
    const limit = applicableLimit(state.space, n.termId, deal.package)?.amount ?? n.limit;
    const settled = !findingsFor(n.termId).some((f) => f.status === "needs_clarification" && f.basis === "condition");
    if (!settled && !atLeast(amount, n.limit)) {
      return { ...plan, action: "clarify", decision: { kind: "answer", reason: "The offer depends on a detail the counterparty has not given; ask for it." } };
    }

    // Closing rule: an offer at or beyond the lower of the current ask and the principal's target.
    const target = principalTarget(state, n.termId);
    const closeAt = target !== null && atLeast(target, limit) && !atLeast(target, ask) ? target : ask;
    if (atLeast(amount, closeAt)) {
      return finalAt(plan, view, atLeast(amount, ask) ? ask : amount, keep, `Offer meets ${closeAt === ask ? "the current ask" : "the principal's target"}; state complete terms.${declineReason}`);
    }
    if (!n.canConcede) {
      return holdAt(plan, view, ask, keep, `No authority to move from the current ask.${declineReason}`);
    }

    const repeated = state.counterpartyAmounts.slice(0, -1).includes(amount);
    const countersLeft = g.maxCounteroffers === null || state.countersMade < g.maxCounteroffers;

    // Pressure: a stated final offer is evaluated, never pushed back on.
    const finalOffer = interp.pressure === "final_offer";

    // A new non-price obstacle: understand it before conceding on price.
    const obstacle = context.freshQuestions.find((x) => ["budget_scope", "obstacle", "authority"].includes(x.kind) || (x.kind === "conditional" && !context.conditionAsked));
    if (g.askBeforeConceding && obstacle && !finalOffer) {
      return {
        ...holdAt(plan, view, ask, keep, obstacle.kind === "conditional" ? "The offer depends on a condition the counterparty has not settled; ask about it before committing." : "The counterparty gave a non-price reason; ask about it before changing the price."),
        action: obstacle.kind === "conditional" ? "clarify" : "ask",
        ask: { questionId: obstacle.questionId, text: obstacle.text },
      };
    }

    if (!atLeast(amount, limit)) {
      if (ask === limit) {
        const binding = applicableLimit(state.space, n.termId, deal.package);
        const candidate = finalPackage(view, amount, keep);
        const alreadyRejected = state.approvals.some((a) => a.decision === "rejected" && a.termsHash === hashTerms(candidate) && a.mandateRevision === state.mandateRevision);
        if (binding && !alreadyRejected && view.authority.exceptionFor(binding.ruleId) === "with_approval" && state.counterpartyAmounts.slice(0, -1).length > 0) {
          return { ...finalAt(plan, view, amount, keep, `Offer is outside the limit; the mandate allows asking the principal for an exception.${declineReason}`), action: "request_approval" };
        }
        // At the limit no counteroffer is left to give: after the counterparty stays below it a second
        // time (or calls an offer final), no permitted package works.
        if ((!countersLeft || finalOffer || state.offersSinceAsk >= 2) && g.walkAwayAfterMaxCounteroffers) {
          return endWith(plan, "agent", "No permitted package works for the counterparty's terms.", unresolvedTerms(state, deal), g.walkAwayLine);
        }
        return holdAt(plan, view, ask, keep, `Offer is outside the limit; the offer stays where it is.${declineReason}`);
      }
      if (!countersLeft) {
        if (g.walkAwayAfterMaxCounteroffers) return endWith(plan, "agent", "The last counteroffer was made and no permitted package works.", unresolvedTerms(state, deal), g.walkAwayLine);
        return holdAt(plan, view, ask, keep, "No counteroffers left; the offer stays where it is.");
      }
      if (repeated) return holdAt(plan, view, ask, keep, "A repeated offer earns no further reduction.");
      const next = concede(state, g, n, ask, limit, amount, q);
      return next.value === ask ? holdAt(plan, view, ask, keep, "No permitted step fits; the offer stays where it is.") : counterAt(plan, view, next.value, keep, `Offer is outside the limit; counter without revealing it.${declineReason}`, next.tactic);
    }

    // Inside the limit but below the closing point.
    if (!countersLeft || finalOffer || repeated) {
      return finalAt(plan, view, amount, keep, `${finalOffer ? "A stated final offer" : repeated ? "A repeated offer" : "After the last counteroffer, an offer"} within the mandate; state complete terms.${declineReason}`);
    }
    if (g.concessionSteps.length === 0) {
      // No approved steps: close when the gap is one increment or after two counters, else meet in the middle.
      if (state.countersMade >= 2 || Math.abs(ask - amount) <= q) return finalAt(plan, view, amount, keep, `Offer is within the mandate; state complete terms.${declineReason}`);
      const middle = roundUp((ask + amount) / 2, q, n.direction);
      if (middle === ask || middle === amount) return finalAt(plan, view, amount, keep, `Offer is within the mandate; state complete terms.${declineReason}`);
      return counterAt(plan, view, middle, keep, `Offer is within the mandate but below the ask; counter in between.${declineReason}`, "halve_distance");
    }
    if (g.splitTheDifference && !state.splitUsed && keep.length === 0 && plan.declined.length === 0) {
      const middle = roundUp((ask + amount) / 2, q, n.direction);
      if (atLeast(middle, amount) && middle !== amount && !atLeast(middle, ask) && Math.abs(ask - middle) <= stepCap(state, g, ask)) {
        return counterAt(plan, view, middle, keep, "Only price is open: split the difference once.", "split_difference");
      }
    }
    const next = concede(state, g, n, ask, limit, amount, q);
    if (next.value === ask) return holdAt(plan, view, ask, keep, "No permitted step fits; the offer stays where it is.");
    if (atLeast(amount, next.value)) return finalAt(plan, view, amount, keep, `Offer is within the mandate; state complete terms.${declineReason}`);
    return counterAt(plan, view, next.value, keep, `Offer is within the mandate but below the ask; counter.${declineReason}`, next.tactic);
  }

  // A change to another term with no new price: the earlier decision no longer applies. Restate
  // the complete package with the change, at a price the changed package still permits.
  if (amount === null && extras.length > 0 && n && state.currentAsk !== null && !interp.acceptsStatedTerms) {
    const atLeast = (x: number, y: number) => (n.direction === "up" ? x >= y : x <= y);
    const keep = packageExtras(state, extras);
    const stated = state.pendingFinal ? state.pendingFinal.terms.find((t) => t.termId === n.termId) : undefined;
    const base = stated && "amount" in stated.value ? (stated.value.amount as number) : state.currentAsk;
    const limit = applicableLimit(state.space, n.termId, finalPackage(view, base, keep))?.amount ?? n.limit;
    const at = atLeast(base, limit) ? base : atLeast(state.currentAsk, limit) ? state.currentAsk : limit;
    const why = `The counterparty changed ${extras.map((t) => nameOf(t.termId)).join(", ")}; the earlier terms no longer apply.${declineReason}`;
    return state.pendingFinal ? finalAt(plan, view, at, keep, why) : holdAt(plan, view, at, keep, why);
  }

  if (plan.declined.length > 0) {
    return { ...plan, action: "decline", decision: { kind: "decline_request", reason: "Requested term changes are outside the mandate." } };
  }
  if (plan.unresolved.length > 0) {
    return { ...plan, action: "answer", decision: { kind: "answer", reason: "The request is not covered by the mandate; take it to the principal without promising anything." } };
  }
  if (plan.clarify.length > 0) {
    return { ...plan, action: "clarify", decision: { kind: "answer", reason: "A detail the terms depend on is missing; ask for it." } };
  }
  if (interp.asksPrivateInfo) {
    // "What's your lowest?": restate the current package, disclose nothing, and ask what would work.
    const probe = g.pressureQuestions.lowestPrice;
    const restated = n && state.currentAsk !== null ? holdAt(plan, view, state.currentAsk, packageExtras(state, []), "Private limits are never disclosed; restate the current offer.") : { ...plan, decision: { kind: "decline_request" as const, reason: "Private limits are never disclosed." } };
    // With guidance for "what's your lowest?", restating the offer and asking what works is the whole
    // answer: no refusal line (which itself hints at a hidden number) and no "I'll check" for it.
    const guided = Boolean(probe) && interp.pressure === "lowest_price" && restated.offer !== null;
    return {
      ...restated,
      refuseDisclosure: guided ? false : restated.refuseDisclosure,
      questions: guided ? [] : restated.questions,
      action: probe ? "ask" : "decline",
      strategyQuestion: probe ? { text: probe, kind: "terms_probe", purpose: "Learn what price and terms the counterparty can accept." } : undefined,
    };
  }
  // They declined to answer a question: accept that, don't ask again, and leave the current offer open.
  if ((interp.answers ?? []).some((a) => a.resolution === "refused") && interp.offerTerms.length === 0 && n && state.currentAsk !== null && state.status === "active" && plan.questions.length === 0) {
    return { ...holdAt(plan, view, state.currentAsk, packageExtras(state, []), "They preferred not to answer; the current offer stays open."), action: "answer", acknowledge: "No problem." };
  }

  // An objection with no new terms ("that's too much because ..."): the current offer stands.
  const objects = interp.intent === "reject" || (interp.notes ?? []).some((x) => x.kind === "reason" || x.kind === "constraint");
  if (objects && n && state.currentAsk !== null && interp.questions.length === 0 && interp.pressure !== "cheaper_elsewhere" && state.status === "active") {
    return holdAt(plan, view, state.currentAsk, packageExtras(state, []), "The counterparty objected without new terms; the current offer stands.");
  }
  if (interp.pressure === "cheaper_elsewhere" && g.pressureQuestions.cheaperElsewhere) {
    return { ...plan, action: "ask", strategyQuestion: { text: g.pressureQuestions.cheaperElsewhere, kind: "comparison", purpose: "Check whether the cheaper option is comparable before treating it as relevant." }, decision: { kind: "answer", reason: "A cheaper option was cited; compare before reacting." } };
  }
  return plan;
}

function endWith(plan: Plan, requestedBy: "counterparty" | "agent", reason: string, unresolved: string[], line: string | null): Plan {
  return { ...plan, move: "end_negotiation", action: "end", offer: null, questions: [], unresolved: [], clarify: [], declined: [], end: { requestedBy, reason, unresolved, line }, decision: { kind: "end", reason } };
}

/** The principal's stated target on a term, if any. Never invented. */
function principalTarget(state: NegotiationState, termId: string): number | null {
  const t = state.view.mandate.targets.find((x) => x.partyId === state.view.principalId && x.termId === termId && x.conditionIds.length === 0 && x.value && "amount" in x.value);
  return t?.value && "amount" in t.value ? (t.value.amount as number) : null;
}

/** What is still open, by term name, for a no-agreement record. */
function unresolvedTerms(state: NegotiationState, deal: DealInput): string[] {
  const out = new Set<string>();
  for (const f of deal.check.findings) if (f.status !== "fits") out.add(f.termName);
  const n = state.view.negotiable;
  if (n) out.add(n.name);
  return [...out].slice(0, 10);
}

/**
 * The next counteroffer on the negotiable term. With guidance steps: the next approved step,
 * kept smaller than the previous actual reduction, capped so it never passes max(limit, their
 * amount), rounded to the increment. Without steps: halve the distance to the limit. Never past the limit.
 */
function concede(state: NegotiationState, g: StrategyGuidance, n: NegotiableTerm, ask: number, limit: number, amount: number, q: number): { value: number; tactic: Tactic } {
  const up = n.direction === "up";
  const tactic: Tactic = g.concessionSteps.length > 0 ? "concession_step" : "halve_distance";
  const floor = up ? Math.max(limit, amount) : Math.min(limit, amount);
  const room = Math.abs(ask - floor);
  if (room <= 0) return { value: ask, tactic };
  if (g.concessionSteps.length === 0) {
    // Halve the distance to the limit, rounded in the principal's favour; never past the limit.
    const half = roundUp(up ? ask - (ask - limit) / 2 : ask + (limit - ask) / 2, q, n.direction);
    const next = up ? Math.max(limit, half) : Math.min(limit, half);
    return { value: next === ask ? limit : next, tactic };
  }
  const reduction = Math.floor(Math.min(stepCap(state, g, ask), room) / q) * q;
  if (reduction <= 0) return { value: ask, tactic };
  const next = up ? ask - reduction : ask + reduction;
  return { value: up ? Math.max(limit, next) : Math.min(limit, next), tactic };
}

/** The largest reduction the next step allows: the next approved step, and smaller than the last actual reduction. */
function stepCap(state: NegotiationState, g: StrategyGuidance, ask: number): number {
  if (g.concessionSteps.length === 0) return Number.POSITIVE_INFINITY;
  const reductions = state.askHistory.slice(1).map((a, i) => Math.abs(state.askHistory[i]! - a));
  const step = g.concessionSteps[Math.min(reductions.length, g.concessionSteps.length - 1)]!;
  const previous = reductions.at(-1);
  void ask;
  return previous !== undefined ? Math.min(step, Math.max(0, previous - 1)) : step;
}

function roundUp(value: number, q: number, direction: "up" | "down"): number {
  return direction === "up" ? Math.ceil(value / q) * q : Math.floor(value / q) * q;
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
  return { ...plan, move: "state_final_terms", action: "propose", offer: { terms: finalPackage(view, amount, extras), basis: "final_terms" }, decision: { kind: "state_final_terms", reason } };
}

function counterAt(plan: Plan, view: MandateView, amount: number, extras: OfferTerm[], reason: string, tactic: Tactic | null = null): Plan {
  return { ...plan, move: "counter", action: "counter", offer: { terms: finalPackage(view, amount, extras), basis: "counter", tactic }, decision: { kind: "counter", reason } };
}

function holdAt(plan: Plan, view: MandateView, amount: number, extras: OfferTerm[], reason: string): Plan {
  return { ...plan, move: "hold", action: "decline", offer: { terms: finalPackage(view, amount, extras), basis: "counter" }, decision: { kind: "hold", reason } };
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
