/**
 * The outgoing gate (Epic 6, Story 1). Every negotiation action passes here before the counterparty
 * sees it, in chat now and in voice later.
 *
 * Phase 1, terms: the structured offer and the move are checked against the active mandate
 * revision: deal-space rules, authority, exception paths and approvals.
 * Phase 2, wording: the final text is checked against the checked terms and the language rules.
 *
 * Results: allow, block, needs_approval or needs_clarification, each with the rule and reason.
 * Missing information or unavailable state never produces allow for an affected promise.
 */
import { checkProposal, sameValue } from "../dealspace/check.ts";
import { hashTerms, type OfferTerm } from "../record/events.ts";
import { approvedFor, clearedNow, publicDealTerms, type NegotiationState } from "../negotiation/state.ts";
import type { Plan } from "../negotiation/policy.ts";
import { checkReply } from "../negotiation/reply-check.ts";
import { checkClaims } from "./claims.ts";

export type GateDecision = "allow" | "block" | "needs_approval" | "needs_clarification";

export interface GateReason {
  rule: string;
  detail: string;
}

export interface GateResult {
  decision: GateDecision;
  reasons: GateReason[];
  mandateRevision: number;
  termsHash: string | null;
  /** For needs_approval: the mandate rules these terms would cross. */
  breachedRuleIds: string[];
}

const NEGOTIATION_MOVES = new Set<Plan["move"]>(["counter", "hold", "state_final_terms", "request_approval", "confirm_agreement", "answer", "answer_public_terms", "explore_objection", "explain_price", "acknowledge_budget", "answer_enquiry", "price_pressure", "compare_terms", "await_approval"]);

