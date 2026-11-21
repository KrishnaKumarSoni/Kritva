/**
 * Deal space, Story 1: what in a confirmed mandate is open to negotiation.
 *
 * The catalog is a read-only view over the mandate. It points at the mandate's own
 * records (limits, positions, conditions, facts, issues) rather than copying them, and it
 * keeps their source links and disclosure labels. Nothing here is specific to any case.
 *
 * Term kinds:
 * - range: has a minimum or maximum (conditional or not). Values inside the bounds fit.
 * - options: has allowed values. Only those values fit.
 * - fixed: a confirmed must-equal restriction. Other values conflict.
 * - restricted: only excluded values are known. Anything else is unaddressed.
 * - stated: the principal stated a value but no rule about other values. Other values need clarification.
 * - linked: only conditions refer to it (e.g. a day a concession depends on). Any value is
 *   acceptable on its own; the rule that depends on it is checked on its own term.
 * - descriptive: only facts describe it. It is not a concession.
 * - unresolved: unknown, or no value and no rule. Not assumed available or forbidden.
 */
import type { ConfirmedMandate, Disclosure, Issue, SourceRef, Term, Value } from "../schema/records.ts";
import { sameValue } from "./check.ts";

export type TermKind = "range" | "options" | "fixed" | "restricted" | "stated" | "linked" | "descriptive" | "unresolved";

export interface ConditionRef {
  id: string;
  description: string;
  termId: string | null;
  operator: "equals" | "not_equals" | "at_least" | "at_most" | "includes" | null;
  value: Value | null;
  /** False when the condition cannot be checked in code (no term, operator or value). */
  checkable: boolean;
  sourceRefs: SourceRef[];
}

export interface RuleRef {
  /** The mandate record this rule comes from (a limit or a conditional position). */
  id: string;
  source: "limit" | "position";
  kind: "minimum" | "maximum" | "must_equal" | "must_not_equal" | "allowed_value" | "conditional_value";
  value: Value;
  conditions: ConditionRef[];
  disclosure: Disclosure;
  sourceRefs: SourceRef[];
}

export interface TermEntry {
  termId: string;
  name: string;
  valueType: Term["valueType"];
  kind: TermKind;
  /** The principal's unconditional stated value, if any (e.g. an asking price). Not a limit. */
  principalValue: { positionId: string; value: Value; disclosure: Disclosure } | null;
  rules: RuleRef[];
  factIds: string[];
  /** Open issues about this term (missing, unsupported, conflict, ambiguous). */
  issueIds: string[];
  /** The principal's own stated value breaks one of its own unconditional rules. Shown to the operator. */
  inconsistent: boolean;
  disclosure: Disclosure;
  sourceRefs: SourceRef[];
}

export interface FactEntry {
  id: string;
  statement: string;
  termId: string | null;
  disclosure: Disclosure;
  sourceRefs: SourceRef[];
}

export interface DealSpace {
  caseId: string;
  principalId: string;
  terms: TermEntry[];
  facts: FactEntry[];
  /** Mandate issues that touch no single term. */
  generalIssues: Issue[];
  issues: Map<string, Issue>;
}

