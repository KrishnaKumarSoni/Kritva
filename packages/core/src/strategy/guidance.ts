/**
 * Strategy guidance: tactic parameters supplied as data from a separate strategy document.
 *
 * The core embeds no concession sequence or negotiation literature. Guidance only shapes the
 * moves the strategy proposes; it never grants authority, overrides the mandate, or bypasses the
 * outgoing gate. Without guidance, the core uses MINIMAL_GUIDANCE: move toward the limit in
 * halves, never past it, and never walk away on its own.
 */
import { z } from "zod";

export const StrategyGuidance = z.strictObject({
  id: z.string().min(1).max(120),
  source: z.string().max(300),
  /** Price increment q: counteroffers round to it. Null: a round step from the scale of the price. */
  increment: z.number().positive().nullable(),
  /** Approved decreasing concession steps (e.g. 1500, 800, 300). Empty: halve the distance to the limit. */
  concessionSteps: z.array(z.number().positive()).max(10),
  /** The most counteroffers the agent makes before closing or walking away (N). Null: no cap. */
  maxCounteroffers: z.number().int().positive().nullable(),
  /** Offer the midpoint once when only price is open and it fits every concession limit. */
  splitTheDifference: z.boolean(),
  /** When a counterparty gives a non-price reason, ask about it before conceding on price. */
  askBeforeConceding: z.boolean(),
  /** End without agreement once no permitted package works: after the last counteroffer, or when the offer is already at the limit and the counterparty stays below it. */
  walkAwayAfterMaxCounteroffers: z.boolean(),
  /** Short wording the reply may use when walking away. */
  walkAwayLine: z.string().max(200).nullable(),
  /** Neutral questions for pressure moves ("what's your lowest?", "cheaper elsewhere"). */
  pressureQuestions: z.strictObject({
    lowestPrice: z.string().max(200).nullable(),
    cheaperElsewhere: z.string().max(200).nullable(),
  }),
});
export type StrategyGuidance = z.infer<typeof StrategyGuidance>;

export const MINIMAL_GUIDANCE: StrategyGuidance = {
  id: "minimal",
  source: "Built-in default used when no strategy document is supplied.",
  increment: null,
  concessionSteps: [],
  maxCounteroffers: null,
  splitTheDifference: false,
  askBeforeConceding: true,
  walkAwayAfterMaxCounteroffers: false,
  walkAwayLine: null,
  pressureQuestions: { lowestPrice: null, cheaperElsewhere: null },
};

export function parseGuidance(json: unknown): StrategyGuidance {
  return StrategyGuidance.parse(json);
}
