/**
 * Authority: what the confirmed mandate lets the agent do, read in code.
 *
 * - Proposing and accepting are separate. Permission to negotiate never implies permission to accept.
 * - A missing permission is no permission. A missing accept rule means the principal must approve.
 * - Conditional permissions apply only when their conditions hold in the specific package.
 * - Conflicting rules leave the affected actions unresolved until the principal clarifies them.
 * - Each limit says whether an exception may be requested. Unspecified means no.
 */
import { evaluateConditions } from "../dealspace/check.ts";
import type { OfferTerm } from "../record/events.ts";
import type { ConfirmedMandate, Permission, Value } from "../schema/records.ts";
import { findConflicts } from "../schema/validate.ts";

export type Mode = "autonomous" | "requires_approval" | "prohibited" | "unresolved";

export interface Authority {
  /** Terms whose rules conflict, with the reason. Actions on them are unresolved. */
  unresolvedTerms: Map<string, string>;
  /** May the agent put forward a value on this term other than the principal's own stated value? */
  propose(termId: string, pkg?: OfferTerm[]): Mode;
  /** May the agent agree to these terms? */
  accept(pkg?: OfferTerm[]): Mode;
  /** May the agent disclose private information about this term? */
  disclose(termId: string | null): Mode;
  /** Whether an exception to this limit may be requested from the principal. */
  exceptionFor(limitId: string): "not_allowed" | "with_approval";
  /** May the agent tell a counterparty about another counterparty's real, live offer? Only an explicit grant allows it. */
  mayMentionOtherOffers(): boolean;
}

export function readAuthority(mandate: ConfirmedMandate): Authority {
  const principal = mandate.parties.find((p) => p.isPrincipal)!;
  const unresolvedTerms = new Map<string, string>();

  // Competing values for the same rule: the affected term stays unresolved.
  const limitTerm = new Map(mandate.limits.map((l) => [l.id, l.termId]));
  const positionTerm = new Map(mandate.positions.map((p) => [p.id, p.termId]));
  for (const group of findConflicts(mandate)) {
    for (const id of group.ids) {
      const termId = limitTerm.get(id) ?? positionTerm.get(id);
      if (termId) unresolvedTerms.set(termId, "The mandate gives conflicting values for this term.");
    }
  }
  for (const issue of mandate.issues) {
    if (issue.kind !== "conflict") continue;
    for (const id of issue.relatedIds) {
      const termId = limitTerm.get(id) ?? positionTerm.get(id) ?? (mandate.terms.some((t) => t.id === id) ? id : undefined);
      if (termId) unresolvedTerms.set(termId, "An instruction about this term conflicts with another.");
    }
  }

  const conditionsById = new Map(mandate.conditions.map((c) => [c.id, c]));
  const applies = (p: Permission, pkg: OfferTerm[] | undefined): "yes" | "no" | "unknown" => {
    if (p.conditionIds.length === 0) return "yes";
    if (!pkg) return "unknown";
    const conditions = p.conditionIds.map((id) => {
      const c = conditionsById.get(id);
      return {
        id,
        description: c?.description ?? "Unknown condition",
        termId: c?.termId ?? null,
        operator: c?.operator ?? null,
        value: (c?.value ?? null) as Value | null,
        checkable: Boolean(c?.termId && c?.operator && c?.value),
        sourceRefs: c?.sourceRefs ?? [],
      };
    });
    const state = evaluateConditions(conditions, new Map(pkg.map((t) => [t.termId, t.value])));
    return state.status === "met" ? "yes" : state.status === "not_met" ? "no" : "unknown";
  };

  /** Strictest applicable rule wins: prohibited, then unresolved, then approval, then autonomous. */
  const resolve = (actions: string[], termId: string | null, pkg: OfferTerm[] | undefined, fallback: Mode): Mode => {
    const relevant = mandate.permissions.filter(
      (p) => p.partyId === principal.id && p.status === "stated" && actions.includes(p.action) && (termId === null || p.termIds.length === 0 || p.termIds.includes(termId)),
    );
    const modes: Mode[] = [];
    for (const p of relevant) {
      const a = applies(p, pkg);
      if (a === "no") continue;
      // A conditional grant whose condition is not settled cannot be relied on yet.
      if (a === "unknown") modes.push(p.mode === "prohibited" ? "prohibited" : "unresolved");
      else modes.push(p.mode);
    }
    if (modes.length === 0) return fallback;
    for (const m of ["prohibited", "unresolved", "requires_approval", "autonomous"] as const) if (modes.includes(m)) return m;
    return fallback;
  };

  return {
    unresolvedTerms,
    propose(termId, pkg) {
      if (unresolvedTerms.has(termId)) return "unresolved";
      return resolve(["propose_terms", "make_concession"], termId, pkg, "prohibited");
    },
    accept(pkg) {
      for (const t of pkg ?? []) if (unresolvedTerms.has(t.termId)) return "unresolved";
      return resolve(["accept_agreement"], null, pkg, "requires_approval");
    },
    disclose(termId) {
      return resolve(["disclose_information"], termId, undefined, "prohibited");
    },
    mayMentionOtherOffers() {
      return resolve(["mention_other_offers"], null, undefined, "prohibited") === "autonomous";
    },
    exceptionFor(limitId) {
      const limit = mandate.limits.find((l) => l.id === limitId);
      return limit?.exception === "with_approval" ? "with_approval" : "not_allowed";
    },
  };
}
