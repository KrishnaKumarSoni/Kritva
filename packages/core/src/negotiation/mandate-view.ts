/**
 * Reads a confirmed mandate into what a negotiation turn needs: the principal's public
 * package, the boundaries it must respect, and the authority it holds.
 *
 * Conservative by design: conditional limits are not used to loosen anything, a missing
 * permission is no permission, and a missing limit means no concession authority.
 */
import type { ConfirmedMandate, Term, Value } from "../schema/records.ts";
import type { OfferTerm } from "../record/events.ts";
import { sameValue } from "../dealspace/check.ts";
import { readAuthority, type Authority } from "../governance/authority.ts";

export interface NegotiableTerm {
  termId: string;
  name: string;
  valueType: "money" | "quantity";
  currency: string | null;
  unit: string | null;
  /** "up" when the principal wants a higher value (it has a minimum), "down" when lower (a maximum). */
  direction: "up" | "down";
  /** The principal's opening value (public). */
  opening: number;
  /** The boundary the agent must not cross (private). */
  limit: number;
  /** Whether the mandate lets the agent move from the opening value without approval. */
  canConcede: boolean;
}

export interface MandateView {
  mandate: ConfirmedMandate;
  principalId: string;
  counterpartyId: string;
  /** The parties' roles as the host app supplied them, used in wording. */
  principalRole: string;
  counterpartyRole: string;
  terms: Map<string, Term>;
  /** The principal's public, unconditional values, i.e. the default complete terms. */
  defaultPackage: OfferTerm[];
  negotiable: NegotiableTerm | null;
  /** Unconditional must_equal / must_not_equal rules per term. */
  fixedRules: Map<string, { kind: "must_equal" | "must_not_equal"; value: Value }[]>;
  acceptRequiresApproval: boolean;
  /** Permissions, exception paths and unresolved terms, read from the mandate in code. */
  authority: Authority;
  /** Facts the agent may state. Only public, stated facts. */
  publicFacts: string[];
  /** Numeric values that must never be revealed unless the agent is offering exactly that value. */
  privateAmounts: number[];
  /** Private instruction text, for leak detection. */
  privateTexts: string[];
}

