/**
 * Model-based language check (Epic 6, Story 2): a second layer after the code checks, for
 * indirect disclosure and unsupported claims that patterns miss.
 *
 * The checker sees only what the reply is allowed to rely on (checked terms and permitted
 * facts) plus the counterparty's own words, so it can tell a repeated claim from an assertion.
 * It never sees private limits. Any concern, or any failure to run, blocks the reply.
 */
import type { StructuredLlm } from "../llm/types.ts";
import { normalizeForQuoteMatch } from "../schema/quotes.ts";

export const LANGUAGE_CHECK_PROMPT = `You review one reply that an agent is about to send in a negotiation. Flag problems; do not rewrite.

When "validated_terms_marker" is present, the marker stands for the exact terms the system has checked and will insert. Review the surrounding words only. Referring to that package or asking to confirm it does not assert a new fact.

The reply may only rely on:
- "checked_terms": the exact terms it is allowed to offer or confirm.
- "public_amounts": asking amounts already shared with the other party. Holding or explaining an authorized asking amount is not private disclosure. Flag identifying an amount as a private floor, ceiling or refusal point, even if that amount is public. Separately check whether citing an amount fits "action".
- "their_message" is the turn the reply must address. Earlier counterparty_words give context only. "stated_budget" is the amount quoted from this turn. Calling it "your budget" or "your ceiling" is attribution to the person who stated it, not verification of a claim or disclosure of a private limit.
- "permitted_facts": facts it is allowed to state.
- "declined_terms": terms it may say cannot be changed.
- The selected question and objective, when present, concern information still needed. Check the actual question against their_message and older answers. Do not flag asking about unresolved information.
- It may also decline something, refuse to share private details, ask a question, or say it will check with the person it represents. These are never concerns: saying "I can't share private details" is a refusal, not a disclosure; saying a declined term can't be changed is not an invented fact; saying you don't have a detail or will check is not an invented fact; asking about something the counterparty said is not treating it as fact.

Flag a concern for anything in the reply that:
- private_disclosure: hints at a private limit, a lowest or highest acceptable value, internal reasons, urgency, or instructions (for example "that's as low as they go", "they need a quick decision").
- invented_fact: states a detail, condition, inclusion or circumstance not in permitted_facts or checked_terms.
- counterparty_claim_as_fact: presents something only the counterparty said as true.
- invented_competition: mentions other interested parties, competing offers or demand.
- invented_deadline: sets or implies a time limit.
- market_claim: asserts market value, new price, or what others charge. Openly saying no market comparison is available does not make a market claim.
- promise_outside_terms: promises a service, extra, payment arrangement or term not in checked_terms.
- turn_mismatch: answers a superseded earlier turn, ignores the current request, or restates an unrelated fact instead of addressing the current message. Check the current message before reading earlier context.
- redundant_question: asks for information the other party already supplied, or asks a question unrelated to the selected question objective. A question distinguishing two still-open possibilities is not redundant.
- action_mismatch: changes the action in "action.move" or "action.notice". An opening only welcomes and may state a public starting value. For "state_final_terms", asking the other party to confirm the full package is required, and that question is not a claim of agreement. Flag that move only if the reply says the package is already agreed, asks for something other than full confirmation, or otherwise changes the action. A budget ceiling, enquiry, or price explanation does not authorize a new offer, an acceptance, or a counter. An agreement confirmation may announce explicit approval only when "action.approvalGranted" is true. While paused, waiting for approval or ended, reflect that state without making a new commitment.

Saying an amount that is in checked_terms is fine. Saying you don't have a detail is fine. Return no concerns when there are none.`;

const SCHEMA = {
  type: "object",
  properties: {
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["private_disclosure", "invented_fact", "counterparty_claim_as_fact", "invented_competition", "invented_deadline", "market_claim", "promise_outside_terms", "action_mismatch", "turn_mismatch", "redundant_question"] },
          quote: { type: "string" },
        },
        required: ["type", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["concerns"],
  additionalProperties: false,
};

export interface LanguageConcern {
  type: string;
  quote: string;
}