export function gateTerms(state: NegotiationState, plan: Plan, preparedRevision: number): GateResult {
  const reasons: GateReason[] = [];
  const breachedRuleIds: string[] = [];
  const result = (decision: GateDecision): GateResult => ({
    decision,
    reasons,
    mandateRevision: state.mandateRevision,
    termsHash: plan.offer ? hashTerms(plan.offer.terms) : null,
    breachedRuleIds,
  });

  if (state.status === "paused" && NEGOTIATION_MOVES.has(plan.move)) {
    reasons.push({ rule: "paused", detail: "The principal paused the negotiation." });
    return result("block");
  }
  if ((state.status === "no_agreement" || state.status === "ended") && plan.move !== "closed") {
    reasons.push({ rule: "ended", detail: "The negotiation has ended." });
    return result("block");
  }
  if (preparedRevision !== state.mandateRevision) {
    reasons.push({ rule: "stale_authority", detail: "The mandate changed after this action was prepared." });
    return result("block");
  }
  if (state.outcome.kind === "agreement" && plan.move !== "closed") {
    reasons.push({ rule: "agreed", detail: "An agreement is already recorded." });
    return result("block");
  }

  if (plan.referenceAmount !== undefined && plan.referenceAmount !== state.currentAsk) {
    reasons.push({ rule: "unverified_reference", detail: "The referenced amount is not the current public ask." });
    return result("block");
  }
  if (plan.publicTermAnswers?.length) {
    const current = publicDealTerms(state);
    for (const answer of plan.publicTermAnswers) {
      const terms = answer.basis === "opening" ? state.view.defaultPackage : current;
      if (!terms.some((term) => term.termId === answer.termId && sameValue(term.value, answer.value))) {
        reasons.push({ rule: "unverified_reference", detail: "The term value does not match the confirmed public terms." });
        return result("block");
      }
    }
  }
  const authority = state.view.authority;

  if (plan.offer) {
    const terms = plan.offer.terms;
    const hash = hashTerms(terms);
    const check = checkProposal(state.space, terms);
    const approval = approvedFor(state, hash);

    for (const f of check.findings) {
      if (f.status === "needs_clarification") {
        reasons.push({ rule: "deal_space_unclear", detail: `${f.termName}: ${f.detail}` });
      }
      if (f.status === "conflict") {
        const exceptionAllowed = f.ruleId !== null && authority.exceptionFor(f.ruleId) === "with_approval";
        const excepted = exceptionAllowed && approval?.purpose === "exception" && approval.breachedRuleIds.includes(f.ruleId!);
        if (excepted) continue;
        // The principal already said no to these exact terms under this revision: do not ask again.
        const rejectedBefore = state.approvals.some((a) => a.decision !== "approved" && a.termsHash === hash && a.mandateRevision === state.mandateRevision);
        if (exceptionAllowed && rejectedBefore) {
          reasons.push({ rule: "deal_space_conflict", detail: `${f.termName}: the principal rejected an exception for these exact terms.` });
          continue;
        }
        reasons.push({ rule: exceptionAllowed ? "exception_required" : "deal_space_conflict", detail: `${f.termName}: ${f.detail}` });
        if (exceptionAllowed) breachedRuleIds.push(f.ruleId!);
      }
    }

    // Authority to move a term away from the principal's own stated value.
    for (const t of terms) {
      const principalValue = state.view.defaultPackage.find((d) => d.termId === t.termId);
      if (!principalValue || JSON.stringify(principalValue.value) === JSON.stringify(t.value)) continue;
      const mode = authority.propose(t.termId, terms);
      if (mode === "autonomous" || approval) continue;
      const name = state.space.terms.find((x) => x.termId === t.termId)?.name ?? t.termId;
      if (mode === "unresolved") reasons.push({ rule: "authority_unresolved", detail: `The mandate's rules for ${name} conflict.` });
      else if (mode === "requires_approval") reasons.push({ rule: "approval_required", detail: `Changing ${name} needs the principal's approval.` });
      else reasons.push({ rule: "no_authority", detail: `The mandate gives no authority to change ${name}.` });
    }
  }

  // Commitments: acceptance and agreement must refer to the current, delivered, cleared terms.
  if (plan.move === "request_approval" || plan.move === "confirm_agreement") {
    const accepted = plan.acceptanceOf;
    if (!accepted || !accepted.communicated) {
      reasons.push({ rule: "acceptance_basis", detail: "There are no delivered terms to accept." });
    } else if (!clearedNow(state, accepted.offerId, accepted.termsHash)) {
      reasons.push({ rule: "stale_check", detail: "The accepted terms have not passed a check under the current mandate." });
    } else if (plan.move === "confirm_agreement") {
      const mode = authority.accept(accepted.terms);
      if (mode !== "autonomous" && !approvedFor(state, accepted.termsHash)) {
        reasons.push({ rule: mode === "unresolved" ? "authority_unresolved" : "approval_required", detail: "Agreeing to these terms needs the principal's approval." });
      }
    }
  }

  const rules = new Set(reasons.map((r) => r.rule));
  const any = (...names: string[]) => names.some((n) => rules.has(n));
  if (any("deal_space_conflict", "no_authority", "acceptance_basis", "stale_check")) return result("block");
  if (any("deal_space_unclear", "authority_unresolved")) return result("needs_clarification");
  if (any("exception_required", "approval_required")) return result("needs_approval");
  return result("allow");
}

/** Phase 2: the words must say exactly what was checked, reveal nothing private, and claim nothing unsupported. */
export function gateWording(state: NegotiationState, plan: Plan, text: string): GateResult {
  const reasons: GateReason[] = [];
  for (const v of checkReply(text, { view: state.view, plan, counterpartyAmounts: [...new Set([...state.counterpartyAmounts, ...state.counterpartySaidAmounts])], statedAmounts: state.askHistory })) reasons.push({ rule: v.rule, detail: v.detail });
  const termNames = new Map(state.space.terms.map((t) => [t.termId, t.name]));
  const counterpartyRole = state.view.mandate.parties.find((p) => p.id === state.view.counterpartyId)?.role ?? null;
  for (const v of checkClaims(text, { offerTerms: plan.offer?.terms ?? null, termNames, counterpartyRole })) reasons.push({ rule: v.rule, detail: v.detail });
  return {
    decision: reasons.length === 0 ? "allow" : "block",
    reasons,
    mandateRevision: state.mandateRevision,
    termsHash: plan.offer ? hashTerms(plan.offer.terms) : null,
    breachedRuleIds: [],
  };
}

export type { OfferTerm };
