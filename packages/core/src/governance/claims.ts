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
const PROMISE = /\b(we|i)( will|'ll| can| could| would)? (deliver|drop (it )?off|bring (it )?(over|to you)|assemble|install|include|throw in|add in)\b/i;

export function checkClaims(text: string, checked: { offerTerms: OfferTerm[] | null; termNames: Map<string, string>; counterpartyRole?: string | null }): ClaimViolation[] {
  const violations: ClaimViolation[] = [];
  for (const pattern of LIMIT_IDENTIFIED) {
    if (pattern.test(text)) {
      violations.push({ rule: "limit_identified", detail: "Describes a price as a minimum or limit." });
      break;
    }
  }
  if (competitionPattern(checked.counterpartyRole ?? null).test(text)) violations.push({ rule: "invented_competition", detail: "Mentions competing interest or demand." });
  if (DEADLINE.test(text)) violations.push({ rule: "invented_deadline", detail: "States a deadline the principal did not set." });
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
