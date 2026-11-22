/**
 * Outgoing reply check. Runs in code on every reply before it is shown or spoken. A
 * prompt instruction is never relied on: a reply that fails here is blocked and recorded.
 *
 * Rules:
 * - private_amount: no private value (e.g. a private minimum) unless it is the value being offered.
 * - unplanned_amount: every amount is the planned offer, a public value, or one the counterparty said.
 * - crosses_limit: an amount beyond the principal's limit may only appear while declining it.
 * - missing_offer: a reply that carries an offer must state the offered amount.
 * - false_commitment: no claim of agreement or principal approval that the record does not hold.
 * - private_text: no passage copied from private instructions.
 * - missing_condition: an offer tied to an extra term (e.g. a day) must name it.
 * - internal_term: no internal vocabulary ("mandate", "governance", "ZOPA"…) in what the other party reads.
 * - invented_competition: no mention of another offer or other interest unless the plan carries a real
 *   one (`competingAmount`), and never a figure for it better for the principal than that one.
 */
import { normalizeForQuoteMatch } from "../schema/quotes.ts";
import type { MandateView } from "./mandate-view.ts";
import type { Plan } from "./policy.ts";

export interface ReplyViolation {
  /** "style" is a conversation-quality note from the draft review, never a limit. */
  rule: "private_amount" | "unplanned_amount" | "crosses_limit" | "missing_offer" | "missing_condition" | "false_commitment" | "private_text" | "internal_term" | "action_mismatch" | "invented_competition" | "style";
  detail: string;
}

export interface CheckContext {
  view: MandateView;
  plan: Plan;
  /** Amounts the counterparty itself stated in this session. */
  counterpartyAmounts: number[];
  /** Amounts the agent already put to the counterparty (its asks so far): already theirs to hear again. */
  statedAmounts?: number[];
}

