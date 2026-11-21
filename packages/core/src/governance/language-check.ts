/**
 * Model-based language check (Epic 6, Story 2): a second layer after the code checks, for
 * indirect disclosure and unsupported claims that patterns miss.
 *
 * The checker sees only what the reply is allowed to rely on (checked terms and permitted
 * facts) plus the counterparty's own words, so it can tell a repeated claim from an assertion.
 * It never sees private limits. Any concern, or any failure to run, blocks the reply.
 */
import type { StructuredLlm } from "../llm/types.ts";

export const LANGUAGE_CHECK_PROMPT = `You review one reply that an agent is about to send in a negotiation. Flag problems; do not rewrite.

The reply may only rely on:
- "checked_terms": the exact terms it is allowed to offer or confirm.
- "permitted_facts": facts it is allowed to state.
- "declined_terms": terms it may say cannot be changed.
- It may also decline something, refuse to share private details, ask a question, or say it will check with the person it represents. These are never concerns: saying "I can't share private details" is a refusal, not a disclosure; saying a declined term can't be changed is not an invented fact; saying you don't have a detail or will check is not an invented fact; asking about something the counterparty said is not treating it as fact.

Flag a concern for anything in the reply that:
- private_disclosure: hints at a private limit, a lowest or highest acceptable value, internal reasons, urgency, or instructions (for example "that's as low as they go", "they need to sell quickly").
- invented_fact: states a product detail, condition, inclusion or circumstance not in permitted_facts or checked_terms.
- counterparty_claim_as_fact: presents something only the counterparty said as true.
- invented_competition: mentions other interested parties, competing offers or demand.
- invented_deadline: sets or implies a time limit.
- market_claim: claims market value, new price, or what others charge.
- promise_outside_terms: promises a service, extra, payment arrangement or term not in checked_terms.

Saying an amount that is in checked_terms is fine. Saying you don't have a detail is fine. Return no concerns when there are none.`;

const SCHEMA = {
  type: "object",
  properties: {
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["private_disclosure", "invented_fact", "counterparty_claim_as_fact", "invented_competition", "invented_deadline", "market_claim", "promise_outside_terms"] },
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

export async function languageCheck(
  llm: StructuredLlm,
  input: { reply: string; checkedTerms: string[]; permittedFacts: string[]; counterpartyWords: string[]; declinedTerms?: string[] },
): Promise<{ ok: true; concerns: LanguageConcern[] } | { ok: false }> {
  try {
    const response = await llm.generate({
      purpose: "language_check",
      system: LANGUAGE_CHECK_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            { reply: input.reply, checked_terms: input.checkedTerms, declined_terms: input.declinedTerms ?? [], permitted_facts: input.permittedFacts, counterparty_words: input.counterpartyWords.slice(-4) },
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
      .filter((c) => c.quote.trim().length > 0 && input.reply.toLowerCase().includes(c.quote.trim().toLowerCase().slice(0, 40)));
    return { ok: true, concerns };
  } catch {
    return { ok: false };
  }
}