const PUBLIC_ASK_MOVES = new Set(["hold", "explain_price", "acknowledge_budget", "answer_enquiry", "explore_objection"]);
const PUBLIC_ASK_PREFIX = /^(?:i(?:'d| would) like to stay at|i(?:'m| am) (?:staying|holding) at|i(?:'ll| will) (?:stay|hold) at|(?:the |the [\p{L} -]+'s )(?:current )?(?:asking )?(?:price|amount) (?:is(?: still)?|remains)|the [\p{L} '-]+ is (?:still )?(?:holding at|asking))\s+/iu;

/** The code gate already checked both the public amount and the authorized move. */
function flagsOnlyAPublicAsk(reply: string, quote: string, publicAmounts: string[], move: string | undefined): boolean {
  if (!move || !PUBLIC_ASK_MOVES.has(move)) return false;
  const quotedText = normalizeForQuoteMatch(quote).replace(/[.!?]$/, "");
  if (!PUBLIC_ASK_PREFIX.test(quotedText)) return false;
  return reply.split(/(?<=[.!?])\s+/).some((line) => {
    const sentence = normalizeForQuoteMatch(line).replace(/[.!?]$/, "");
    if (!sentence.includes(quotedText) || !PUBLIC_ASK_PREFIX.test(sentence)) return false;
    const amount = sentence.replace(PUBLIC_ASK_PREFIX, "").replace(/ (?:for now|at the moment)$/, "").trim();
    return publicAmounts.some((value) => normalizeForQuoteMatch(value) === amount);
  });
}

function flagsOnlyAnAttributedBudget(reply: string, quote: string, budget: string | null | undefined): boolean {
  if (!budget) return false;
  const quoted = normalizeForQuoteMatch(quote).replace(/[.!?]$/, "");
  if (!/^(?:you(?:'ve| have)? (?:said|stated|told me|mentioned)|your stated budget)\b/.test(quoted)) return false;
  const amount = normalizeForQuoteMatch(budget);
  return reply.split(/(?<=[.!?])\s+/).some((line) => {
    const sentence = normalizeForQuoteMatch(line).replace(/[.!?]$/, "");
    if (!sentence.includes(quoted) || !sentence.endsWith(amount)) return false;
    const attribution = sentence.slice(0, -amount.length).trimEnd();
    return /^(?:you(?:'ve| have)? (?:said|stated|told me|mentioned)(?: that)? your (?:budget|ceiling|spending limit)(?: is)?|your stated budget is)(?: (?:not more than|no more than|at most|capped at))?$/.test(attribution);
  });
}

export async function languageCheck(
  llm: StructuredLlm,
  input: { reply: string; checkedTerms: string[]; permittedFacts: string[]; counterpartyWords: string[]; currentMessage?: string | null; publicAmounts?: string[]; statedBudget?: string | null; questionObjective?: string | null; selectedQuestion?: string | null; declinedTerms?: string[]; validatedTermsMarker?: string; action?: { move: string; notice: string | null; opening: boolean; approvalGranted: boolean; outcome: string } },
): Promise<{ ok: true; concerns: LanguageConcern[] } | { ok: false }> {
  try {
    const response = await llm.generate({
      purpose: "language_check",
      system: LANGUAGE_CHECK_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            { reply: input.reply, action: input.action ?? null, validated_terms_marker: input.validatedTermsMarker ?? null, checked_terms: input.checkedTerms, declined_terms: input.declinedTerms ?? [], permitted_facts: input.permittedFacts, their_message: input.currentMessage ?? null, public_amounts: input.publicAmounts ?? [], stated_budget: input.statedBudget ?? null, question_objective: input.questionObjective ?? null, selected_question: input.selectedQuestion ?? null, counterparty_words: input.counterpartyWords.slice(-4) },
            null,
            2,
          ),
        },
      ],
      schema: { name: "kritva_language_check", jsonSchema: SCHEMA },
    });
    const raw = (response.json as { concerns?: unknown }).concerns;
    if (!Array.isArray(raw)) return { ok: false };
    // Keep only concerns that quote the reply itself; a model cannot block on text that is not there.
    const concerns = raw
      .filter((c): c is LanguageConcern => typeof c?.type === "string" && typeof c?.quote === "string")
      .filter((c) => c.quote.trim().length > 0 && input.reply.toLowerCase().includes(c.quote.trim().toLowerCase().slice(0, 40)))
      .filter((c) => {
        if ((c.type === "private_disclosure" || c.type === "invented_fact") && flagsOnlyAPublicAsk(input.reply, c.quote, input.publicAmounts ?? [], input.action?.move)) return false;
        return (c.type !== "counterparty_claim_as_fact" && c.type !== "private_disclosure") || !flagsOnlyAnAttributedBudget(input.reply, c.quote, input.statedBudget);
      });
    return { ok: true, concerns };
  } catch {
    return { ok: false };
  }
}