export function readMandate(mandate: ConfirmedMandate): MandateView {
  const principal = mandate.parties.find((p) => p.isPrincipal);
  const counterparty = mandate.parties.find((p) => !p.isPrincipal);
  if (!principal || !counterparty) throw new Error("A negotiation needs a principal and a counterparty.");
  const terms = new Map(mandate.terms.map((t) => [t.id, t]));

  const unconditional = <T extends { conditionIds: string[]; status: string }>(r: T) => r.conditionIds.length === 0 && r.status === "stated";

  const defaultPackage: OfferTerm[] = [];
  for (const p of mandate.positions) {
    if (p.partyId !== principal.id || !unconditional(p) || p.value === null || p.disclosure !== "public") continue;
    if (defaultPackage.some((t) => t.termId === p.termId)) continue;
    defaultPackage.push({ termId: p.termId, value: p.value });
  }

  const fixedRules = new Map<string, { kind: "must_equal" | "must_not_equal"; value: Value }[]>();
  for (const l of mandate.limits) {
    if (l.partyId !== principal.id || !unconditional(l) || l.value === null) continue;
    if (l.kind === "must_equal" || l.kind === "must_not_equal") {
      fixedRules.set(l.termId, [...(fixedRules.get(l.termId) ?? []), { kind: l.kind, value: l.value }]);
    }
  }

  const authority = readAuthority(mandate);

  let negotiable: NegotiableTerm | null = null;
  for (const pkg of defaultPackage) {
    const term = terms.get(pkg.termId);
    if (!term || (pkg.value.type !== "money" && pkg.value.type !== "quantity")) continue;
    const bounds = mandate.limits.filter(
      (l) => l.partyId === principal.id && l.termId === term.id && unconditional(l) && (l.kind === "minimum" || l.kind === "maximum") && l.value !== null,
    );
    const limit = bounds[0];
    const opening = pkg.value.amount;
    const direction = limit?.kind === "maximum" ? "down" : "up";
    // With competing bounds (a conflict), use the strictest one; authority stays unresolved anyway.
    const amounts = bounds.map((b) => (b.value as { amount: number }).amount);
    const limitValue = amounts.length === 0 ? opening : direction === "up" ? Math.max(...amounts) : Math.min(...amounts);
    negotiable = {
      termId: term.id,
      name: term.name,
      valueType: pkg.value.type,
      currency: pkg.value.type === "money" ? pkg.value.currency : null,
      unit: pkg.value.type === "quantity" ? pkg.value.unit : null,
      direction,
      opening,
      limit: limitValue,
      canConcede: Boolean(limit) && bounds.length === 1 && authority.propose(term.id) === "autonomous",
    };
    break;
  }


  const privateAmounts = new Set<number>();
  for (const record of [...mandate.limits, ...mandate.positions, ...mandate.conditions, ...mandate.facts]) {
    const value = (record as { value: Value | null }).value;
    if (record.disclosure === "private" && value && (value.type === "money" || value.type === "quantity")) privateAmounts.add(value.amount);
  }
  // A value that is also public (e.g. stated in a public listing) is not private.
  for (const pkg of defaultPackage) if (pkg.value.type === "money" || pkg.value.type === "quantity") privateAmounts.delete(pkg.value.amount);

  return {
    mandate,
    principalId: principal.id,
    counterpartyId: counterparty.id,
    principalRole: principal.role,
    counterpartyRole: counterparty.role,
    terms,
    defaultPackage,
    negotiable,
    fixedRules,
    acceptRequiresApproval: authority.accept() !== "autonomous",
    authority,
    publicFacts: mandate.facts.filter((f) => f.disclosure === "public" && f.status === "stated").map((f) => f.statement),
    privateAmounts: [...privateAmounts],
    privateTexts: mandate.sources.filter((s) => s.disclosure === "private").map((s) => s.text),
  };
}

/** Does a value break the mandate's fixed rules for its term? Uses the deal space's value comparison. */
export function violatesFixedRule(view: MandateView, termId: string, value: Value): boolean {
  return (view.fixedRules.get(termId) ?? []).some((rule) => {
    const same = sameValue(rule.value, value);
    return rule.kind === "must_equal" ? !same : same;
  });
}

/** Formats a value for people to read. Locale comes from the host application. */
export function formatValue(value: Value, locale: string): string {
  switch (value.type) {
    case "money":
      return value.currency
        ? new Intl.NumberFormat(locale, { style: "currency", currency: value.currency, maximumFractionDigits: 0 }).format(value.amount)
        : new Intl.NumberFormat(locale).format(value.amount);
    case "quantity":
      return `${new Intl.NumberFormat(locale).format(value.amount)}${value.unit ? ` ${value.unit}` : ""}`;
    case "boolean":
      return value.value ? "Yes" : "No";
    case "text":
    case "date_text":
      return value.value;
  }
}

/** Display order for people: the negotiable term first, then the mandate's own term order. */
export function orderTerms(view: MandateView, terms: OfferTerm[]): OfferTerm[] {
  const order = [...view.terms.keys()];
  const rank = (id: string) => (id === view.negotiable?.termId ? -1 : order.indexOf(id));
  return [...terms].sort((a, b) => rank(a.termId) - rank(b.termId));
}

export function withTerm(pkg: OfferTerm[], termId: string, value: Value): OfferTerm[] {
  const others = pkg.filter((t) => t.termId !== termId);
  return [...others, { termId, value }].sort((a, b) => a.termId.localeCompare(b.termId));
}

export function numericValue(n: NegotiableTerm, amount: number): Value {
  return n.valueType === "money" ? { type: "money", amount, currency: n.currency } : { type: "quantity", amount, unit: n.unit };
}
