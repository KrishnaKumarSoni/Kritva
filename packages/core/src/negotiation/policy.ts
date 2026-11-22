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
import { packageKey, type CounterpartyModel } from "../counterparty/model.ts";
import { includedBudgetCost } from "../counterparty/questions.ts";
import { numericValue, violatesFixedRule, withTerm, type MandateView, type NegotiableTerm } from "./mandate-view.ts";
import { applicableTarget, assessPackage, type Assessment } from "../strategy/assess.ts";
import type { AllowanceLedger } from "../strategy/allowance.ts";
import { MINIMAL_GUIDANCE, type StrategyGuidance } from "../strategy/guidance.ts";
import { approvedFor, clearedNow, publicDealTerms, type NegotiationState, type StatedOffer } from "./state.ts";

export type PublicTermQuestion = { termId: string; basis: "current" | "opening" };

export interface Interpretation {
  intent: "offer" | "accept_stated_terms" | "question" | "request_change" | "reject" | "greeting" | "other";
  /** Terms the counterparty proposed or asked to change, already mapped to mandate terms. */
  offerTerms: OfferTerm[];
  acceptsStatedTerms: boolean;
  asksPrivateInfo: boolean;
  claimsAuthority: boolean;
  questions: string[];
  publicTermQuestions?: PublicTermQuestion[];
  /** Things the counterparty asked for that no mandate term covers (e.g. an added service). */
  newTerms: Array<{ name: string; description: string | null; value: Value | null }>;
  /** Needs, constraints, reasons, claims and the like, each with the counterparty's exact words. */
  notes?: Array<{ kind: string; quote: string; summary: string; termId: string | null; value: Value | null; condition: string | null; basis: "stated" | "inferred" }>;
  /** Answers to questions the agent asked earlier. */
  answers?: Array<{ questionId: string; quote: string | null; resolution: "answered" | "partial" | "refused" }>;
  /** Whether an amount is a committed offer, a question about a price, or only interest. */
  offerKind?: "offer" | "enquiry" | "interest" | "budget_ceiling";
  priceConcern?: "objection" | "value_question" | null;
  asksIfOpen?: boolean;
  isConsidering?: boolean;
  /** Conditions the counterparty attached that the terms cannot express. */
  offerConditions?: string[];
  /** The counterparty corrects their previous offer ("sorry, I meant X"). */
  correctsPrevious?: boolean;
  /** The counterparty declines to continue or withdraws. */
  endsNegotiation?: boolean;
  /** A pressure move: asking for the lowest price, calling an offer final, or citing a cheaper option. */
  pressure?: "none" | "lowest_price" | "final_offer" | "cheaper_elsewhere";
  /** Follow-up details, read only while an offer waits for the principal. */
  followUp?: {
    validUntil: string | null;
    validity: string | null;
    contact: "chat" | "call" | "whatsapp" | null;
    phone: string | null;
    useThisNumber: boolean;
    bestTime: string | null;
    keepContact: boolean | null;
    declined: Array<"validity" | "contact" | "time">;
  };
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
  | "answer_public_terms"
  | "explore_objection"
  | "explain_price"
  | "acknowledge_budget"
  | "answer_enquiry"
  | "price_pressure"
  | "compare_terms"
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
  strategyQuestion?: { text: string; kind: "terms_probe" | "comparison" | "conditional" | "obstacle" | "follow_up"; purpose: string; key?: string };
  /**
   * The approval wrap-up or follow-up step this reply carries out. Wrap-up (after the counterparty
   * accepts terms that need approval): ask how long the offer stands, how and when to reach them,
   * then close by saying nothing is final yet. Follow-up (after the principal decides): approved,
   * countered or declined, and their answer to keeping in touch.
   */
  followUp?: {
    step: "validity" | "contact" | "phone" | "close" | "approved" | "countered" | "declined" | "keep_contact";
    /** The offer the wrap-up is for. */
    offerId?: string;
    /** The offer's stated time has passed: ask whether it still stands before anything else. */
    expired?: boolean;
    /** Kritva is calling them back: say who is calling and why first. */
    callBack?: boolean;
    contact?: "chat" | "call" | "whatsapp" | null;
    /** Words the principal asked to pass on. */
    messageFromPrincipal?: string | null;
  };
  /** On a call: hang up once this reply has been heard. */
  endCall?: boolean;
  /** The counterparty's own offer, recapped as theirs while the principal is asked for an exception. */
  recap?: OfferTerm[];
  decision: { kind: DecisionKind; reason: string };
  offer: { terms: OfferTerm[]; basis: "counter" | "final_terms"; tactic?: Tactic | null } | null;
  /** Stated terms the counterparty just accepted. */
  acceptanceOf: StatedOffer | null;
  declined: Array<{ termId: string; requested: Value }>;
  refuseDisclosure: boolean;
  ignoreAuthorityClaim: boolean;
  questions: string[];
  /** Values read from public positions, without making or changing an offer. */
  publicTermAnswers?: Array<OfferTerm & PublicTermQuestion>;
  /** The counterparty amount this move responds to, if any. */
  respondingTo: number | null;
  /** Something the reply must tell the counterparty first. */
  notice: "approval_rejected" | "terms_changed" | "rephrase" | "check_with_principal" | "paused" | "ended" | null;
  /** Term names to ask the counterparty about (missing details a rule depends on). Values are never suggested. */
  clarify: string[];
  /** Requests the mandate does not address: taken to the principal, never promised or priced. */
  unresolved: string[];
  /** A prepared question to ask (selection is a placeholder until strategy, Epic 8). */
  ask: { questionId: string; text: string; purpose?: string } | null;
  /** Public asking value already in effect, cited without making a new offer. */
  referenceAmount?: number;
  /** The amount the counterparty stated as a ceiling on this turn. */
  statedBudget?: number;
  /** The amount the counterparty asked about without committing to it. */
  enquiredAmount?: number;
  /** Public facts selected for a grounded explanation of the current terms. */
  explanationFacts?: string[];
  openForDiscussion?: boolean;
  listingAvailable?: boolean;
  /** A short acknowledgment to open with (for example after they decline to answer a question). */
  acknowledge?: string;
  /** First reply of the session: Kritva introduces itself once as the principal's assistant. */
  introduce?: boolean;
  /** Starts a conversation before the counterparty has spoken. */
  opening?: boolean;
  /** An explicit principal approval is on record for these terms. */
  approvalGranted?: boolean;
  /** How many replies the agent has sent before this one; varies fallback wording. */
  turnIndex?: number;
  /** The discount allowance ledger the move was decided under (private, for the decision record). */
  allowance?: AllowanceLedger | null;
}

