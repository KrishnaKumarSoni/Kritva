/**
 * Discount allowance per counterparty commitment (strategy document, "Controls" and
 * "Concessions and pace"): each new commitment the counterparty gives earns an approved
 * allowance, each concession the agent delivers uses it, and a concession never exceeds what
 * is left. Silence, repetition or a worse offer earns nothing.
 *
 * The ledger is projected from the shared record only (counterparty offers and delivered agent
 * counteroffers), so it survives reloads and can be audited turn by turn. It is private: the
 * amounts describe how far the agent may move and never reach the counterparty.
 *
 * Which commitments earn what is data from strategy guidance, never case code.
 */
import { sameValue } from "../dealspace/check.ts";
import type { SessionContext } from "../record/rules.ts";
import type { OfferTerm, PayloadOf } from "../record/events.ts";
import type { MandateView } from "../negotiation/mandate-view.ts";
import type { StrategyGuidance } from "./guidance.ts";

export interface AllowanceEntry {
  /** The counterparty offer that carried the commitment. */
  offerId: string;
  kind: "better_offer" | "term";
  /** The commitment, in record terms (for the console and the decision record). */
  commitment: string;
  termId: string | null;
  earned: number;
  used: number;
}

export interface AllowanceLedger {
  entries: AllowanceEntry[];
  earned: number;
  used: number;
  remaining: number;
}

type Config = NonNullable<StrategyGuidance["commitmentAllowance"]>;

/** Null when the guidance sets no allowance: concessions then follow steps and limits only. */
export function projectAllowance(ctx: SessionContext, view: MandateView, guidance: StrategyGuidance): AllowanceLedger | null {
  const config = guidance.commitmentAllowance;
  const n = view.negotiable;
  if (!config || !n) return null;
  const up = n.direction === "up";
  const better = (a: number, b: number) => (up ? a > b : a < b);
  const amountOf = (terms: OfferTerm[]) => {
    const t = terms.find((x) => x.termId === n.termId);
    return t && "amount" in t.value ? (t.value.amount as number) : null;
  };

  const entries: AllowanceEntry[] = [];
  const earnedTerms = new Set<string>();
  let best: number | null = null;
  let previousBest: number | null = null;
  let lastOfferId: string | null = null;
  let ask = n.opening;

  for (const e of ctx.events) {
    if (e.type === "offer_extracted") {
      const p = ctx.effective.get(e.id) as PayloadOf<"offer_extracted"> | undefined;
      if (!p || (p.kind && p.kind !== "offer")) continue;
      // A correction replaces the previous offer: what it earned and has not used goes with it.
      if (p.correctsPrevious && lastOfferId) {
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          if (entries[i]!.offerId === lastOfferId && entries[i]!.used === 0) entries.splice(i, 1);
        }
        best = previousBest;
      }
      const amount = amountOf(p.terms);
      if (amount !== null && (best === null || better(amount, best)) && config.betterOffer > 0) {
        entries.push({ offerId: e.id, kind: "better_offer", commitment: `${n.name}: ${amount}`, termId: n.termId, earned: config.betterOffer, used: 0 });
      }
      previousBest = best;
      if (amount !== null && (best === null || better(amount, best))) best = amount;
      for (const term of p.terms) {
        const rule = matchTerm(config, view, term);
        const key = `${term.termId}|${JSON.stringify(term.value)}`;
        if (!rule || earnedTerms.has(key)) continue;
        earnedTerms.add(key);
        entries.push({ offerId: e.id, kind: "term", commitment: rule.label, termId: term.termId, earned: rule.allowance, used: 0 });
      }
      lastOfferId = e.id;
      continue;
    }
    if (e.type === "offer_proposed") {
      const p = ctx.effective.get(e.id) as PayloadOf<"offer_proposed"> | undefined;
      if (!p || !ctx.isCommunicated(e.id)) continue;
      const amount = amountOf(p.terms);
      if (amount === null || amount === ask) continue;
      const reduction = up ? ask - amount : amount - ask;
      ask = amount;
      // Only a delivered counteroffer spends the allowance; final terms at their amount close instead.
      if (reduction > 0 && p.basis === "counter") spend(entries, reduction);
    }
  }
  const earned = entries.reduce((sum, x) => sum + x.earned, 0);
  const used = entries.reduce((sum, x) => sum + x.used, 0);
  // Overspending one commitment is never a debt against the next one.
  return { entries, earned, used, remaining: entries.reduce((sum, x) => sum + Math.max(0, x.earned - x.used), 0) };
}

/** Oldest commitment first: each concession is paid for by what the counterparty gave earliest. */
function spend(entries: AllowanceEntry[], reduction: number): void {
  let left = reduction;
  for (const entry of entries) {
    if (left <= 0) break;
    const take = Math.min(entry.earned - entry.used, left);
    if (take <= 0) continue;
    entry.used += take;
    left -= take;
  }
  // A concession larger than the allowance (made before it existed, or by approval) stays visible.
  if (left > 0 && entries.length > 0) entries.at(-1)!.used += left;
}

function matchTerm(config: Config, view: MandateView, term: OfferTerm): Config["terms"][number] | null {
  for (const rule of config.terms) {
    if (rule.termId !== term.termId) continue;
    if (rule.value ? sameValue(rule.value, term.value) : !view.defaultPackage.some((d) => d.termId === term.termId && sameValue(d.value, term.value))) return rule;
  }
  return null;
}
