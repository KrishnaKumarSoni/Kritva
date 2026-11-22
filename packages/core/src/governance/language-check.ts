/**
 * Model-based language check (Epic 6, Story 2): a second layer after the code checks, for
 * indirect disclosure and unsupported claims that patterns miss.
 *
 * The checker sees only what the reply is allowed to rely on (checked terms and permitted
 * facts) plus the counterparty's own words, so it can tell a repeated claim from an assertion.
 * It never sees private limits. Any concern, or any failure to run, blocks the reply.
 */
import { findAmounts } from "../negotiation/reply-check.ts";
import type { StructuredLlm } from "../llm/types.ts";
import { normalizeForQuoteMatch } from "../schema/quotes.ts";

export const LANGUAGE_CHECK_PROMPT = `You review one reply that an agent is about to send in a negotiation. Flag problems; do not rewrite.

When "validated_terms_marker" is present, the marker stands for the exact terms the system has checked and will insert. Review the surrounding words only. Referring to that package or asking to confirm it does not assert a new fact.

The reply may only rely on:
- "checked_terms": the exact terms it is allowed to offer or confirm.
- "public_amounts": asking amounts already shared with the other party. Stating an authorized asking amount in a direct answer, hold or explanation is not private disclosure. Flag identifying an amount as a private floor, ceiling or refusal point, even if that amount is public. Separately check whether citing an amount fits "action". For "answer_public_terms", use permitted_facts to verify the answer, including whether the value is current or historical. Flag presenting it as a new proposal or commitment.
- On "price_pressure", holding the public ask and inviting a firm offer addresses the current message. On "answer_enquiry", "compare_terms", "explain_price" and "acknowledge_budget", saying a firm offer on the current terms can be considered keeps the action: it is not a new offer, a counter or an acceptance. On "compare_terms", asking how the packages differ addresses a cheaper comparison. Neither authorizes a discount.
- "their_message" is the turn the reply must address. Earlier counterparty_words give context only. "stated_budget" is the amount quoted from this turn. Calling it "your budget" or "your ceiling" is attribution to the person who stated it, not verification of a claim or disclosure of a private limit.
- When "their_message" is null, the reply was started by an event (a greeting, an approval decision, the represented person ending or pausing), not by a message: there is no turn to mismatch, and reflecting that event is the action. For "end_negotiation", saying the person you represent decided to stop and closing politely without agreement is the action. A greeting followed by an invitation to speak directly addresses a standalone salutation. When "action.opening" is true, there is no counterparty message yet. Neither case is a turn mismatch or redundant question.
- "permitted_facts": confirmed facts, including the current public terms. Refer to them when relevant to the current message. A public term may be stated as a fact without authorizing a new offer, also in everyday words (for example who collects, where, or that a service isn't included).
- An introduction that names Kritva as the assistant of the person in permitted_facts is an authorized fact, not a counterparty claim. A public asking amount is the represented side's own term, never a counterparty claim.
- "declined_terms": terms it may say cannot be changed.
- The selected question and objective, when present, concern information still needed. Check the actual question against their_message and older answers. Do not flag asking about unresolved information.
- It may also decline something, refuse to share private details, ask a question, or say it will check with the person it represents. These are never concerns: saying "I can't share private details" is a refusal, not a disclosure; saying a declined term can't be changed is not an invented fact; saying you don't have a detail or will check is not an invented fact; saying you can only go by the terms the person you represent shared is not an invented fact; saying you have no market comparison is not a claim of any kind; saying you don't have the asked detail confirmed and offering to check fully answers a question about that detail; answering their question with permitted_facts (what is offered, its age, condition or other listed details) addresses the current message, even when it gives several facts; naming the requested value while saying a declined term stays as it is (for example "delivery to <place> isn't included") is not an invented fact; asking about something the counterparty said is not treating it as fact.

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
- action_mismatch: changes the action in "action.move" or "action.notice". An opening before the other party has spoken only welcomes them and invites them to speak. For "state_final_terms", asking the other party to confirm the full package is required, and that question is not a claim of agreement. Flag that move only if the reply says the package is already agreed, asks for something other than full confirmation, or otherwise changes the action. For "counter" and "hold", putting the amount in checked_terms to them as your offer ("I can do <amount>", "How about <amount>?") is the action, not a mismatch. A budget ceiling, enquiry, or price explanation does not authorize a new offer, an acceptance, or a counter. For "request_approval", saying it needs the approval of the person represented, so it cannot be confirmed yet, is the action. An agreement confirmation may announce explicit approval only when "action.approvalGranted" is true. While paused, waiting for approval or ended, reflect that state without making a new commitment. "action.followUp" names a step around the represented person's approval: "validity", "contact" and "phone" ask how long the offer stands or how to reach them; "close" says it is not final until the represented person confirms and that you will get back to them (that promise is the action); "approved" says the represented person confirmed the terms and asks whether they still work for the other party (with "action.approvalGranted" true, that is the action, not a claim of agreement); "countered" puts the represented person's new terms to them as what that person can do; "declined" says that person can't do it and asks whether you may keep in touch; "keep_contact" thanks them for answering. A message the represented person asked to pass on is in permitted_facts.

Saying an amount that is in checked_terms is fine. Saying you don't have a detail is fine. Return no concerns when there are none.

For each concern, give a short "reason" naming the rule and what in the quote breaks it, and a "severity":
- "violation": the quoted words clearly break one of the rules above as defined. Only these stop the reply.
- "doubt": anything you are unsure about, or that only might be read that way.
Ordinary acknowledgements ("I hear you", "I understand you'd like it lower", "noted"), restating the current asking amount (also with "for now" or "I can keep it at"), attributing a figure to what they said ("I see your budget is X"), and answering their question from permitted_facts are never violations.`;

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
          reason: { type: "string" },
          severity: { type: "string", enum: ["violation", "doubt"] },
        },
        required: ["type", "quote", "reason", "severity"],
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
const PUBLIC_ASK_PREFIX = /^(?:(?:for now|right now|still),?\s+)?(?:i(?:'d| would) like to stay at|i(?:'m| am) (?:staying|holding|keeping it) at|i(?:'ll| will) (?:stay|hold|keep it) at|i can (?:stay|hold|keep it) at|(?:it|the price) (?:stays|remains|is still) at|(?:the |the [\p{L} -]+'s )(?:current )?(?:asking )?(?:price|amount|ask) (?:is(?: still)?|remains)|the [\p{L} '-]+ is (?:still )?(?:holding at|asking))\s+/iu;
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

const OFFER_PHRASE = /^(?:(?:so|well|okay|ok|then|right),?\s+)?(?:i can do|i could do|i can offer|i could offer|i can go to|i could go to|how about|what about|i(?:'d| would) like to stay at|i(?:'m| am) staying at|i(?:'ll| will) stay at|i can stay at|i can keep it at|i(?:'ll| will) keep it at|i can bring it(?: down)? to|i could bring it(?: down)? to|i can come(?: down)? to|i could come(?: down)? to|i can let it go for|i can sell it for|my price is|my price would be)\s+(.+?)(?:\s+for (?:it|this|that|the [\p{L} -]{1,30}|you))?(?:\s+(?:then|for now|at the moment|instead))?$/u;

/**
 * Code chose the counter or hold and checked its amount, so a sentence that only puts that amount to
 * them as the offer is the action itself, never a mismatch or an invented fact.
 */
function flagsOnlyTheOffer(reply: string, quote: string, checkedTerms: string[], move: string | undefined): boolean {
  if (move !== "counter" && move !== "hold") return false;
  const quoted = normalizeForQuoteMatch(quote).replace(/[.!?]$/, "");
  const offered = checkedTerms.map((t) => normalizeForQuoteMatch(t.slice(t.indexOf(": ") + 2)));
  // The quote may be just the offer clause of a longer sentence ("..., and I can bring it to X").
  const own = OFFER_PHRASE.exec(quoted.replace(/^(?:and|but|so|then),?\s+/, ""))?.[1]?.trim();
  if (own !== undefined && offered.includes(own)) return true;
  return reply.split(/(?<=[.!?])\s+/).some((line) => {
    const sentence = normalizeForQuoteMatch(line).replace(/[.!?]$/, "");
    if (!sentence.includes(quoted)) return false;
    const amount = OFFER_PHRASE.exec(sentence)?.[1]?.trim();
    return amount !== undefined && offered.includes(amount);
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

const APPROVAL_WORDS = new Set(["thanks", "thank", "great", "perfect", "wonderful", "then", "you're", "all", "the", "has", "have", "approved", "approval", "is", "given", "granted", "received", "it", "this", "that", "that's", "and", "so", "we", "we're", "we've", "are", "agreed", "agreement", "reached", "an", "a", "on", "for", "full", "complete", "package", "terms", "these", "those", "you", "your", "good", "great", "news", "now", "both", "with", "'s", "s"]);

/**
 * Code checked that the principal's approval is on record (approvalGranted), so a sentence that only
 * announces that approval and the agreement on the inserted terms asserts nothing new.
 */
/** "I don't have the material confirmed." asserts nothing about the item, so it cannot invent a fact. */
function onlyAdmitsNotKnowing(quote: string): boolean {
  const sentences = quote.replace(/[’‘]/g, "'").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const admits = /\b(?:(?:do not|don'?t|doesn'?t|does not) (?:have|know)|(?:isn'?t|is not|aren'?t|are not|wasn'?t|not) (?:been )?(?:confirmed|stated|listed|mentioned|given|shared|known)|(?:can'?t|cannot) (?:confirm|say)|no (?:confirmed )?(?:details?|information))\b/i;
  return sentences.length > 0 && sentences.every((s) => admits.test(s) && findAmounts(s).length === 0 && !/\b(?:but|though|although|however)\b/i.test(s));
}

function flagsOnlyARecordedApproval(reply: string, quote: string, principal: string | null | undefined, action: { move: string; approvalGranted: boolean } | undefined, marker: string | undefined): boolean {
  if (action?.move !== "confirm_agreement") return false;
  const quoted = normalizeForQuoteMatch(quote).replace(/[.!?]$/, "");
  return reply.split(/(?<=[.!?])\s+/).some((line) => {
    let sentence = normalizeForQuoteMatch(line).replace(/[.!?]$/, "");
    // Announcing the agreement is the move; announcing approval needs the recorded approval.
    if (!sentence.includes(quoted) || (/\bapprov/.test(sentence) && !action.approvalGranted)) return false;
    if (marker) sentence = sentence.replace(normalizeForQuoteMatch(marker), " ");
    if (principal) sentence = sentence.replace(normalizeForQuoteMatch(principal), " ");
    const rest = sentence.replace(/'s\b/g, " 's").split(/[^\p{L}']+/u).filter(Boolean);
    return rest.every((word) => APPROVAL_WORDS.has(word) || (principal ?? "").toLowerCase().split(/\s+/).includes(word));
  });
}

/** Words a follow-up line may use around the terms: news of the decision and the question back. Never agreement words. */
const FOLLOW_UP_WORDS = new Set(["thanks", "thank", "great", "good", "news", "the", "has", "have", "is", "it", "this", "that", "that's", "these", "those", "terms", "package", "confirmed", "confirm", "approved", "can", "could", "do", "instead", "still", "for", "you", "your", "would", "work", "works", "does", "okay", "ok", "now", "so", "and", "here", "what", "they", "them", "their", "offer", "a", "an", "on", "with", "at", "to", "is", "s", "'s", "come", "came", "back", "how", "about", "does", "sound", "all", "set", "right", "hi"]);

/**
 * A follow-up after the principal decided ("Good news, <name>'s confirmed [[TERMS]]. Still good for
 * you?", "<name> can do [[TERMS]]. Would that work?"): code recorded the decision (and for an
 * approval, approvalGranted), so a sentence made only of that news, the name and the terms asserts
 * nothing new. Agreement words never pass here; the code reply check also blocks them.
 */
function flagsOnlyAFollowUp(reply: string, quote: string, names: string[], action: { followUp?: string | null; approvalGranted: boolean } | undefined, marker: string | undefined): boolean {
  const step = action?.followUp;
  if (!marker || (step !== "approved" && step !== "countered") || (step === "approved" && !action!.approvalGranted)) return false;
  const quoted = normalizeForQuoteMatch(quote).replace(/[.!?]$/, "");
  const mark = normalizeForQuoteMatch(marker);
  if (!normalizeForQuoteMatch(reply).includes(mark)) return false;
  // Every sentence the flagged words touch must be only the follow-up's news, the name and the terms.
  const touched = reply
    .split(/(?<=[.!?])\s+/)
    .map((line) => normalizeForQuoteMatch(line).replace(/[.!?]$/, ""))
    .filter((sentence) => sentence.length > 0 && (sentence.includes(quoted) || quoted.includes(sentence)));
  return touched.length > 0 && touched.every((line) => {
    let sentence = line.replace(mark, " ");
    for (const name of names) if (name) sentence = sentence.replace(normalizeForQuoteMatch(name), " ");
    const rest = sentence.replace(/'s\b/g, " 's").split(/[^\p{L}']+/u).filter(Boolean);
    return rest.every((word) => FOLLOW_UP_WORDS.has(word));
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
  input: { reply: string; principal?: string | null; checkedTerms: string[]; permittedFacts: string[]; counterpartyWords: string[]; currentMessage?: string | null; publicAmounts?: string[]; statedBudget?: string | null; questionObjective?: string | null; selectedQuestion?: string | null; declinedTerms?: string[]; validatedTermsMarker?: string; principalNames?: string[]; action?: { move: string; notice: string | null; opening: boolean; approvalGranted: boolean; outcome: string; followUp?: string | null } },
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
      // Only a clear violation stops a reply; a doubt is the reviewer's hesitation, not a broken rule.
      .filter((c) => (c as { severity?: unknown }).severity !== "doubt")
      .filter((c) => c.quote.trim().length > 0 && input.reply.toLowerCase().includes(c.quote.trim().toLowerCase().slice(0, 40)))
      .filter((c) => {
        if ((c.type === "private_disclosure" || c.type === "invented_fact") && flagsOnlyAPublicAsk(input.reply, c.quote, input.publicAmounts ?? [], input.action?.move)) return false;
        if (c.type === "counterparty_claim_as_fact" && quotesOnlyAPublicAsk(input.reply, c.quote, input.publicAmounts ?? [])) return false;
        if (["action_mismatch", "invented_fact", "private_disclosure", "promise_outside_terms"].includes(c.type) && flagsOnlyTheOffer(input.reply, c.quote, input.checkedTerms, input.action?.move)) return false;
        if ((c.type === "counterparty_claim_as_fact" || c.type === "invented_fact") && flagsOnlyAnIntroduction(input.reply, c.quote, input.principal)) return false;
        if ((c.type === "invented_fact" || c.type === "action_mismatch") && flagsOnlyARecordedApproval(input.reply, c.quote, input.principal, input.action, input.validatedTermsMarker)) return false;
        if ((c.type === "invented_fact" || c.type === "action_mismatch") && flagsOnlyAFollowUp(input.reply, c.quote, [input.principal ?? "", ...(input.principalNames ?? [])], input.action, input.validatedTermsMarker)) return false;
        if (c.type === "invented_fact" && flagsOnlyADecline(input.reply, c.quote, input.declinedTerms ?? [], input.currentMessage)) return false;
        if (c.type === "invented_fact" && onlyAdmitsNotKnowing(c.quote)) return false;
        return (c.type !== "counterparty_claim_as_fact" && c.type !== "private_disclosure") || !flagsOnlyAnAttributedBudget(input.reply, c.quote, input.statedBudget);
      });
    return { ok: true, concerns };
  } catch {
    return { ok: false };
  }
}
