/**
 * Numbers for the principal's console: where the negotiation stands on the negotiable term, the
 * zone where agreement looks possible, and how much room the strategy has left. Everything comes
 * from the recorded state and the confirmed mandate; nothing here reaches the counterparty.
 *
 * The counterparty's maximum is an estimate from their own words and offers, never a fact: it is
 * reported with its status, and the zone is "unknown" until they have stated a ceiling.
 */
import { applicableLimit } from "../dealspace/check.ts";
import { packageKey, type CounterpartyModel } from "../counterparty/model.ts";
import { nextConcessionCap } from "../negotiation/policy.ts";
import { publicDealTerms, type NegotiationState } from "../negotiation/state.ts";
import type { AllowanceLedger } from "./allowance.ts";
import { applicableTarget } from "./assess.ts";
import type { StrategyGuidance } from "./guidance.ts";

export interface NegotiationInsights {
  term: { termId: string; name: string; direction: "up" | "down"; currency: string | null; unit: string | null };
  /** The principal's published starting value and the value currently on the table. */
  opening: number;
  currentAsk: number | null;
  /** Private: the limit and the target that apply to the current package. */
  limit: number | null;
  target: number | null;
  counterparty: {
    latestOffer: number | null;
    bestOffer: number | null;
    statedCeiling: number | null;
    estimate: { status: "unknown" | "working_estimate" | "contradicted"; atLeast: number | null; atMost: number | null };
  };
  /** Where both sides could agree: between the principal's limit and the counterparty's estimated maximum. */
  zone: { status: "overlap" | "no_overlap" | "unknown"; from: number | null; to: number | null };
  /** Distance between the current ask and the counterparty's latest offer. */
  gap: number | null;
  strategy: {
    guidanceId: string;
    countersMade: number;
    maxCounteroffers: number | null;
    nextStepCap: number | null;
    splitAvailable: boolean;
    allowance: { earned: number; used: number; remaining: number } | null;
  };
}

export function negotiationInsights(state: NegotiationState, model: CounterpartyModel, guidance: StrategyGuidance, allowance: AllowanceLedger | null): NegotiationInsights | null {
  const n = state.view.negotiable;
  if (!n) return null;
  const up = n.direction === "up";
  const terms = publicDealTerms(state);
  const limit = applicableLimit(state.space, n.termId, terms)?.amount ?? n.limit;
  const key = packageKey(terms.filter((t) => t.termId !== n.termId));
  const estimate = model.estimates.find((e) => e.packageKey === key) ?? model.estimates.find((e) => e.packageKey === "") ?? null;
  const offers = state.counterpartyAmounts;
  const best = offers.length ? (up ? Math.max(...offers) : Math.min(...offers)) : null;
  const ceiling = estimate?.statedMaximum?.value && "amount" in estimate.statedMaximum.value ? (estimate.statedMaximum.value.amount as number) : null;
  const max = estimate?.maximum;
  const est = !max || max.status === "unknown"
    ? { status: "unknown" as const, atLeast: best, atMost: null }
    : max.status === "contradicted"
      ? { status: "contradicted" as const, atLeast: best, atMost: null }
      : { status: "working_estimate" as const, atLeast: max.atLeast, atMost: max.atMost };

  // Direction "up": agreement is possible from the limit up to the counterparty's maximum; mirrored for "down".
  let zone: NegotiationInsights["zone"] = { status: "unknown", from: null, to: null };
  if (est.atMost !== null && limit !== null) {
    const fits = up ? est.atMost >= limit : est.atMost <= limit;
    zone = fits ? { status: "overlap", from: up ? limit : est.atMost, to: up ? est.atMost : limit } : { status: "no_overlap", from: null, to: null };
  } else if (best !== null && limit !== null && (up ? best >= limit : best <= limit)) {
    // An offer already inside the limit proves overlap at least up to that offer.
    zone = { status: "overlap", from: up ? limit : best, to: up ? best : limit };
  }
  const latest = offers.at(-1) ?? null;
  return {
    term: { termId: n.termId, name: n.name, direction: n.direction, currency: n.currency ?? null, unit: n.unit ?? null },
    opening: n.opening,
    currentAsk: state.currentAsk,
    limit,
    target: applicableTarget(state, n.termId, terms),
    counterparty: { latestOffer: latest, bestOffer: best, statedCeiling: ceiling, estimate: est },
    zone,
    gap: latest !== null && state.currentAsk !== null ? Math.abs(state.currentAsk - latest) : null,
    strategy: {
      guidanceId: guidance.id,
      countersMade: state.countersMade,
      maxCounteroffers: guidance.maxCounteroffers,
      nextStepCap: nextConcessionCap(state, guidance),
      splitAvailable: guidance.splitTheDifference && !state.splitUsed,
      allowance: allowance ? { earned: allowance.earned, used: allowance.used, remaining: allowance.remaining } : null,
    },
  };
}
