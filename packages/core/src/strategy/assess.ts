/**
 * Epic 8, Story 1: assess a complete package against the principal's interests.
 *
 * Order: hard constraints first (deal space and approved exceptions), then the principal's stated
 * targets and preferences, then any stated alternative. Unknown preferences and alternatives stay
 * unknown; nothing is weighted or ranked unless the principal ranked it. Evaluation never creates
 * permission: an acceptable package may still need the principal's approval.
 */
import { checkProposal } from "../dealspace/check.ts";
import { formatValue } from "../negotiation/mandate-view.ts";
import { approvedFor, type NegotiationState } from "../negotiation/state.ts";
import { hashTerms, type OfferTerm } from "../record/events.ts";
import { sameValue } from "../dealspace/check.ts";

export interface Assessment {
  verdict: "acceptable" | "unacceptable" | "needs_clarification";
  /** Short, traceable reasons: each names the term or rule behind it. */
  drivers: string[];
  /** Agreeing would still need the principal's approval. */
  needsApproval: boolean;
}

export function assessPackage(state: NegotiationState, terms: OfferTerm[], locale: string): Assessment {
  const drivers: string[] = [];
  const nameOf = (id: string) => state.space.terms.find((t) => t.termId === id)?.name ?? id;
  const check = checkProposal(state.space, terms);
  const approval = approvedFor(state, hashTerms(terms));
  const authority = state.view.authority;

  // 1. Hard constraints. A better headline price never overrides one.
  let verdict: Assessment["verdict"] = "acceptable";
  for (const f of check.findings) {
    if (f.status === "conflict") {
      const waived = approval?.purpose === "exception" && f.ruleId !== null && approval.breachedRuleIds.includes(f.ruleId);
      if (waived) {
        drivers.push(`${f.termName}: outside a limit, but the principal approved this exception.`);
        continue;
      }
      verdict = "unacceptable";
      drivers.push(`${f.termName}: ${f.detail}`);
    } else if (f.status === "needs_clarification" && verdict !== "unacceptable") {
      verdict = "needs_clarification";
      drivers.push(`${f.termName}: ${f.detail}`);
    }
  }

  // 2. Stated targets and preferences (noted, never weighted).
  const m = state.view.mandate;
  const mine = <T extends { partyId: string }>(xs: T[]) => xs.filter((x) => x.partyId === state.view.principalId);
  for (const target of mine(m.targets)) {
    const t = terms.find((x) => x.termId === target.termId);
    if (!t || !target.value || !("amount" in t.value) || !("amount" in target.value)) continue;
    const meets = state.view.negotiable?.direction === "down" ? t.value.amount <= target.value.amount : t.value.amount >= target.value.amount;
    drivers.push(`${nameOf(target.termId)}: ${meets ? "meets" : "below"} the principal's target of ${formatValue(target.value, locale)}.`);
  }
  for (const p of mine(m.preferences)) {
    const t = terms.find((x) => x.termId === p.termId);
    if (!t || !p.value) continue;
    if (sameValue(p.value, t.value)) drivers.push(`${nameOf(p.termId)}: ${p.strength === "avoid" ? "a value the principal prefers to avoid" : `the principal's ${p.strength} value`}.`);
  }

  // 3. The principal's stated alternative, if any. Never invented.
  const alternatives = mine(m.alternatives);
  drivers.push(alternatives.length > 0 ? `If no deal: ${alternatives.map((a) => a.description).join("; ")}` : "No alternative to a deal is stated; it stays unknown.");

  // Authority is separate from evaluation.
  const accept = authority.accept(terms);
  const needsApproval = accept !== "autonomous" && !approval;
  if (verdict === "acceptable" && needsApproval) drivers.push("Agreeing still needs the principal's approval.");
  if (accept === "unresolved") {
    verdict = verdict === "unacceptable" ? verdict : "needs_clarification";
    drivers.push("The principal's rules for these terms conflict; clarification is needed.");
  }
  return { verdict, drivers: drivers.slice(0, 12), needsApproval };
}
