/**
 * Deal space, Story 2: does a proposal fit the known terms and constraints?
 *
 * Deterministic and model-free: the same deal space and terms always give the same result.
 * The result says only whether the combination fits what is known. It never means the
 * offer is preferred, authorized or agreed.
 *
 * - fits: every proposed term satisfies every relevant rule and condition.
 * - conflicts: at least one rule is broken. Takes precedence; other findings stay visible.
 * - needs_clarification: something required is missing, unaddressed, or cannot be checked.
 *
 * Linked terms are checked together: a concession that depends on a condition fits only
 * when the condition holds in the same proposal. Unsupported conditions are never dropped.
 */
import type { OfferTerm } from "../record/events.ts";
import type { Value } from "../schema/records.ts";
import type { ConditionRef, DealSpace, RuleRef, TermEntry } from "./catalog.ts";

export type CheckResult = "fits" | "conflicts" | "needs_clarification";
export type FindingStatus = "fits" | "conflict" | "needs_clarification";

export interface Finding {
  termId: string | null;
  termName: string;
  status: FindingStatus;
  /** What the finding is about: a mandate rule, a condition, an unaddressed value, a new term, or an open issue. */
  basis: "rule" | "condition" | "principal_value" | "unaddressed" | "new_term" | "issue" | "descriptive";
  /** The mandate record behind the finding (limit, position, condition or issue), when there is one. */
  ruleId: string | null;
  /** For condition findings: the other term the condition depends on (e.g. a day). */
  relatedTermId: string | null;
  detail: string;
}

export interface DealCheck {
  result: CheckResult;
  findings: Finding[];
}

export interface NewTermRequest {
  name: string;
  value: Value | null;
}

export function checkProposal(space: DealSpace, terms: OfferTerm[], newTerms: NewTermRequest[] = []): DealCheck {
  const findings: Finding[] = [];
  const proposal = new Map(terms.map((t) => [t.termId, t.value]));

  for (const t of terms) {
    const entry = space.terms.find((e) => e.termId === t.termId);
    if (!entry) {
      findings.push({ termId: t.termId, termName: t.termId, status: "needs_clarification", basis: "new_term", ruleId: null, relatedTermId: null, detail: "Not a term in the confirmed mandate." });
      continue;
    }
    findings.push(...checkTerm(space, entry, t.value, proposal));
  }

  for (const request of newTerms) {
    findings.push({ termId: null, termName: request.name, status: "needs_clarification", basis: "new_term", ruleId: null, relatedTermId: null, detail: "Requested by the counterparty; the mandate does not address it." });
  }

  const result: CheckResult = findings.some((f) => f.status === "conflict")
    ? "conflicts"
    : findings.some((f) => f.status === "needs_clarification")
      ? "needs_clarification"
      : "fits";
  return { result, findings };
}

