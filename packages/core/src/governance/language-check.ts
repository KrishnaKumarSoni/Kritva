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
- "public_amounts": asking amounts already shared with the other party. Stating an authorized asking amount in a direct answer, hold or explanation is not private disclosure. Flag identifying an amount as a private floor, ceiling or refusal point, even if that amount is public. Separately check whether citing an amount fits "action". For "answer_public_terms", use permitted_facts to verify the answer, including whether the value is current or historical. Flag presenting it as a new proposal or commitment.
- On "price_pressure", holding the public ask and inviting a firm offer addresses the current message. On "answer_enquiry", "compare_terms", "explain_price" and "acknowledge_budget", saying a firm offer on the current terms can be considered keeps the action: it is not a new offer, a counter or an acceptance. On "compare_terms", asking how the packages differ addresses a cheaper comparison. Neither authorizes a discount.
- "their_message" is the turn the reply must address. Earlier counterparty_words give context only. "stated_budget" is the amount quoted from this turn. Calling it "your budget" or "your ceiling" is attribution to the person who stated it, not verification of a claim or disclosure of a private limit.
- A greeting followed by an invitation to speak directly addresses a standalone salutation. When "action.opening" is true, there is no counterparty message yet. Neither case is a turn mismatch or redundant question.
- "permitted_facts": confirmed facts, including the current public terms. Refer to them when relevant to the current message. A public term may be stated as a fact without authorizing a new offer, also in everyday words (for example who collects, where, or that a service isn't included).
- An introduction that names Kritva as the assistant of the person in permitted_facts is an authorized fact, not a counterparty claim. A public asking amount is the represented side's own term, never a counterparty claim.
- "declined_terms": terms it may say cannot be changed.
- The selected question and objective, when present, concern information still needed. Check the actual question against their_message and older answers. Do not flag asking about unresolved information.
- It may also decline something, refuse to share private details, ask a question, or say it will check with the person it represents. These are never concerns: saying "I can't share private details" is a refusal, not a disclosure; saying a declined term can't be changed is not an invented fact; saying you don't have a detail or will check is not an invented fact; saying you can only go by the terms the person you represent shared is not an invented fact; saying you have no market comparison is not a claim of any kind; answering their question with permitted_facts (what is offered, its age, condition or other listed details) addresses the current message, even when it gives several facts; naming the requested value while saying a declined term stays as it is (for example "delivery to <place> isn't included") is not an invented fact; asking about something the counterparty said is not treating it as fact.

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
- action_mismatch: changes the action in "action.move" or "action.notice". An opening before the other party has spoken only welcomes them and invites them to speak. For "state_final_terms", asking the other party to confirm the full package is required, and that question is not a claim of agreement. Flag that move only if the reply says the package is already agreed, asks for something other than full confirmation, or otherwise changes the action. A budget ceiling, enquiry, or price explanation does not authorize a new offer, an acceptance, or a counter. For "request_approval", saying it needs the approval of the person represented, so it cannot be confirmed yet, is the action. An agreement confirmation may announce explicit approval only when "action.approvalGranted" is true. While paused, waiting for approval or ended, reflect that state without making a new commitment.

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

const PUBLIC_ASK_MOVES = new Set(["hold", "explain_price", "acknowledge_budget", "answer_enquiry", "answer_public_terms", "explore_objection", "price_pressure", "compare_terms"]);
const PUBLIC_ASK_PREFIX = /^(?:i(?:'d| would) like to stay at|i(?:'m| am) (?:staying|holding) at|i(?:'ll| will) (?:stay|hold) at|(?:the |the [\p{L} -]+'s )(?:current )?(?:asking )?(?:price|amount|ask) (?:is(?: still)?|remains)|the [\p{L} '-]+ is (?:still )?(?:holding at|asking))\s+/iu;
/** "<amount> is the current price": the amount first. */
const PUBLIC_ASK_SUFFIX = /\s+(?:is|remains) (?:still )?the (?:current )?(?:asking )?(?:price|amount|ask)(?: for now| at the moment)?$/iu;

/** The amount a sentence or clause names as the public ask, or null when it says anything else. */
function publicAskAmount(text: string): string | null {
  const plain = normalizeForQuoteMatch(text).replace(/[.!?]$/, "").trim();
  if (PUBLIC_ASK_PREFIX.test(plain)) return plain.replace(PUBLIC_ASK_PREFIX, "").replace(/ (?:for now|at the moment)$/, "").trim();
  if (PUBLIC_ASK_SUFFIX.test(plain)) return plain.replace(PUBLIC_ASK_SUFFIX, "").trim();
  return null;
}

/** The code gate already checked both the public amount and the authorized move. */
function flagsOnlyAPublicAsk(reply: string, quote: string, publicAmounts: string[], move: string | undefined): boolean {
  if (!move || !PUBLIC_ASK_MOVES.has(move)) return false;
  const quotedText = normalizeForQuoteMatch(quote).replace(/[.!?]$/, "");
  if (publicAskAmount(quotedText) === null) return false;
  // The whole sentence must be the statement, so a quote cannot hide a disclosure next to it.
  return reply.split(/(?<=[.!?])\s+/).some((line) => {
    const sentence = normalizeForQuoteMatch(line).replace(/[.!?]$/, "");
    const amount = sentence.includes(quotedText) ? publicAskAmount(sentence) : null;
    return amount !== null && publicAmounts.some((value) => normalizeForQuoteMatch(value) === amount);
  });
}

/**
 * A public ask is the represented side's own term, so it can never be a counterparty claim. The quote
 * itself must state nothing but the public ask; other words in the sentence are reviewed on their own.
 */
function quotesOnlyAPublicAsk(reply: string, quote: string, publicAmounts: string[]): boolean {
  const amount = publicAskAmount(quote);
  return amount !== null && normalizeForQuoteMatch(reply).includes(normalizeForQuoteMatch(quote).replace(/[.!?]$/, ""))
    && publicAmounts.some((value) => normalizeForQuoteMatch(value) === amount);
}

const INTRO_FILLER = new Set(["hi", "hello", "hey", "namaste", "there", "i", "i'm", "im", "am", "this", "is", "kritva", "here", "the", "an", "a", "ai", "assistant", "assisting", "helping", "working", "for", "to", "of", "on", "behalf", "and", "with", "you", "'s", "s"]);

/** The quote sits in a sentence that only introduces Kritva as the named person's assistant. */
function flagsOnlyAnIntroduction(reply: string, quote: string, principal: string | null | undefined): boolean {
  if (!principal) return false;
  const quoted = normalizeForQuoteMatch(quote).replace(/[.!?]$/, "");
  const name = normalizeForQuoteMatch(principal);
  return reply.split(/(?<=[.!?])\s+/).some((line) => {
    const sentence = normalizeForQuoteMatch(line).replace(/[.!?]$/, "");
    if (!sentence.includes(quoted) || !/\bkritva\b/.test(sentence) || !sentence.includes(name)) return false;
    const rest = sentence.replace(name, " ").replace(/'s\b/g, " 's").split(/[^\p{L}']+/u).filter(Boolean);
    return rest.every((word) => INTRO_FILLER.has(word));
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

const APPROVAL_WORDS = new Set(["the", "has", "have", "approved", "approval", "is", "given", "granted", "received", "it", "this", "that", "that's", "and", "so", "we", "we're", "we've", "are", "agreed", "agreement", "reached", "an", "a", "on", "for", "full", "complete", "package", "terms", "these", "those", "you", "your", "good", "great", "news", "now", "both", "with", "'s", "s"]);

/**
 * Code checked that the principal's approval is on record (approvalGranted), so a sentence that only
 * announces that approval and the agreement on the inserted terms asserts nothing new.
 */
function flagsOnlyARecordedApproval(reply: string, quote: string, principal: string | null | undefined, action: { move: string; approvalGranted: boolean } | undefined, marker: string | undefined): boolean {
  if (!action?.approvalGranted || action.move !== "confirm_agreement") return false;
  const quoted = normalizeForQuoteMatch(quote).replace(/[.!?]$/, "");
  return reply.split(/(?<=[.!?])\s+/).some((line) => {
    let sentence = normalizeForQuoteMatch(line).replace(/[.!?]$/, "");
    if (!sentence.includes(quoted) || !/\bapprov/.test(sentence)) return false;
    if (marker) sentence = sentence.replace(normalizeForQuoteMatch(marker), " ");
    if (principal) sentence = sentence.replace(normalizeForQuoteMatch(principal), " ");
    const rest = sentence.replace(/'s\b/g, " 's").split(/[^\p{L}']+/u).filter(Boolean);
    return rest.every((word) => APPROVAL_WORDS.has(word) || (principal ?? "").toLowerCase().split(/\s+/).includes(word));
  });
}

const DECLINE_PHRASE = /\b(?:isn't|is not|aren't|are not|won't be|can't be|cannot be) (?:included|available|offered|possible|part of (?:this|the) (?:sale|deal|terms))\b/;
const DECLINE_FILLER = new Set(["so", "that", "part", "the", "sorry", "but", "unfortunately", "i'm", "afraid", "to", "at", "in", "for", "and", "it", "is", "as", "here", "this", "time", "option", "an", "a", "i", "can't", "offer", "that's", "not", "something", "can", "isn't", "though"]);

/** "Delivery to <their place> isn't included": a declined term, with the value they asked for, said to stay as it is. */
function flagsOnlyADecline(reply: string, quote: string, declinedTerms: string[], currentMessage: string | null | undefined): boolean {
  if (declinedTerms.length === 0) return false;
  const quoted = normalizeForQuoteMatch(quote).replace(/[.!?]$/, "");
  const theirs = new Set(normalizeForQuoteMatch(currentMessage ?? "").split(/[^\p{L}']+/u).filter(Boolean));
  const stems = declinedTerms.flatMap((name) => normalizeForQuoteMatch(name).replace(/\s+included$/, "").split(/\s+/));
  return reply.split(/(?<=[.!?])\s+|,\s+/).some((line) => {
    const clause = normalizeForQuoteMatch(line).replace(/[.!?]$/, "");
    if (!(clause.includes(quoted) || quoted.includes(clause)) || !DECLINE_PHRASE.test(clause)) return false;
    const rest = clause.replace(DECLINE_PHRASE, " ").split(/[^\p{L}']+/u).filter(Boolean);
    return rest.some((word) => stems.includes(word)) && rest.every((word) => stems.includes(word) || theirs.has(word) || DECLINE_FILLER.has(word));
  });
}

export async function languageCheck(
  llm: StructuredLlm,
  input: { reply: string; principal?: string | null; checkedTerms: string[]; permittedFacts: string[]; counterpartyWords: string[]; currentMessage?: string | null; publicAmounts?: string[]; statedBudget?: string | null; questionObjective?: string | null; selectedQuestion?: string | null; declinedTerms?: string[]; validatedTermsMarker?: string; action?: { move: string; notice: string | null; opening: boolean; approvalGranted: boolean; outcome: string } },
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
        if (c.type === "counterparty_claim_as_fact" && quotesOnlyAPublicAsk(input.reply, c.quote, input.publicAmounts ?? [])) return false;
        if ((c.type === "counterparty_claim_as_fact" || c.type === "invented_fact") && flagsOnlyAnIntroduction(input.reply, c.quote, input.principal)) return false;
        if ((c.type === "invented_fact" || c.type === "action_mismatch") && flagsOnlyARecordedApproval(input.reply, c.quote, input.principal, input.action, input.validatedTermsMarker)) return false;
        if (c.type === "invented_fact" && flagsOnlyADecline(input.reply, c.quote, input.declinedTerms ?? [], input.currentMessage)) return false;
        return (c.type !== "counterparty_claim_as_fact" && c.type !== "private_disclosure") || !flagsOnlyAnAttributedBudget(input.reply, c.quote, input.statedBudget);
      });
    return { ok: true, concerns };
  } catch {
    return { ok: false };
  }
}