/** What the strategy can see beyond the turn: guidance, and questions this turn prepared. */
export interface StrategyContext {
  guidance: StrategyGuidance;
  /** Questions prepared from this message (e.g. about a non-price obstacle), not yet asked. */
  freshQuestions: Array<{ questionId: string; text: string; kind: string; purpose?: string }>;
  counterparty?: Pick<CounterpartyModel, "estimates" | "offers" | "questions"> & Partial<Pick<CounterpartyModel, "items">>;
  listingAvailable?: boolean;
  /** Discount the counterparty's commitments have earned and not yet used. Absent: no allowance cap. */
  allowance?: AllowanceLedger | null;
  locale: string;
}

const DEFAULT_CONTEXT: StrategyContext = { guidance: MINIMAL_GUIDANCE, freshQuestions: [], locale: "en" };

function commitmentProbe(state: NegotiationState, context: StrategyContext): Plan["strategyQuestion"] {
  const term = state.view.negotiable;
  if (!term || term.valueType !== "money" || term.direction !== "up" || state.currentAsk === null) return;
  const terms = publicDealTerms(state);
  const key = packageKey(terms.filter((entry) => entry.termId !== term.termId));
  const estimate = context.counterparty?.estimates.find((entry) => entry.packageKey === key)
    ?? context.counterparty?.estimates.find((entry) => entry.packageKey === "");
  const note = estimate?.statedMaximum;
  if (!estimate || !note || (note.termId && note.termId !== term.termId) || note.value?.type !== "money"
    || note.value.currency !== term.currency || estimate.maximum.status !== "working_estimate"
    || includedBudgetCost(note.quote, note.condition, term.name)) return;
  const floor = applicableLimit(state.space, term.termId, terms)?.amount ?? term.limit;
  if (estimate.maximum.atMost < floor) return;
  const issueKey = `strategy:commitment:${term.termId}:${key}`;
  if (context.counterparty?.questions.some((question) => question.issueKey === issueKey && question.status !== "open")) return;
  return { key: issueKey, kind: "terms_probe", text: "Would you make a firm offer on the current terms?", purpose: "Find out if the counterparty will make a firm offer on the current package. Their budget is already known. Do not suggest a new price or ask them to repeat their budget." };
}

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
    // Their answer to "can I keep your number in case anything changes?" after the principal declined.
    const keepKey = keepContactKey(state);
    const keepAsked = keepKey !== null && context.counterparty?.questions.some((q) => q.issueKey === keepKey && q.status !== "open");
    if (keepAsked && interp.followUp && interp.followUp.keepContact !== null) {
      return { ...plan, move: "closed", action: "answer", notice: null, refuseDisclosure: false, questions: [], unresolved: [], followUp: { step: "keep_contact" }, endCall: true, decision: { kind: "answer", reason: "They answered whether they may be contacted again; thank them and close." } };
    }
    return { ...plan, move: "closed", action: "answer", notice: "ended", refuseDisclosure: false, questions: [], unresolved: [], decision: { kind: "answer", reason: "The negotiation ended without agreement; nothing is offered." } };
  }

  const tentative = interp.offerKind === "enquiry" || interp.offerKind === "interest" || interp.offerKind === "budget_ceiling";
  const budget = interp.notes?.findLast((note) => note.kind === "budget" && note.basis === "stated" && note.value?.type === "money")?.value;
  const referenceAmount = state.currentAsk ?? undefined;
  const comparesCheaperOption = interp.pressure === "cheaper_elsewhere" || interp.notes?.some((note) =>
    note.kind === "alternative" && note.basis === "stated" && note.value?.type === "money" && note.value.currency === n?.currency
      && referenceAmount !== undefined && note.value.amount < referenceAmount);

  // The counterparty declines to continue: end without agreement, and say so plainly. A final offer
  // that still puts terms on the table is an offer, not a withdrawal.
  if (interp.endsNegotiation && !(!tentative && interp.offerTerms.length > 0 && interp.pressure === "final_offer")) {
    return endWith(plan, "counterparty", "The counterparty declined to continue.", unresolvedTerms(state, deal), null);
  }
  if (interp.isConsidering && !interp.acceptsStatedTerms && interp.offerTerms.length === 0 && plan.questions.length === 0 && !interp.publicTermQuestions?.length) {
    return { ...plan, action: "wait", acknowledge: "Take your time. Let me know if you'd like to continue.", decision: { kind: "hold", reason: "The counterparty asked for time to consider." } };
  }

  // When the counterparty accepts, values that merely repeat the stated terms are not changes.
  const stated = state.pendingFinal ?? state.lastProposed;
  const proposedTerms = !tentative && interp.acceptsStatedTerms && stated
    ? interp.offerTerms.filter((t) => {
        const s = stated.terms.find((x) => x.termId === t.termId);
        return !s || JSON.stringify(s.value) !== JSON.stringify(t.value);
      })
    : interp.offerTerms.filter((t) => !tentative || t.termId !== n?.termId);

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
  if (!tentative && amount === null && n && proposedTerms.length > 0 && findingsFor(n.termId).some((f) => f.status !== "fits")) {
    const tied = deal.package.find((t) => t.termId === n.termId);
    if (tied && "amount" in tied.value) amount = tied.value.amount as number;
  }
  plan.respondingTo = amount;
  if (!tentative && interp.offerTerms.length > 0) {
    const a = assessPackage(state, deal.package, context.locale);
    plan.assessment = a;
  }
  const declineReason = plan.declined.length > 0 ? " Requested changes to other terms are outside the mandate." : "";

  // Already waiting on the principal: repeating acceptance changes nothing. The wrap-up carries on.
  if (state.status === "awaiting_approval" && amount === null && plan.declined.length === 0 && extras.length === 0) {
    return withWrapUp({ ...plan, move: "await_approval", action: "wait", decision: { kind: "hold", reason: "Waiting for the principal's approval." } }, state, state.pendingApproval?.offerId ?? null, context);
  }

  // Accepting the stated terms, with nothing changed.
  if (!tentative && interp.acceptsStatedTerms && amount === null && plan.declined.length === 0 && extras.length === 0 && plan.unresolved.length === 0 && plan.clarify.length === 0 && (interp.offerConditions?.length ?? 0) === 0) {
    const final = state.pendingFinal;
    if (final && final.communicated && clearedNow(state, final.offerId, final.termsHash)) {
      plan.assessment = assessPackage(state, final.terms, context.locale);
      if (view.acceptRequiresApproval && !approvedFor(state, final.termsHash)) {
        return withWrapUp({ ...plan, move: "request_approval", action: "accept", acceptanceOf: final, decision: { kind: "request_approval", reason: "Counterparty accepted the stated terms; the mandate requires the principal's approval." } }, state, final.offerId, context);
      }
      // After a follow-up, their yes closes the deal, and a call ends once the agreement is said.
      const approved = Boolean(approvedFor(state, final.termsHash));
      return { ...plan, move: "confirm_agreement", action: "accept", acceptanceOf: final, endCall: approved, decision: { kind: "record_agreement", reason: approved ? "Counterparty accepted the terms again after the principal approved them." : "Counterparty accepted the stated terms; the mandate allows accepting." } };
    }
    return {
      ...plan,
      move: "state_final_terms",
      action: "propose",
      offer: { terms: finalPackage(view, state.currentAsk === null ? null : Math.max(state.currentAsk, n?.limit ?? -Infinity), packageExtras(state, extras)), basis: "final_terms" },
      decision: { kind: "state_final_terms", reason: "Counterparty agreed in principle; state the complete terms for confirmation." },
    };
  }

  // Non-commitments can raise relevant questions but cannot move the offer or start approval.
  if (tentative || (budget?.type === "money" && amount === null && interp.offerTerms.length === 0)) {
    if (plan.declined.length > 0) return { ...plan, action: "decline", decision: { kind: "decline_request", reason: "Requested term changes are outside the mandate." } };
    // A stated budget below the current ask is their position, not a commitment. Never accept it, but keep
    // the negotiation moving: one permitted step toward it and a nudge to meet it. A "would you take X?" is
    // a probe, so it gets no step (concessions answer firm offers): it gets a nudge for a firm offer instead.
    const enquired = interp.offerKind === "enquiry" ? interp.offerTerms.find((t) => t.termId === n?.termId)?.value : undefined;
    if (!enquired && budget?.type === "money" && budget.currency === n?.currency) {
      const toward = towardPosition(plan, state, g, deal, context, budget.amount, "budget");
      if (toward) return toward;
    }
    if (interp.offerKind === "enquiry" && interp.offerTerms.length > 0) {
      const queried = interp.offerTerms.find((t) => t.termId === n?.termId)?.value;
      const enquiredAmount = queried && "amount" in queried ? (queried.amount as number) : undefined;
      // Below the current price: invite a firm offer, once, rather than only restating the price.
      const below = enquiredAmount !== undefined && referenceAmount !== undefined && n && (n.direction === "up" ? enquiredAmount < referenceAmount : enquiredAmount > referenceAmount);
      const nudgeKey = "strategy:firm_offer_after_enquiry";
      const nudged = context.counterparty?.questions.some((question) => question.issueKey === nudgeKey && question.status !== "open");
      const nudge = below && !nudged && plan.clarify.length === 0 && plan.unresolved.length === 0
        ? { key: nudgeKey, kind: "terms_probe" as const, text: "What's the best firm offer you can make?", purpose: "Their figure is below the current price. Invite a firm offer closer to it. Do not name a new amount or accept theirs." }
        : undefined;
      return { ...plan, move: "answer_enquiry", referenceAmount, enquiredAmount, questions: [], ...(nudge ? { action: "ask" as const, strategyQuestion: nudge } : {}), decision: { kind: "answer_enquiry", reason: "Respond to an enquiry without treating it as a committed offer." } };
    }
    if (budget?.type === "money") {
      const question = context.freshQuestions.find((q) => q.kind === "budget_scope");
      const followUp = question ? undefined : commitmentProbe(state, context);
      return {
        ...plan, move: "acknowledge_budget", questions: [], referenceAmount, statedBudget: budget.amount,
        action: question || followUp ? "ask" : "answer", ask: question ?? null, strategyQuestion: followUp,
        decision: { kind: "acknowledge_budget", reason: followUp ? "The stated ceiling leaves possible overlap on this package; ask whether the counterparty is willing to make an offer." : "Record the budget as a constraint without treating it as willingness to transact." },
      };
    }
    if (tentative && proposedTerms.length > 0) return plan;
  }

  // A condition the counterparty attached that the terms cannot express: settle it before committing.
  // (Term-level problems — a declined, unresolved or unclear term — are handled below and take precedence.)
  if ((interp.offerConditions ?? []).length > 0 && n && state.currentAsk !== null && plan.declined.length === 0 && plan.unresolved.length === 0 && plan.clarify.length === 0) {
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
    const target = applicableTarget(state, n.termId, deal.package);
    const closeAt = target !== null && atLeast(target, limit) && !atLeast(target, ask) ? target : ask;
    if (atLeast(amount, closeAt)) {
      if (plan.declined.length > 0 || plan.unresolved.length > 0 || plan.clarify.length > 0) {
        return { ...plan, action: plan.declined.length > 0 ? "decline" : "clarify", decision: { kind: "decline_request", reason: "The price fits but the package depends on terms that cannot be accepted as stated." } };
      }
      return finalAt(plan, view, atLeast(amount, ask) ? ask : amount, keep, `Offer meets ${closeAt === ask ? "the current ask" : "the principal's target"}; state complete terms.${declineReason}`);
    }
    if (!n.canConcede) {
      return holdAt(plan, view, ask, keep, `No authority to move from the current ask.${declineReason}`);
    }

    const currentPackageKey = packageKey(deal.package.filter((term) => term.termId !== n.termId));
    const repeated = context.counterparty
      ? context.counterparty.offers.slice(0, -1).some((offer) => offer.amount === amount && offer.packageKey === currentPackageKey)
      : state.counterpartyAmounts.slice(0, -1).includes(amount);
    const countersLeft = g.maxCounteroffers === null || state.countersMade < g.maxCounteroffers;

    // Pressure: a stated final offer is evaluated, never pushed back on.
    const finalOffer = interp.pressure === "final_offer";

    // A new non-price obstacle: understand it before conceding on price.
    const obstacle = context.freshQuestions.find((x) => ["budget_scope", "obstacle", "authority"].includes(x.kind));
    if (g.askBeforeConceding && obstacle && !finalOffer) {
      return {
        ...holdAt(plan, view, ask, keep, "The counterparty gave a non-price reason; ask about it before changing the price."),
        action: "ask",
        ask: { questionId: obstacle.questionId, text: obstacle.text },
      };
    }

    if (!atLeast(amount, limit)) {
      if (ask === limit) {
        const binding = applicableLimit(state.space, n.termId, deal.package);
        const candidate = finalPackage(view, amount, keep);
        const alreadyRejected = state.approvals.some((a) => a.decision !== "approved" && a.termsHash === hashTerms(candidate) && a.mandateRevision === state.mandateRevision);
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
      if (noAllowance(context)) return holdAt(plan, view, ask, keep, "No new commitment from the counterparty: no unused discount allowance, so the offer stays where it is.");
      const next = concede(state, g, n, ask, limit, amount, q, allowanceCap(context));
      return next.value === ask ? holdAt(plan, view, ask, keep, "No permitted step fits; the offer stays where it is.") : counterAt(plan, view, next.value, keep, `Offer is outside the limit; counter without revealing it.${declineReason}`, next.tactic);
    }

    // Inside the limit but below the closing point.
    if (!countersLeft || finalOffer || repeated) {
      return finalAt(plan, view, amount, keep, `${finalOffer ? "A stated final offer" : repeated ? "A repeated offer" : "After the last counteroffer, an offer"} within the mandate; state complete terms.${declineReason}`);
    }
    if (g.concessionSteps.length === 0) {
      // No approved steps: close when the gap is one increment or after two counters, else meet in the middle.
      if (state.countersMade >= 2 || Math.abs(ask - amount) <= q) return finalAt(plan, view, amount, keep, `Offer is within the mandate; state complete terms.${declineReason}`);
      const cap = allowanceCap(context);
      const halfway = roundUp((ask + amount) / 2, q, n.direction);
      // The midpoint never spends more than the unused allowance.
      const middle = Math.abs(ask - halfway) <= cap ? halfway : ask - towardSign(n) * Math.floor(cap / q) * q;
      if (middle === ask) return holdAt(plan, view, ask, keep, "No unused discount allowance fits a step; the offer stays where it is.");
      if (middle === amount) return finalAt(plan, view, amount, keep, `Offer is within the mandate; state complete terms.${declineReason}`);
      return counterAt(plan, view, middle, keep, `Offer is within the mandate but below the ask; counter in between.${declineReason}`, "halve_distance");
    }
    if (noAllowance(context)) return holdAt(plan, view, ask, keep, "No new commitment from the counterparty: no unused discount allowance, so the offer stays where it is.");
    if (g.splitTheDifference && !state.splitUsed && keep.length === 0 && plan.declined.length === 0) {
      const middle = roundUp((ask + amount) / 2, q, n.direction);
      if (atLeast(middle, amount) && middle !== amount && !atLeast(middle, ask) && Math.abs(ask - middle) <= Math.min(stepCap(state, g, ask), allowanceCap(context))) {
        return counterAt(plan, view, middle, keep, "Only price is open: split the difference once.", "split_difference");
      }
    }
    const next = concede(state, g, n, ask, limit, amount, q, allowanceCap(context));
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
  if (comparesCheaperOption && g.pressureQuestions.cheaperElsewhere) {
    const key = "strategy:compare_public_terms";
    const asked = context.counterparty?.questions.some((question) => question.issueKey === key && question.status !== "open");
    return {
      ...plan, move: "compare_terms", referenceAmount, action: asked ? "answer" : "ask", questions: [],
      explanationFacts: asked ? view.publicFacts.slice(0, 2) : undefined,
      strategyQuestion: asked ? undefined : { key, text: g.pressureQuestions.cheaperElsewhere, kind: "comparison", purpose: "Ask whether the other terms or obligations are comparable. Keep the alternative a counterparty claim and give no new price." },
      decision: { kind: "answer", reason: asked ? "The comparison question was already asked; use confirmed facts for the current package." : "Check whether the cited alternative is comparable before reacting." },
    };
  }
  // "What's your lowest?", "better rate?", or "is that your final price?" with no number of their own.
  const asksOurFinal = interp.pressure === "final_offer" && interp.offerTerms.length === 0 && !interp.acceptsStatedTerms;
  if ((interp.pressure === "lowest_price" || asksOurFinal) && referenceAmount !== undefined) {
    const probe = g.pressureQuestions.lowestPrice;
    const budgetKnown = context.counterparty?.estimates.some((entry) => entry.statedMaximum !== null);
    const stretchKey = "strategy:stretch";
    const stretchAsked = context.counterparty?.questions.some((question) => question.issueKey === stretchKey && question.status !== "open");
    // Their budget is below what works: ask, once, how far they can come up rather than restating the price alone.
    const stretch = stretchAsked ? undefined : { key: stretchKey, kind: "terms_probe" as const, text: "How close to that can you come?", purpose: "Their stated budget is below the current price. Ask how far they can come up toward the current price. Do not name a new price or reveal any limit." };
    const floorNow = n ? applicableLimit(state.space, n.termId, publicDealTerms(state))?.amount ?? n.limit : null;
    const budgetBelowFloor = n?.direction === "up" && floorNow !== null && context.counterparty?.estimates.some((entry) => entry.statedMaximum !== null && entry.maximum.status === "working_estimate" && entry.maximum.atMost < floorNow);
    const followUp = budgetKnown ? commitmentProbe(state, context) ?? (budgetBelowFloor ? stretch : undefined) : probe ? { text: probe, kind: "terms_probe" as const, purpose: "Learn what price and terms the counterparty is prepared to offer." } : undefined;
    return {
      ...plan, move: "price_pressure", referenceAmount, questions: [], refuseDisclosure: false,
      action: followUp ? "ask" : "answer", strategyQuestion: followUp,
      decision: { kind: "hold", reason: "Restate the public ask and seek a firm offer without making a concession or revealing private limits." },
    };
  }
  if (interp.asksPrivateInfo) return { ...plan, action: "decline", decision: { kind: "decline_request", reason: "Private limits and instructions cannot be disclosed." } };
  // They declined to answer a question: accept that, don't ask again, and leave the current offer open.
  if ((interp.answers ?? []).some((a) => a.resolution === "refused") && interp.offerTerms.length === 0 && n && state.currentAsk !== null && state.status === "active" && plan.questions.length === 0) {
    return { ...holdAt(plan, view, state.currentAsk, packageExtras(state, []), "They preferred not to answer; the current offer stays open."), action: "answer", acknowledge: "No problem." };
  }

  if (interp.asksIfOpen && state.status === "active" && proposedTerms.length === 0) {
    plan.openForDiscussion = context.listingAvailable !== false;
    plan.listingAvailable = context.listingAvailable;
    plan.decision = { kind: "answer", reason: "Answer availability from the public listing status and the negotiation state." };
  }
  if (interp.priceConcern === "value_question" && referenceAmount !== undefined) {
    return {
      ...plan, move: "explain_price", referenceAmount, explanationFacts: view.publicFacts.slice(0, 3), questions: [],
      decision: { kind: "explain_price", reason: "Explain what the current asking amount covers using confirmed public facts." },
    };
  }
  if (interp.publicTermQuestions?.length && amount === null && extras.length === 0 && !interp.acceptsStatedTerms && !interp.priceConcern) {
    const current = publicDealTerms(state);
    const publicTermAnswers = interp.publicTermQuestions.flatMap((question) => {
      const terms = question.basis === "opening" ? view.defaultPackage : current;
      const term = terms.find((t) => t.termId === question.termId);
      return term ? [{ ...term, basis: question.basis }] : [];
    });
    // Preserve the changed conditions that travel with a previously quoted price.
    if (publicTermAnswers.some((answer) => answer.basis === "current" && answer.value.type === "money"
      && state.lastCommunicated?.terms.some((term) => term.termId === answer.termId))) {
      for (const term of state.lastCommunicated!.terms) {
        if (!view.terms.has(term.termId) || publicTermAnswers.some((answer) => answer.termId === term.termId && answer.basis === "current")) continue;
        if (view.defaultPackage.some((opening) => opening.termId === term.termId && sameValue(opening.value, term.value))) continue;
        publicTermAnswers.push({ ...term, basis: "current" });
      }
    }
    if (publicTermAnswers.length > 0) {
      return { ...plan, move: "answer_public_terms", publicTermAnswers, decision: { kind: "answer", reason: "Answer from the confirmed public terms without making an offer." } };
    }
    if (plan.questions.length === 0) plan.questions = interp.publicTermQuestions.map((question) => nameOf(question.termId));
  }
  if (interp.priceConcern === "objection" && referenceAmount !== undefined && interp.pressure !== "cheaper_elsewhere") {
    const question = context.freshQuestions.find((q) => q.kind === "budget_scope" || q.kind === "obstacle");
    const hasBudget = context.counterparty?.estimates.some((entry) => entry.statedMaximum !== null) === true;
    // They already said it is about their budget: asking whether it is budget or value would repeat them.
    const reasonGiven = (interp.notes ?? []).some((note) => note.basis === "stated" && note.kind === "budget");
    if (reasonGiven && !context.freshQuestions.some((q) => q.kind === "budget_scope")) {
      return {
        ...plan, move: "explore_objection", action: "answer", referenceAmount, questions: [], ask: null,
        decision: { kind: "explore_objection", reason: "They gave the reason for the objection; acknowledge it and keep the current terms without asking again." },
      };
    }
    return {
      ...plan, move: "explore_objection", action: "ask", referenceAmount, questions: [], ask: question ?? null,
      strategyQuestion: question ? undefined : {
        text: hasBudget ? "Apart from price, what matters most to you about these terms?" : "Is the price above your budget, or is there something about the terms that makes it feel too high?",
        kind: "obstacle",
        purpose: hasBudget ? "Learn which other aspect of the package matters, without asking again for a known budget." : "Find out whether the objection is about their budget or the value of the package.",
        key: `strategy:${hasBudget ? "package_obstacle" : "price_objection"}:${n?.termId ?? "amount"}`,
      },
      decision: { kind: "explore_objection", reason: "Identify the source of the price objection before deciding whether to change terms." },
    };
  }

  // An objection with no new terms ("that's too much because ..."): the current offer stands.
  // A greeting ("Hi! I saw your ad") is never an objection, whatever note the reading attached to it.
  const objects = interp.intent === "reject" || (interp.intent !== "greeting" && (interp.notes ?? []).some((x) => x.kind === "reason" || x.kind === "constraint"));
  if (objects && n && state.currentAsk !== null && interp.questions.length === 0 && interp.pressure !== "cheaper_elsewhere" && state.status === "active") {
    return holdAt(plan, view, state.currentAsk, packageExtras(state, []), "The counterparty objected without new terms; the current offer stands.");
  }
  return plan;
}

/** Question keys for the wrap-up, so each detail is asked once. */
export const FOLLOW_UP_KEYS = {
  validity: (offerId: string) => `follow_up:validity:${offerId}`,
  contact: "follow_up:contact",
  phone: "follow_up:phone",
  keepContact: (responseId: string) => `follow_up:keep_contact:${responseId}`,
} as const;

function keepContactKey(state: NegotiationState): string | null {
  const d = state.followUp.decision;
  return d && d.decision === "declined" ? FOLLOW_UP_KEYS.keepContact(d.responseId) : null;
}

/**
 * The next wrap-up step for terms waiting on the principal: how long the offer stands, then how and
 * when to reach them (and a number when they want a call), then the closing line. Each detail is asked
 * at most once, a detail they already gave is not asked, and null means the wrap-up is done.
 */
export function wrapUpStep(state: NegotiationState, offerId: string, context: StrategyContext): NonNullable<Plan["followUp"]>["step"] | null {
  const f = state.followUp;
  const asked = (key: string) => context.counterparty?.questions.some((q) => q.issueKey === key && q.status !== "open") === true;
  // What they said about how long it stands carries over to a later round (a counter's new terms).
  const hasValidity = f.validUntil !== null || f.validity !== null;
  if (!hasValidity && !asked(FOLLOW_UP_KEYS.validity(offerId))) return "validity";
  if (f.contact === null && !asked(FOLLOW_UP_KEYS.contact)) return "contact";
  if ((f.contact === "call" || f.contact === "whatsapp") && f.phone === null && !asked(FOLLOW_UP_KEYS.phone)) return "phone";
  if (!f.closedOfferIds.includes(offerId)) return "close";
  return null;
}

const WRAP_UP_QUESTIONS = {
  validity: { text: "How long does your offer stand?", purpose: "Find out how long their offer stands, for example whether it is good till tonight. Ask only this. Never suggest it is agreed." },
  contact: { text: "What's the best way and time to reach you?", purpose: "Find out how they would like to hear back (a phone call, or here in this conversation) and what time suits them. Ask only this." },
  phone: { text: "What number should I call you on?", purpose: "Get the phone number to call them back on. Ask only this." },
} as const;

/** Adds the wrap-up step to a plan for terms waiting on the principal (no step: the plan is unchanged). */
function withWrapUp(plan: Plan, state: NegotiationState, offerId: string | null, context: StrategyContext): Plan {
  if (!offerId) return plan;
  const step = wrapUpStep(state, offerId, context);
  if (!step) return plan;
  const contact = state.followUp.contact;
  if (step === "close") return { ...plan, followUp: { step, offerId, contact }, endCall: true, questions: [] };
  const key = step === "validity" ? FOLLOW_UP_KEYS.validity(offerId) : step === "contact" ? FOLLOW_UP_KEYS.contact : FOLLOW_UP_KEYS.phone;
  const q = WRAP_UP_QUESTIONS[step as keyof typeof WRAP_UP_QUESTIONS];
  return { ...plan, followUp: { step, offerId, contact }, strategyQuestion: { key, kind: "follow_up", text: q.text, purpose: q.purpose } };
}

/** The question asked with a decline: may Kritva contact them again if anything changes. */
export function keepContactQuestion(responseId: string): NonNullable<Plan["strategyQuestion"]> {
  return { key: FOLLOW_UP_KEYS.keepContact(responseId), kind: "follow_up", text: "Can I keep your number in case anything changes?", purpose: "Ask whether you may contact them again if anything changes. Ask only this." };
}

function endWith(plan: Plan, requestedBy: "counterparty" | "agent", reason: string, unresolved: string[], line: string | null): Plan {
  return { ...plan, move: "end_negotiation", action: "end", offer: null, questions: [], unresolved: [], clarify: [], declined: [], end: { requestedBy, reason, unresolved, line }, decision: { kind: "end", reason } };
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
function concede(state: NegotiationState, g: StrategyGuidance, n: NegotiableTerm, ask: number, limit: number, amount: number, q: number, cap = Number.POSITIVE_INFINITY): { value: number; tactic: Tactic } {
  const up = n.direction === "up";
  const tactic: Tactic = g.concessionSteps.length > 0 ? "concession_step" : "halve_distance";
  const floor = up ? Math.max(limit, amount) : Math.min(limit, amount);
  const room = Math.abs(ask - floor);
  if (room <= 0 || cap <= 0) return { value: ask, tactic };
  if (g.concessionSteps.length === 0) {
    // Halve the distance to the limit, rounded in the principal's favour; never past the limit.
    const half = roundUp(up ? ask - (ask - limit) / 2 : ask + (limit - ask) / 2, q, n.direction);
    let next = up ? Math.max(limit, half) : Math.min(limit, half);
    if (next === ask) next = limit;
    // Never spend more than the unused allowance.
    if (Math.abs(ask - next) > cap) next = up ? ask - Math.floor(cap / q) * q : ask + Math.floor(cap / q) * q;
    return { value: next, tactic };
  }
  const reduction = Math.floor(Math.min(stepCap(state, g, ask), room, cap) / q) * q;
  if (reduction <= 0) return { value: ask, tactic };
  const next = up ? ask - reduction : ask + reduction;
  return { value: up ? Math.max(limit, next) : Math.min(limit, next), tactic };
}

/** The largest reduction the next counteroffer may make under the guidance steps, or null when no steps are set. */
export function nextConcessionCap(state: NegotiationState, g: StrategyGuidance): number | null {
  if (g.concessionSteps.length === 0 || state.currentAsk === null) return null;
  return stepCap(state, g, state.currentAsk);
}

/**
 * Their stated budget or enquired amount is below the current ask: counter one permitted step toward
 * it (the same steps, caps, limit and counteroffer count as a counter to an offer) and ask them to meet
 * it. Null when no step fits, the position was already answered, or it is at or above the closing point;
 * the caller then keeps the existing non-commitment handling. A position is never accepted or closed on.
 */
function towardPosition(plan: Plan, state: NegotiationState, g: StrategyGuidance, deal: DealInput, context: StrategyContext, position: number, kind: "budget" | "enquiry"): Plan | null {
  const { view } = state;
  const n = view.negotiable;
  if (!n || n.valueType !== "money" || !n.canConcede || state.currentAsk === null || state.status !== "active") return null;
  // Settle a missing or unclear detail before moving on price.
  if (plan.clarify.length > 0 || plan.unresolved.length > 0 || deal.check.findings.some((f) => f.status === "needs_clarification")) return null;
  const atLeast = (x: number, y: number) => (n.direction === "up" ? x >= y : x <= y);
  const ask = state.currentAsk;
  const limit = applicableLimit(state.space, n.termId, deal.package)?.amount ?? n.limit;
  const target = applicableTarget(state, n.termId, deal.package);
  const closeAt = target !== null && atLeast(target, limit) && !atLeast(target, ask) ? target : ask;
  if (atLeast(position, closeAt) || atLeast(limit, ask)) return null;
  if (g.maxCounteroffers !== null && state.countersMade >= g.maxCounteroffers) return null;
  // Repeating a position earns no further step.
  const seen = kind === "budget"
    ? (context.counterparty?.items ?? []).filter((item) => item.kind === "budget" && item.value?.type === "money" && item.value.amount === position).length
    : (context.counterparty?.offers ?? []).filter((offer) => offer.amount === position).length;
  const earlierBudget = (context.counterparty?.items ?? []).some((item) => item.kind === "budget" && item.value?.type === "money" && item.value.amount === position);
  if (seen > 1 || (kind === "enquiry" && earlierBudget && state.countersMade > 0)) return null;
  const q = g.increment ?? niceStep(n.opening);
  // A first stated position counts like a first offer for the allowance: it may earn one step. A claim is
  // not a firm offer, so it never moves the price more than half of the remaining room to the limit.
  const earned = context.allowance && context.allowance.remaining <= 0 && state.countersMade === 0 ? (g.commitmentAllowance?.betterOffer ?? Number.POSITIVE_INFINITY) : allowanceCap(context);
  const cap = Math.min(earned, Math.abs(ask - limit) / 2);
  const next = concede(state, g, n, ask, limit, position, q, cap);
  if (next.value === ask || atLeast(position, next.value)) return null;
  const said = kind === "budget" ? "stated budget" : "enquiry";
  return {
    ...counterAt(plan, view, next.value, packageExtras(state, []), `Their ${said} is below the current price: move one permitted step toward it and ask them to meet it, without accepting it.`, next.tactic),
    ...(kind === "budget" ? { statedBudget: position } : { enquiredAmount: position }),
    referenceAmount: ask,
    questions: [],
    strategyQuestion: { key: `strategy:meet:${next.value}`, kind: "terms_probe", text: "Could you come up to that?", purpose: "Ask whether they can come up to this price. Keep their figure a claim, not an agreement." },
  };
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

/** The unused discount allowance, or no cap when the guidance sets none. */
function allowanceCap(context: StrategyContext): number {
  return context.allowance ? context.allowance.remaining : Number.POSITIVE_INFINITY;
}

/** An allowance is configured and the counterparty has nothing left to spend: hold. */
function noAllowance(context: StrategyContext): boolean {
  return Boolean(context.allowance) && context.allowance!.remaining <= 0;
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
  const earlier = publicDealTerms(state).filter((t) => t.termId !== n?.termId && !state.view.defaultPackage.some((d) => d.termId === t.termId && sameValue(d.value, t.value)));
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