function checkTerm(space: DealSpace, entry: TermEntry, value: Value, proposal: Map<string, Value>): Finding[] {
  const out: Finding[] = [];
  const base = { termId: entry.termId, termName: entry.name };

  // Open instructions about this term that could not be represented are never dropped.
  for (const issueId of entry.issueIds) {
    const issue = space.issues.get(issueId);
    if (issue && (issue.kind === "unsupported" || issue.kind === "conflict")) {
      out.push({ ...base, status: "needs_clarification", basis: "issue", ruleId: issue.id, relatedTermId: null, detail: `Open ${issue.kind} instruction about this term.` });
    }
  }

  if (value.type !== entry.valueType) {
    out.push({ ...base, status: "needs_clarification", basis: "unaddressed", ruleId: null, relatedTermId: null, detail: `Expected a ${entry.valueType} value.` });
    return out;
  }
  if (entry.kind === "descriptive") {
    out.push({ ...base, status: "needs_clarification", basis: "descriptive", ruleId: null, relatedTermId: null, detail: "This describes the subject; it is not a negotiable term." });
    return out;
  }
  if (entry.kind === "linked") {
    out.push({ ...base, status: "fits", basis: "condition", ruleId: null, relatedTermId: null, detail: "Settles a condition another term depends on." });
    return out;
  }
  if (entry.kind === "unresolved") {
    out.push({ ...base, status: "needs_clarification", basis: "unaddressed", ruleId: null, relatedTermId: null, detail: "The mandate leaves this term unresolved." });
    return out;
  }

  const unconditional = entry.rules.filter((r) => r.conditions.length === 0);
  const conditional = entry.rules.filter((r) => r.conditions.length > 0);

  // Fixed and excluded values. A conditional restriction applies when its conditions hold.
  for (const rule of entry.rules.filter((r) => r.kind === "must_equal" || r.kind === "must_not_equal")) {
    const broken = rule.kind === "must_equal" ? !sameValue(rule.value, value) : sameValue(rule.value, value);
    if (!broken) continue;
    if (rule.conditions.length === 0) {
      out.push({ ...base, status: "conflict", basis: "rule", ruleId: rule.id, relatedTermId: null, detail: rule.kind === "must_equal" ? "The mandate fixes this term to another value." : "The mandate excludes this value." });
      continue;
    }
    const state = evaluateConditions(rule.conditions, proposal);
    if (state.status === "met") out.push({ ...base, status: "conflict", basis: "rule", ruleId: rule.id, relatedTermId: null, detail: "A conditional restriction applies and is broken." });
    else if (state.status !== "not_met") out.push(conditionFinding(base, state, "A conditional restriction may apply."));
  }

  // Option sets.
  const options = entry.rules.filter((r) => r.kind === "allowed_value");
  if (options.length > 0) {
    const matching = options.filter((r) => sameValue(r.value, value));
    if (matching.length === 0) {
      out.push({ ...base, status: "conflict", basis: "rule", ruleId: options[0]!.id, relatedTermId: null, detail: "Not one of the allowed options." });
    } else {
      out.push(...settleConditional(base, matching, proposal, "An allowed option."));
    }
  }

  // Ranges, with conditional relaxations.
  const bounds = entry.rules.filter((r) => r.kind === "minimum" || r.kind === "maximum");
  if (bounds.length > 0 && (value.type === "money" || value.type === "quantity")) {
    out.push(...checkBounds(base, entry, bounds, value.amount, proposal));
  }

  // Conditional values the principal offered (a position that holds only under a condition).
  const conditionalValues = conditional.filter((r) => r.kind === "conditional_value" && sameValue(r.value, value));
  if (conditionalValues.length > 0 && bounds.length === 0 && options.length === 0) {
    out.push(...settleConditional(base, conditionalValues, proposal, "A value the principal offered under a condition."));
  }

  // Nothing above addressed this value: compare with the principal's own stated value.
  const addressed = out.some((f) => f.basis === "rule" || f.basis === "condition") || options.length > 0 || bounds.length > 0 || conditionalValues.length > 0;
  if (!addressed && !unconditional.some((r) => r.kind === "must_equal")) {
    if (entry.principalValue && sameValue(entry.principalValue.value, value)) {
      out.push({ ...base, status: "fits", basis: "principal_value", ruleId: entry.principalValue.positionId, relatedTermId: null, detail: "Matches the principal's stated value." });
    } else if (entry.kind === "restricted") {
      out.push({ ...base, status: "needs_clarification", basis: "unaddressed", ruleId: null, relatedTermId: null, detail: "Not excluded, but the principal has not addressed this value." });
    } else {
      out.push({ ...base, status: "needs_clarification", basis: "unaddressed", ruleId: entry.principalValue?.positionId ?? null, relatedTermId: null, detail: "The principal has not addressed this value." });
    }
  }
  if (out.length === 0) out.push({ ...base, status: "fits", basis: "rule", ruleId: entry.rules[0]?.id ?? null, relatedTermId: null, detail: "Fits the known rules." });
  return out;
}

function checkBounds(base: { termId: string; termName: string }, entry: TermEntry, bounds: RuleRef[], amount: number, proposal: Map<string, Value>): Finding[] {
  const satisfies = (r: RuleRef) => {
    const limit = (r.value as { amount: number }).amount;
    return r.kind === "minimum" ? amount >= limit : amount <= limit;
  };
  const unconditional = bounds.filter((r) => r.conditions.length === 0);
  const conditional = bounds.filter((r) => r.conditions.length > 0);

  if (unconditional.length > 0 && unconditional.every(satisfies)) {
    return [{ ...base, status: "fits", basis: "rule", ruleId: unconditional[0]!.id, relatedTermId: null, detail: "Within the principal's range." }];
  }
  // The principal's own stated value always fits its own range.
  const pv = entry.principalValue?.value;
  if (pv && (pv.type === "money" || pv.type === "quantity") && pv.amount === amount && unconditional.length === 0) {
    return [{ ...base, status: "fits", basis: "principal_value", ruleId: entry.principalValue!.positionId, relatedTermId: null, detail: "Matches the principal's stated value." }];
  }
  const relaxations = conditional.filter(satisfies);
  if (relaxations.length > 0) {
    return settleConditional(base, relaxations, proposal, "Within a conditional range.");
  }
  const broken = unconditional.find((r) => !satisfies(r)) ?? conditional[0]!;
  return [{ ...base, status: "conflict", basis: "rule", ruleId: broken.id, relatedTermId: null, detail: broken.kind === "minimum" ? "Below the principal's lower limit." : "Above the principal's upper limit." }];
}

