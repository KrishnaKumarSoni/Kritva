/**
 * Code checks on reply wording that the amount checks cannot see (Epic 6, Story 2).
 *
 * - limit_identified: calling any price a minimum, floor or last price is never allowed.
 *   Offering a permitted amount is fine; saying it is the private limit is not.
 * - invented_competition, invented_deadline, market_claim: never asserted without a source.
 * - promise_outside_terms: the reply may not promise a service or extra the checked terms exclude.
 *
 * These are deliberately conservative English patterns. A model-based language check runs on
 * composed text as a second layer; neither is a universal guarantee.
 */
import { straightApostrophes } from "../negotiation/reply-check.ts";
import type { OfferTerm } from "../record/events.ts";

export interface ClaimViolation {
  rule: "limit_identified" | "invented_competition" | "invented_deadline" | "market_claim" | "promise_outside_terms";
  detail: string;
}

const LIMIT_IDENTIFIED = [
  /\b(the |my |our |his |her |their |\w+'?s )?(absolute |bare )?(minimum|floor|bottom[- ]line|rock[- ]bottom|reserve price)\b/i,
  /\blowest (price )?(the \w+|they|he|she|we|i) (can|will|would) (go|accept|take|do)\b/i,
  /\b(can'?t|cannot|won'?t|will not|unable to) go (any )?(lower|below|under)\b/i,
  /\b(below|under) (that|this|it),? (the \w+|they|he|she|we|i) (can'?t|cannot|won'?t)\b/i,
  // Hindi and Tamil: "can't go below this", "minimum price". Indic scripts have no \b, so plain sequences.
  /(इससे|इस से|इसके|इसके नीचे|इस)\s*(कम|नीचे)\s*(नहीं|ना)/u,
  /(न्यूनतम|मिनिमम|कम से कम)\s*(कीमत|दाम|रेट|प्राइस|क़ीमत)/u,
  /(இதற்கு|இதுக்கு|இதை விட)\s*(கீழே|குறைவா|குறைவாக|குறைய)\s*(முடியாது|இல்லை|இயலாது)/u,
  /(குறைந்தபட்ச|மினிமம்)\s*(விலை)/u,
  /\b(?:my|our|its|it's (?:the|my|our)|that's (?:the|my|our)|this is (?:the|my|our)|is (?:the|my|our)) (?:best|final|last|lowest|bottom) (?:price|rate|offer|figure|number)\b/i,
  // "the best / final rate" in Hindi and Tamil: calling an amount the best or last one names a limit.
  /(सबसे\s*(?:सही|अच्छा|अच्छी|बढ़िया|कम|बेस्ट)|आख़िरी|आखिरी|अंतिम|फ़ाइनल|फाइनल|लास्ट|बेस्ट)\s*(रेट|दाम|कीमत|क़ीमत|प्राइस)/u,
  /(கடைசி|சிறந்த|ஃபைனல்|பெஸ்ட்)\s*(விலை|ரேட்)/u,
];
/**
 * Saying the price has room ("I can move a little", "there's some flexibility") gives the limit away just
 * as surely as naming it. Only a move that puts a new checked amount to them (a counter) may talk about moving.
 */
const ROOM_TO_MOVE = [
  /\b(?!you\b)\w+\s+(?:can|could|might|may)\s+(?:still\s+)?(?:move|come down|go down|drop|budge|flex|shift|adjust|bring it down|reduce)(?:\s+(?:it|the price|on (?:the )?price))?(?:\s+down)?\s+(?:a (?:little|bit|touch)|a little bit|slightly|somewhat|some)\b/i,
  /\b(?:some|a little|a bit of|a little bit of|any)\s+(?:room|flexibility|wiggle room|leeway)\b(?!\s+(?:in|on|with|for)\s+your\b)/i,
  /\bthere(?:'s| is) (?:still )?(?:some |a little |a bit of )?room\b/i,
  /\b(?:i'm|i am|we're|we are|they're|they are)\s+(?:a (?:little|bit) |somewhat )?flexible on (?:the )?(?:price|it)\b/i,
  /(?:दाम|कीमत|रेट|प्राइस|नंबर|उसी|इसी|\p{Sc}[\d,]+)\s*(?:के\s*)?आसपास/u,
  /थोड़ा\s*(?:और\s*)?(?:कम|नीचे)\s*(?:कर|हो)\s*(?:सकता|सकती|सकते|सकें|पाएगा|जाएगा)/u,
  /கொஞ்சம்\s*(?:குறைக்க|குறைச்சு|குறைத்து)/u,
];
/** The counterparty's own role word (e.g. from the mandate) is added at runtime, so no role is hard-coded. */
function competitionPattern(role: string | null): RegExp {
  const roleWord = role ? `|${role.replace(/[^\p{L}\s-]/gu, "").trim()}s?` : "";
  return new RegExp(
    `\\b(other|another|several|many|lots of|a few|multiple) (people|offers?|bidders?|takers?|interested (people|parties)${roleWord})\\b|\\bsomeone else (is |was )?(interested|keen|offering|offered|wants|asked|buying)\\b|\\bhigh demand\\b|\\b(getting|had|have) (a lot of|lots of|plenty of) (interest|enquiries|inquiries)\\b`,
    "iu",
  );
}
const DEADLINE = /\btoday only\b|\bonly today\b|\boffer (expires|ends|is valid until)\b|\blast chance\b|\blimited time\b|\bby (tonight|end of (the )?day)\b|\bbefore (it'?s|it is) gone\b/i;
const MARKET = /\bmarket (price|value|rate)\b|\bretail (price|cost)s?\b|\b(price|cost)s? (when|if bought|brand) new\b|\bnew (price|cost)s? (of|is|was) (a|an|the|one|this|it)\b|\bworth (at least|more than|much more)\b|\b(costs?|sells?) for \S+ new\b|\bbelow market\b/i;
/**
 * Kritva cannot hand a call or chat over to the person it represents, so offering to ("I'll put you through",
 * "मालिक से बात कराऊँ") is a promise it cannot keep. Saying it can't ("I can't put you through") is fine.
 */
const HANDOFF = [
  /\b(?:i|we)(?:'ll| will| can| could| would)? (?:put you through|connect you|transfer you|pass you (?:on |over )?to|hand you (?:over )?to|get (?:them|him|her|\w+) on the (?:line|phone)|have (?:them|him|her|\w+) call you|arrange a call)\b/i,
  /बात (?:कराऊँ|कराऊं|करा दूँ|करा दूं|करवा दूँ|करवा दूं|करवाता|कराता|कराती|करवाती|करवा देता|करा देता)|कनेक्ट (?:कर दूँ|कर दूं|करवा|करा)/u,
  /பேச வைக்கிறேன்|இணைக்கிறேன்|இணைத்து விடுகிறேன்|கனெக்ட் (?:பண்ணுகிறேன்|பண்றேன்|செய்கிறேன்)/u,
];
const PROMISE = /\b(we|i)( will|'ll| can| could| would)? (deliver|drop (it )?off|bring (it )?(over|to you)|assemble|install|include|throw in|add in)\b/i;

export function checkClaims(reply: string, checked: { offerTerms: OfferTerm[] | null; termNames: Map<string, string>; counterpartyRole?: string | null; concession?: boolean }): ClaimViolation[] {
  // "can’t go lower" is the same claim as "can't go lower".
  const text = straightApostrophes(reply);
  const violations: ClaimViolation[] = [];
  for (const pattern of LIMIT_IDENTIFIED) {
    if (pattern.test(text)) {
      violations.push({ rule: "limit_identified", detail: "Describes a price as a minimum or limit." });
      break;
    }
  }
  if (!checked.concession && ROOM_TO_MOVE.some((pattern) => pattern.test(text))) {
    violations.push({ rule: "limit_identified", detail: "Hints that the price has room to move without offering a new amount." });
  }
  if (competitionPattern(checked.counterpartyRole ?? null).test(text)) violations.push({ rule: "invented_competition", detail: "Mentions competing interest or demand." });
  if (DEADLINE.test(text)) violations.push({ rule: "invented_deadline", detail: "States a deadline the principal did not set." });
  if (HANDOFF.some((pattern) => pattern.test(text))) violations.push({ rule: "promise_outside_terms", detail: "Offers to connect them with the person represented, which Kritva cannot do." });
  if (MARKET.test(text)) violations.push({ rule: "market_claim", detail: "Makes a market or value claim with no source." });

  const promise = PROMISE.exec(text);
  if (promise) {
    // Allowed only when the checked terms include a matching service set to yes.
    const promisedWord = promise[3]!.split(" ")[0]!.toLowerCase();
    const included = (checked.offerTerms ?? []).some((t) => {
      const name = (checked.termNames.get(t.termId) ?? "").toLowerCase();
      return t.value.type === "boolean" && t.value.value === true && name.includes(promisedWord.slice(0, 5));
    });
    const negated = /\b(not|n't|no|never|unable|can'?t|cannot)\b[^.!?]{0,20}$/i.test(text.slice(0, promise.index));
    if (!included && !negated) violations.push({ rule: "promise_outside_terms", detail: "Promises something the checked terms do not include." });
  }
  return violations;
}