export function buildDealSpace(mandate: ConfirmedMandate): DealSpace {
  const principal = mandate.parties.find((p) => p.isPrincipal);
  if (!principal) throw new Error("A mandate needs a principal.");
  const conditionsById = new Map(mandate.conditions.map((c) => [c.id, c]));
  const issues = new Map(mandate.issues.map((i) => [i.id, i]));

  const conditionRef = (id: string): ConditionRef => {
    const c = conditionsById.get(id);
    if (!c) return { id, description: "Unknown condition", termId: null, operator: null, value: null, checkable: false, sourceRefs: [] };
    const term = c.termId ? mandate.terms.find((t) => t.id === c.termId) : undefined;
    const checkable = Boolean(term && c.operator && c.value && c.status !== "unknown" && typesCompatible(term.valueType, c.value.type, c.operator));
    return { id: c.id, description: c.description, termId: c.termId, operator: c.operator, value: c.value, checkable, sourceRefs: c.sourceRefs };
  };

  const terms: TermEntry[] = mandate.terms.map((term) => {
    const rules: RuleRef[] = [];
    for (const l of mandate.limits) {
      if (l.partyId !== principal.id || l.termId !== term.id || l.value === null || l.status === "unknown") continue;
      rules.push({ id: l.id, source: "limit", kind: l.kind, value: l.value, conditions: l.conditionIds.map(conditionRef), disclosure: l.disclosure, sourceRefs: l.sourceRefs });
    }
    let principalValue: TermEntry["principalValue"] = null;
    for (const p of mandate.positions) {
      if (p.partyId !== principal.id || p.termId !== term.id || p.value === null || p.status === "unknown") continue;
      if (p.conditionIds.length === 0) {
        principalValue ??= { positionId: p.id, value: p.value, disclosure: p.disclosure };
      } else {
        // A value the principal offers only under a condition, e.g. "X if collected on a given day".
        rules.push({ id: p.id, source: "position", kind: "conditional_value", value: p.value, conditions: p.conditionIds.map(conditionRef), disclosure: p.disclosure, sourceRefs: p.sourceRefs });
      }
    }
    const factIds = mandate.facts.filter((f) => f.termId === term.id).map((f) => f.id);
    const issueIds = mandate.issues.filter((i) => i.relatedIds.includes(term.id) || rules.some((r) => i.relatedIds.includes(r.id))).map((i) => i.id);

    const usedByConditions = mandate.conditions.some((c) => c.termId === term.id);
    return {
      termId: term.id,
      name: term.name,
      valueType: term.valueType,
      kind: classify(term, rules, principalValue, factIds, usedByConditions),
      inconsistent: false,
      principalValue,
      rules,
      factIds,
      issueIds,
      disclosure: term.disclosure,
      sourceRefs: term.sourceRefs,
    };
  });

  for (const entry of terms) {
    if (!entry.principalValue) continue;
    const value = entry.principalValue.value;
    entry.inconsistent = entry.rules.some((r) => r.conditions.length === 0 && (r.kind === "must_equal" ? !sameValue(r.value, value) : r.kind === "must_not_equal" ? sameValue(r.value, value) : false));
  }

  const termIds = new Set(mandate.terms.map((t) => t.id));
  const ruleIds = new Set(terms.flatMap((t) => t.rules.map((r) => r.id)));
  return {
    caseId: mandate.caseId,
    principalId: principal.id,
    terms,
    facts: mandate.facts.map((f) => ({ id: f.id, statement: f.statement, termId: f.termId, disclosure: f.disclosure, sourceRefs: f.sourceRefs })),
    generalIssues: mandate.issues.filter((i) => !i.relatedIds.some((id) => termIds.has(id) || ruleIds.has(id))),
    issues,
  };
}

function classify(term: Term, rules: RuleRef[], principalValue: TermEntry["principalValue"], factIds: string[], usedByConditions: boolean): TermKind {
  if (term.status === "unknown") return "unresolved";
  const unconditional = rules.filter((r) => r.conditions.length === 0);
  if (unconditional.some((r) => r.kind === "must_equal")) return "fixed";
  if (rules.some((r) => r.kind === "allowed_value")) return "options";
  if (rules.some((r) => r.kind === "minimum" || r.kind === "maximum")) return "range";
  if (rules.some((r) => r.kind === "must_not_equal")) return "restricted";
  if (principalValue) return "stated";
  if (rules.length > 0) return "stated";
  if (usedByConditions) return "linked";
  return factIds.length > 0 ? "descriptive" : "unresolved";
}

function typesCompatible(termType: Term["valueType"], valueType: Value["type"], operator: ConditionRef["operator"]): boolean {
  if (termType !== valueType) return false;
  if (operator === "at_least" || operator === "at_most") return valueType === "money" || valueType === "quantity";
  if (operator === "includes") return valueType === "text" || valueType === "date_text";
  return true;
}

export function termEntry(space: DealSpace, termId: string): TermEntry | undefined {
  return space.terms.find((t) => t.termId === termId);
}