/** A value allowed only under conditions: fits if any rule's conditions all hold. */
function settleConditional(base: { termId: string; termName: string }, rules: RuleRef[], proposal: Map<string, Value>, fitsDetail: string): Finding[] {
  const states = rules.map((r) => ({ rule: r, state: evaluateConditions(r.conditions, proposal) }));
  const met = states.find((s) => s.state.status === "met");
  if (met) return [{ ...base, status: "fits", basis: met.rule.conditions.length > 0 ? "condition" : "rule", ruleId: met.rule.id, relatedTermId: null, detail: fitsDetail }];
  const open = states.find((s) => s.state.status === "unknown" || s.state.status === "unsupported");
  if (open) return [conditionFinding(base, open.state, "Allowed only under a condition that is not settled.")];
  const failed = states[0]!.state;
  return [{ ...base, status: "conflict", basis: "condition", ruleId: failed.conditionId, relatedTermId: failed.conditionTermId, detail: `The required condition does not hold: ${failed.description}` }];
}

interface ConditionState {
  status: "met" | "not_met" | "unknown" | "unsupported";
  conditionId: string | null;
  conditionTermId: string | null;
  description: string;
}

function conditionFinding(base: { termId: string; termName: string }, state: ConditionState, prefix: string): Finding {
  const detail =
    state.status === "unsupported"
      ? `${prefix} The condition cannot be checked automatically: ${state.description}`
      : `${prefix} Needs: ${state.description}`;
  return { ...base, status: "needs_clarification", basis: "condition", ruleId: state.conditionId, relatedTermId: state.conditionTermId, detail };
}

/** All conditions must hold. Any broken one decides; otherwise any open one keeps it open. */
export function evaluateConditions(conditions: ConditionRef[], proposal: Map<string, Value>): ConditionState {
  let open: ConditionState | null = null;
  for (const c of conditions) {
    if (!c.checkable || c.termId === null || c.operator === null || c.value === null) {
      open ??= { status: "unsupported", conditionId: c.id, conditionTermId: c.termId, description: c.description };
      continue;
    }
    const value = proposal.get(c.termId);
    if (value === undefined) {
      if (!open || open.status !== "unsupported") open = { status: "unknown", conditionId: c.id, conditionTermId: c.termId, description: c.description };
      continue;
    }
    if (!holds(c.operator, c.value, value)) return { status: "not_met", conditionId: c.id, conditionTermId: c.termId, description: c.description };
  }
  return open ?? { status: "met", conditionId: conditions[0]?.id ?? null, conditionTermId: conditions[0]?.termId ?? null, description: conditions[0]?.description ?? "" };
}

function holds(operator: NonNullable<ConditionRef["operator"]>, expected: Value, actual: Value): boolean {
  switch (operator) {
    case "equals":
      return sameValue(expected, actual);
    case "not_equals":
      return !sameValue(expected, actual);
    case "at_least":
      return "amount" in actual && "amount" in expected && actual.amount >= expected.amount;
    case "at_most":
      return "amount" in actual && "amount" in expected && actual.amount <= expected.amount;
    case "includes":
      return textOf(actual).includes(textOf(expected));
  }
}

export function sameValue(a: Value, b: Value): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "money":
      return a.amount === (b as typeof a).amount && (a.currency === null || (b as typeof a).currency === null || a.currency === (b as typeof a).currency);
    case "quantity":
      return a.amount === (b as typeof a).amount;
    case "boolean":
      return a.value === (b as typeof a).value;
    case "text":
    case "date_text": {
      // The same value written with or without a trailing qualifier ("X" vs "X, City") is equal.
      const x = textOf(a);
      const y = textOf(b);
      return x === y || x.startsWith(`${y},`) || y.startsWith(`${x},`);
    }
  }
}

function textOf(v: Value): string {
  return "value" in v && typeof v.value === "string" ? v.value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

/**
 * The loosest bound on a numeric term that applies to this proposal: unconditional bounds
 * always, conditional ones only when their conditions hold. Used by strategy to know how far
 * a specific package may go, without guessing at conditions.
 */
export function applicableLimit(space: DealSpace, termId: string, proposal: OfferTerm[]): { amount: number; ruleId: string } | null {
  const entry = space.terms.find((t) => t.termId === termId);
  if (!entry) return null;
  const map = new Map(proposal.map((t) => [t.termId, t.value]));
  const bounds = entry.rules.filter((r) => (r.kind === "minimum" || r.kind === "maximum") && (r.conditions.length === 0 || evaluateConditions(r.conditions, map).status === "met"));
  if (bounds.length === 0) return null;
  const isMin = bounds[0]!.kind === "minimum";
  const pick = bounds.reduce((best, r) => {
    const a = (r.value as { amount: number }).amount;
    const b = (best.value as { amount: number }).amount;
    return isMin ? (a < b ? r : best) : a > b ? r : best;
  });
  return { amount: (pick.value as { amount: number }).amount, ruleId: pick.id };
}