const DECLINE_CUE = /\b(can'?t|cannot|can not|won'?t|unable|not able|(?:a bit|a little|bit|quite|rather|too|very|pretty|way) (?:low|high)|not possible|isn'?t|is not|no\b|decline|don'?t|do not|below|under|above|over|beyond)\b/i;
const AGREEMENT_CLAIM = /\b(we have (a |an )?(deal|agreement)|we(?:'re| are) agreed|it'?s (a deal|agreed)|deal (is )?(done|confirmed)|agreement (is )?(confirmed|recorded)|(sold|it'?s yours)\b|i accept (your|the) offer|offer accepted)/i;
/** "That works.", "Okay, it works for me", "19,000 works": agreeing, not "a price that works for both of us". */
const WORKS_CLAIM = /(?:^|[.!?]\s+|\b(?:yes|yeah|ok(?:ay)?|sure|great|perfect|alright|fine),?\s+)(?:that|it|this)\s+works\b|\d[\d,]*(?:\.\d+)?\s+works\b/i;
const APPROVAL_CLAIM = /\b(has|have) approved\b|\bapproved (it|this|your offer|the (offer|terms))\b|\bapproval (is )?(given|granted|received)\b/i;

/**
 * The same cues in Hindi and Tamil, so a reply in the other party's language is read like an English one.
 * Indic scripts have no \b word boundary in JavaScript, so these are plain sequences.
 */
const DECLINE_CUE_INDIC = /నాకు కుదరదు|కుదరదు|కాదు|లేదు|వీలు కాదు|సాధ్యం కాదు|ಆಗಲ್ಲ|ಆಗುವುದಿಲ್ಲ|ಇಲ್ಲ|ಸಾಧ್ಯವಿಲ್ಲ|പറ്റില്ല|ഇല്ല|സാധ്യമല്ല|না(?=[\s.,!?।]|$)|পারব না|সম্ভব নয়|नाही|जमणार नाही|नहीं|मुमकिन नहीं|संभव नहीं|मुश्किल|कम है|முடியாது|இயலாது|இல்லை|சாத்தியமில்லை|கஷ்டம்|குறைவு/u;
const AGREEMENT_CLAIM_INDIC = /डील (पक्की|हो गई|डन)|सौदा (पक्का|तय|हो गया)|बात पक्की|मंज़ूर है|मंजूर है|आपका हुआ|बिक गया|ஒப்பந்தம் (உறுதி|முடிந்தது|ஆனது)|டீல் (ஓகே|முடிந்தது|உறுதி)|உங்களுடையது/u;
const APPROVAL_CLAIM_INDIC = /(मंज़ूरी|मंजूरी|अप्रूवल) (दे दी|मिल गई|मिल गयी)|अप्रूव कर (दिया|दी)|ஒப்புதல் (கொடுத்தார்|கிடைத்தது|தந்தார்)|அப்ரூவ் (பண்ணிட்டார்|செய்தார்)/u;
/** "<amount> चलेगा" / "<amount> ஓகே": agreeing to a figure, unless it is asked as a question. */
const WORKS_CLAIM_INDIC = /\d[\d,]*\s*(?:में\s*)?(?:चलेगा|ठीक है|डन|डील पक्की|ஓகே|சரி|டீல்)(?![^।.!?]*\?)/u;
const QUOTE_CUE_INDIC = /మీ|మీరు|ನಿಮ್ಮ|ನೀವು|നിങ്ങളുടെ|നിങ്ങൾ|আপনার|আপনি|तुमचा|तुमची|आप|तुम|உங்கள்|நீங்கள்|உங்க|நீங்க/u;
const ACKNOWLEDGED_INDIC = /ధన్యవాదాలు|థ్యాంక్స్|ధన్యవాదాలు|ಧನ್ಯವಾದ|ಥ್ಯಾಂಕ್ಸ್|നന്ദി|ধন্যবাদ|থ্যাঙ্কস|धन्यवाद|शुक्रिया|थैंक|बताया|कहा|बजट|நன்றி|சொன்ன|பட்ஜெட்/u;
const OFFERING_INDIC = /ఇవ్వగలను|ఇస్తాను|ಕೊಡಬಹುದು|ಕೊಡುತ್ತೇನೆ|തരാം|തരാൻ പറ്റും|দিতে পারি|দেব|देऊ शकते|देऊ शकतो|कर सकता|कर सकती|कर सकते|दे सकता|दे सकती|दे सकते|चलेगा|ठीक रहेगा|डील|தர முடியும்|கொடுக்க முடியும்|பண்ணலாம்|செய்யலாம்|டீல்/u;
/** Hindi typed in Latin letters ("nahi kar sakti", "aapka offer", "chalega"). */
const DECLINE_CUE_TYPED = /\b(?:nahi|nahin|nhi|mushkil|possible nahi|nahi ho payega|nahi hoga)\b/i;
const QUOTE_CUE_TYPED = /\b(?:aap|aapka|aapki|aapke|tum|tumhara|tumhari)\b/i;
const ACKNOWLEDGED_TYPED = /\b(?:shukriya|dhanyavaad|bataya|bola|budget)\b/i;
const OFFERING_TYPED = /\b(?:kar sakti|kar sakta|kar sakte|de sakti|de sakta|de sakte|chalega|theek rahega|deal)\b/i;
const declines = (s: string) => DECLINE_CUE.test(s) || DECLINE_CUE_INDIC.test(s) || DECLINE_CUE_TYPED.test(s);
const quotes = (s: string) => QUOTE_CUE.test(s) || QUOTE_CUE_INDIC.test(s) || QUOTE_CUE_TYPED.test(s);
const acknowledges = (s: string) => ACKNOWLEDGED.test(s) || ACKNOWLEDGED_INDIC.test(s) || ACKNOWLEDGED_TYPED.test(s);
const offers = (s: string) => OFFERING.test(s) || OFFERING_INDIC.test(s) || OFFERING_TYPED.test(s);

const INTERNAL_TERM = /\b(mandate|governance|zopa|batna|parameter|principal|negotiation core|the core|strategy engine|guidance file|policy engine|score)\b/i;
/** snake_case identifiers (prompt or record field names) never belong in a reply. */
const FIELD_NAME = /\b[a-z]+_[a-z_]+\b/;
const QUOTE_CUE = /\?\s*$|\b(you|your|you're|you've)\b/i;
/** Their own figure acknowledged as theirs ("Thanks for the X offer", "X is noted"), not put forward as ours. */
const ACKNOWLEDGED = /\b(thanks|thank you|noted|offer of|the [^.!?]{0,12}offer|mentioned|said|budget)\b/i;
const OFFERING = /\b(i|we)(?:'ll| will| can| could)? (?:do|offer|accept|take|agree to|go (?:to|down to)|come down to)\b|\bhow about\b|\bworks\b|\bdeal\b/i;

/** Words that claim another offer or other interest. The counterparty's role (from the mandate) is added per check. */
const COMPETITION = String.raw`\b(?:another|other|second|competing|rival)\s+(?:firm\s+)?(?:offers?|bids?|quotes?)\b|\bsomeone else\s+(?:(?:has|is|also)\s+)*(?:offered|offering|interested|bidding|wants|made an offer)\b|\bother (?:people|parties|interested parties)\b|\b(?:others|people) (?:are|is) (?:also )?interested\b|\b(?:a lot of|lots of|more|other) interest\b`;

/**
 * Several counterparties: a reply may mention another offer only when code gave it a real one
 * (plan.competingAmount), and no figure in that sentence may be better for the principal than it.
 * Answering the counterparty's own claim about an alternative ("compare_terms", "price_pressure") is
 * allowed.
 */
function competitionViolations(text: string, sentences: string[], view: MandateView, plan: Plan): ReplyViolation[] {
  const role = view.counterpartyRole.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(role ? `${COMPETITION}|\\b(?:another|other|more|second)\\s+(?:interested\\s+)?${role}s?\\b` : COMPETITION, "i");
  if (!mention.test(text)) return [];
  if (plan.competingAmount === undefined) {
    if (plan.move === "compare_terms" || plan.move === "price_pressure") return [];
    return [{ rule: "invented_competition", detail: "Mentions competing interest or demand." }];
  }
  const n = view.negotiable;
  const out: ReplyViolation[] = [];
  for (const sentence of sentences) {
    if (!mention.test(sentence)) continue;
    for (const amount of findAmounts(sentence)) {
      const better = n ? (n.direction === "up" ? amount > plan.competingAmount : amount < plan.competingAmount) : amount !== plan.competingAmount;
      if (better) out.push({ rule: "invented_competition", detail: "States another offer as better than the real one." });
    }
  }
  return out;
}

export function checkReply(reply: string, ctx: CheckContext): ReplyViolation[] {
  // Writers use curly apostrophes as often as straight ones: "can’t" declines and "we’re agreed" claims alike.
  const text = straightApostrophes(reply);
  const violations: ReplyViolation[] = [];
  if (INTERNAL_TERM.test(text) || FIELD_NAME.test(text)) violations.push({ rule: "internal_term", detail: "Uses internal vocabulary or a field name the other party should never see." });
  const { view, plan } = ctx;
  const n = view.negotiable;
  const sentences = splitSentences(text);
  const offered = plannedAmounts(plan);
  const publicAmounts = view.defaultPackage.flatMap((t) => ("amount" in t.value ? [t.value.amount as number] : []));
  const citedAmounts = (plan.publicTermAnswers ?? []).flatMap((t) => ("amount" in t.value ? [t.value.amount] : []));
  if (plan.competingAmount !== undefined) citedAmounts.push(plan.competingAmount);
  const stated = ctx.statedAmounts ?? [];
  const allowed = new Set([...offered, ...publicAmounts, ...citedAmounts, ...ctx.counterpartyAmounts, ...stated, plan.referenceAmount]);
  violations.push(...competitionViolations(text, sentences, view, plan));

  for (const sentence of sentences) {
    for (const amount of findAmounts(sentence)) {
      if (amount === plan.statedBudget && quotes(sentence)) continue;
      // Repeating the counterparty's own number reveals nothing; any other private value does.
      if (view.privateAmounts.includes(amount) && !offered.includes(amount) && !ctx.counterpartyAmounts.includes(amount) && !citedAmounts.includes(amount) && !stated.includes(amount) && amount !== plan.referenceAmount) {
        violations.push({ rule: "private_amount", detail: "Mentions a private value that is not being offered." });
      } else if (!allowed.has(amount)) {
        violations.push({ rule: "unplanned_amount", detail: "Mentions an amount that is not part of the planned move." });
      }
      const crosses = n ? (n.direction === "up" ? amount < n.limit : amount > n.limit) : false;
      // Quoting the counterparty's own figure back (in a question, with "your", or acknowledged as theirs) is not offering it.
      const theirs = ctx.counterpartyAmounts.includes(amount) || plan.statedBudget === amount || plan.enquiredAmount === amount;
      const clause = sentence.split(/;\s*|,\s+|\s+but\s+|\s+(?:लेकिन|मगर|ஆனால்|ஆனா|lekin|par|magar)\s+/iu).find((part) => findAmounts(part).includes(amount)) ?? sentence;
      // Putting their figure forward as ours ("I can do X if you collect it") is never quoting them.
      const quotingThem = theirs && !offers(clause) && (quotes(sentence) || acknowledges(clause));
      if (crosses && !offered.includes(amount) && !citedAmounts.includes(amount) && !declines(sentence) && !quotingThem) {
        violations.push({ rule: "crosses_limit", detail: "States an amount beyond the limit without declining it." });
      }
    }
  }

  const mentioned = new Set(sentences.flatMap(findAmounts));
  for (const amount of offered) {
    if (!mentioned.has(amount)) violations.push({ rule: "missing_offer", detail: "Does not state the amount being offered." });
  }

  // A concession must never travel without the condition it depends on.
  if (plan.offer && plan.move !== "request_approval" && plan.move !== "await_approval") {
    const normalized = normalizeForQuoteMatch(text);
    for (const t of plan.offer.terms) {
      if (view.defaultPackage.some((d) => d.termId === t.termId) || t.termId === n?.termId) continue;
      if ((t.value.type === "text" || t.value.type === "date_text") && !normalized.includes(normalizeForQuoteMatch(t.value.value))) {
        violations.push({ rule: "missing_condition", detail: "Leaves out a term the offer depends on." });
      }
    }
  }

  // Whether to restate the current price or their budget is a matter of conversation, left to the guide.

  if (plan.move !== "confirm_agreement" && !(plan.move === "closed" && plan.notice === null) && (AGREEMENT_CLAIM.test(text) || WORKS_CLAIM.test(text) || AGREEMENT_CLAIM_INDIC.test(text) || WORKS_CLAIM_INDIC.test(text))) {
    violations.push({ rule: "false_commitment", detail: "Claims an agreement that is not recorded." });
  }
  if (!plan.approvalGranted && (APPROVAL_CLAIM.test(text) || APPROVAL_CLAIM_INDIC.test(text))) violations.push({ rule: "false_commitment", detail: "Claims an approval that is not recorded." });

  const normalizedReply = normalizeForQuoteMatch(text);
  for (const privateText of view.privateTexts) {
    for (const fragment of fragments(privateText)) {
      if (normalizedReply.includes(fragment)) {
        violations.push({ rule: "private_text", detail: "Repeats a passage from private instructions." });
        break;
      }
    }
  }
  return dedupe(violations);
}

/** Curly and other look-alike apostrophes as "'", so every pattern reads "can’t" as "can't". */
export function straightApostrophes(text: string): string {
  return text.replace(/[‘’‚‛′ʼ]/g, "'");
}

function plannedAmounts(plan: Plan): number[] {
  if (!plan.offer || (plan.move !== "counter" && plan.move !== "hold" && plan.move !== "state_final_terms" && plan.move !== "confirm_agreement")) {
    return [];
  }
  return plan.offer.terms.flatMap((t) => (t.value.type === "money" ? [t.value.amount] : []));
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|(?<=[।॥])\s*|\n+/u).map((s) => s.trim()).filter(Boolean);
}

/** Eight-word passages from private text, normalized. Long enough to avoid common phrases. */
function fragments(text: string): string[] {
  const words = normalizeForQuoteMatch(text).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + 8 <= words.length; i += 1) out.push(words.slice(i, i + 8).join(" "));
  return out;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1_000, k: 1_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, million: 1_000_000, crore: 10_000_000 };

/**
 * Finds amounts written as digits ("19,000", "19000", "19k", "$19,500", "1.5 lakh") or
 * as words ("nineteen thousand five hundred"). Small bare numbers are ignored, so
 * "two concepts" or "1 year" are not read as money.
 */
export function findAmounts(sentence: string): number[] {
  const found: number[] = [];
  const s = sentence.toLowerCase();

  const digitPattern = /(?<![\w.])(\d{1,3}(?:[,\s]\d{2,3})+|\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|lac|million|crore)?(?![\w])/g;
  for (const match of s.matchAll(digitPattern)) {
    const raw = match[1]!.replace(/[,\s]/g, "");
    let value = Number(raw);
    const scale = match[2];
    if (scale) value *= SCALES[scale] ?? 1;
    if (!Number.isFinite(value)) continue;
    // A currency symbol or code just before the number marks it as money even when small.
    const hasCurrencyNearby = /(\p{Sc}|\b[A-Z]{3}|\bRs\.?)\s*$/u.test(sentence.slice(0, match.index ?? 0).slice(-5));
    if (value >= 1000 || scale || hasCurrencyNearby) found.push(value);
  }

  const words = s.replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  let current = 0;
  let total = 0;
  let inNumber = false;
  const flush = () => {
    const value = total + current;
    if (inNumber && value >= 1000) found.push(value);
    current = 0;
    total = 0;
    inNumber = false;
  };
  for (const w of words) {
    if (w in UNITS) {
      current += UNITS[w]!;
      inNumber = true;
    } else if (w in SCALES && inNumber) {
      const scale = SCALES[w]!;
      if (scale === 100) current *= 100;
      else {
        total += current * scale;
        current = 0;
      }
    } else if (w === "and" && inNumber) {
      continue;
    } else {
      flush();
    }
  }
  flush();
  return found;
}

function dedupe(v: ReplyViolation[]): ReplyViolation[] {
  const seen = new Set<string>();
  return v.filter((x) => {
    const key = `${x.rule}|${x.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
