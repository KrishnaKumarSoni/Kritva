/**
 * Deterministic wording for each planned move. Used when the composed reply is blocked,
 * and as the safe baseline. Built only from the plan and public mandate content.
 */
import { formatValue, numericValue, orderTerms, type MandateView } from "./mandate-view.ts";
import type { Plan } from "./policy.ts";
import type { OfferTerm } from "../record/events.ts";

export function describeTerms(view: MandateView, terms: OfferTerm[], locale: string): string {
  return orderTerms(view, terms)
    .map((t) => {
      const term = view.terms.get(t.termId);
      return `${term?.name ?? t.termId}: ${formatValue(t.value, locale)}`;
    })
    .join("; ");
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The principal, as the other side should hear it (their role, with "the"). */
export function principalLabel(view: MandateView): string {
  return `the ${view.principalRole.trim().toLowerCase() || "person I represent"}`;
}

/** Used only when a composed introduction is unavailable or incomplete. */
export function introduction(view: MandateView, publicPrincipalName?: string): string {
  return `Hi, I'm Kritva, ${publicPrincipalName || principalLabel(view)}'s assistant.`;
}

/**
 * Complete terms read naturally: amounts as they are, "no <term>" for a false yes/no term, and
 * "<term> <value>" for the rest. Built only from the checked terms.
 */
export function speakTerms(view: MandateView, terms: OfferTerm[], locale: string): string {
  const parts = orderTerms(view, terms).map((t) => {
    const name = view.terms.get(t.termId)?.name ?? t.termId;
    if (t.value.type === "money") return formatValue(t.value, locale);
    if (t.value.type === "boolean") return t.value.value ? name : `no ${name}`;
    return `${name} ${formatValue(t.value, locale)}`;
  });
  return parts.length <= 1 ? (parts[0] ?? "") : parts.length === 2 ? `${parts[0]} and ${parts[1]}` : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function pick(variants: string[], turn: number): string {
  return variants[Math.abs(turn) % variants.length]!;
}

/**
 * Checked fallback wording, written to the humane conversation guide: warm, short, specific, one
 * question at a time. Used when composition fails or is blocked.
 */
export function templateReply(view: MandateView, plan: Plan, locale: string, subject: string | null = null, publicPrincipalName?: string, options: { offerInvitedRecently?: boolean; priceJustSaid?: boolean } = {}): string {
  const n = view.negotiable;
  const turn = plan.turnIndex ?? 0;
  const principal = principalLabel(view);
  const amountText = (() => {
    const t = n && plan.offer?.terms.find((x) => x.termId === n.termId);
    if (!t) return null;
    // Name any extra term the amount is tied to, so a conditional concession never travels without its condition.
    const extras = (plan.offer?.terms ?? []).filter((x) => x.termId !== n!.termId && !view.defaultPackage.some((d) => d.termId === x.termId));
    const tied = extras.map((x) => `${view.terms.get(x.termId)?.name ?? x.termId} ${formatValue(x.value, locale)}`).join(" and ");
    return tied ? `${formatValue(t.value, locale)} with ${tied}` : formatValue(t.value, locale);
  })();
  const reference = n && plan.referenceAmount !== undefined ? formatValue(numericValue(n, plan.referenceAmount), locale) : null;
  const budget = n && plan.statedBudget !== undefined ? formatValue(numericValue(n, plan.statedBudget), locale) : null;
  const parts: string[] = [];
  if (plan.introduce) parts.push(introduction(view, publicPrincipalName));
  if (plan.opening) return clean([...parts, "What would you like to discuss?"].join(" "));
  if (plan.acknowledge) parts.push(plan.acknowledge);
  if (plan.listingAvailable === true) parts.push("Yes, it's still available.");
  else if (plan.listingAvailable === false) parts.push("It's no longer available.");
  else if (plan.openForDiscussion) parts.push("Yes, the current terms are still open for discussion.");

  if (plan.notice === "approval_rejected") parts.push(`${cap(principal)} didn't approve those terms.`);
  if (plan.notice === "terms_changed") parts.push("Since the terms have changed, I'll need a fresh confirmation on the new ones.");
  if (plan.notice === "rephrase") parts.push("Sorry, I didn't quite catch that. Could you say it another way?");
  if (plan.notice === "paused") return `${cap(principal)} has paused this conversation for now. You'll hear back when it picks up again.`;
  if (plan.notice === "ended") return "This conversation has ended without an agreement. Thanks for your time.";
  if (plan.followUp?.step === "keep_contact") return "Thank you, I've made a note of that. Take care!";
  if (plan.move === "end_negotiation") {
    if (plan.followUp?.step === "declined") return clean([...parts, `Sorry, ${principal} can't do that one.`].join(" "));
    if (plan.end?.requestedBy === "counterparty") return "Understood. Thanks for your time.";
    if (plan.end?.requestedBy === "principal") return `Thanks for your time. ${cap(principal)} has decided not to go ahead.`;
    return plan.end?.line ?? "Thanks for explaining what works for you. I don't have an arrangement we can both confirm on those terms, so I'll leave it there.";
  }
  if (plan.recap?.length) parts.push(`Just so I have it right, your offer is ${speakTerms(view, plan.recap, locale)}.`);
  if (plan.notice === "check_with_principal") parts.push(pick([`That needs ${principal}'s approval, so I can't confirm it myself. I'll come back to you once they've decided.`, `I'll need ${principal}'s go-ahead on that first. I'll come back to you once they've decided.`], turn));
  if (plan.ignoreAuthorityClaim) parts.push(pick([`I can only go by what ${principal} tells me directly.`, `Any approval has to come from ${principal} directly, so I can't act on that.`], turn));
  if (plan.refuseDisclosure) parts.push(`I can't share ${principal}'s private limits.`);
  for (const d of plan.declined) {
    const name = view.terms.get(d.termId)?.name ?? "that";
    const stem = name.replace(/\s+included$/i, "");
    parts.push(stem !== name ? `${cap(stem)} isn't included, so that's not something I can offer.` : `The ${name} isn't something I can change.`);
  }

  if (plan.unresolved.length > 0) {
    parts.push(`I don't have ${joinNames(plan.unresolved)} confirmed, so I can't promise it or put a price on it. I can ask ${principal}.`);
  }
  // A clarifying question goes last, after the statements it follows.
  const clarifying = plan.clarify.length > 0 ? `Which ${joinNames(plan.clarify)} did you have in mind?` : null;

  // When the principal pays, the amount on the table is what we offer, never an asking price.
  const pays = view.principalSide === "pays";
  const current = (amount: string) => (pays ? `Our current offer is ${amount}.` : `The current asking amount is ${amount}.`);
  const still = (amount: string) => (pays ? `Our offer is still ${amount}.` : `The asking amount is still ${amount}.`);
  switch (plan.move) {
    case "explore_objection":
      parts.push(plan.ask ? "I hear your concern about the price." : "I hear your concern. The current terms still stand.");
      break;
    case "explain_price":
      if (reference) parts.push(pick([current(reference), pays ? `${reference} is what we can offer right now.` : `${reference} is the current asking amount.`], turn));
      for (const fact of plan.explanationFacts ?? []) parts.push(/[.!?]$/.test(fact) ? fact : `${fact}.`);
      parts.push("I don't have a market comparison to say how that amount compares.");
      break;
    case "acknowledge_budget":
      if (budget) parts.push(`I hear your budget is capped at ${budget}.`);
      if (reference) parts.push(current(reference));
      break;
    case "answer_enquiry": {
      const enquired = n && plan.enquiredAmount !== undefined ? formatValue(numericValue(n, plan.enquiredAmount), locale) : null;
      if (enquired && reference) parts.push(pick([`You asked about ${enquired}. ${current(reference)}`, `You asked about ${enquired}. ${still(reference)}`], turn));
      else if (enquired) parts.push(`You asked about ${enquired}.`);
      else if (reference) parts.push(current(reference));
      if (!options.offerInvitedRecently) parts.push("If you'd like to make an offer, I can consider it.");
      break;
    }
    case "price_pressure":
      // The last reply already said the price: keep the position without the number.
      if (reference && options.priceJustSaid) parts.push(pick(["I'd like to stay where I am for now.", "That's where I am on it for now."], turn));
      else if (reference && options.offerInvitedRecently && !plan.ask) parts.push(pick([`For now the price stays at ${reference}.`, `${reference} is still where it stands for now.`], turn));
      else if (reference) parts.push(pick([current(reference), still(reference)], turn));
      if (!plan.ask && !options.offerInvitedRecently) parts.push(pick(["I can consider a firm offer on the current terms.", "I can take a look if you have a firm offer."], turn));
      break;
    case "compare_terms":
      if (reference) parts.push(pick([current(reference), pays ? `${reference} is what we can offer right now.` : `${reference} is the current asking amount.`], turn));
      for (const fact of plan.explanationFacts ?? []) parts.push(/[.!?]$/.test(fact) ? fact : `${fact}.`);
      break;
    case "answer_public_terms":
      for (const term of plan.publicTermAnswers ?? []) {
        const name = view.terms.get(term.termId)!.name;
        const value = formatValue(term.value, locale);
        if (term.basis === "opening") parts.push(`The listed ${name.toLowerCase()} was ${value}.`);
        else if (term.value.type === "boolean") parts.push(`${cap(name)}? ${value}.`);
        else parts.push(`The ${name.toLowerCase()} is ${value}.`);
      }
      break;
    case "counter":
      // A step toward their stated budget acknowledges it first, as theirs.
      if (budget) parts.push(`You said your budget is ${budget}.`);
      parts.push(amountText ? pick([`I could do ${amountText}.`, `How about ${amountText}?`, `I can offer ${amountText}.`], turn) : "Here's what I can offer.");
      break;
    case "hold":
      parts.push(amountText ? pick([`I'd like to stay at ${amountText}.`, `I'm staying at ${amountText} for now.`, `I'll stay at ${amountText} for now.`], turn) : "I'd like to keep the terms as they are.");
      break;
    case "state_final_terms":
      if (plan.followUp?.step === "approved") {
        parts.push(`${plan.followUp.expired ? "" : "Good news, "}${plan.followUp.expired ? cap(principal) : principal} has confirmed ${speakTerms(view, plan.offer!.terms, locale)}. Is that still good for you?`);
        break;
      }
      if (plan.followUp?.step === "countered") {
        parts.push(`${cap(principal)} can do ${speakTerms(view, plan.offer!.terms, locale)}. Would that work for you?`);
        break;
      }
      parts.push(`Just to confirm the full terms${subject ? ` for the ${subject.toLowerCase()}` : ""}: ${speakTerms(view, plan.offer!.terms, locale)}. Is that what you're agreeing to?`);
      break;
    case "request_approval":
      if (plan.followUp?.step === "close") {
        parts.push(closing(principal, plan.followUp.contact ?? null));
        break;
      }
      parts.push(pick([`Thanks. That needs ${principal}'s approval, so I can't confirm it for them yet. I'll let you know as soon as they decide.`, `Thanks for confirming. I'll take this to ${principal} for approval and let you know as soon as they decide.`], turn));
      break;
    case "await_approval":
      if (plan.followUp?.step === "close") parts.push(closing(principal, plan.followUp.contact ?? null));
      // Asking about the follow-up: a plain thanks for what they said, or (an exception just asked about) nothing more.
      else if (plan.followUp && plan.notice !== "check_with_principal") parts.push("Thanks for letting me know.");
      else if (plan.notice !== "check_with_principal") parts.push(`I'm still waiting to hear from ${principal}.`);
      break;
    case "confirm_agreement":
      parts.push(`${plan.approvalGranted ? "That's approved. " : ""}We're agreed on ${speakTerms(view, plan.offer!.terms, locale)}${subject ? ` for the ${subject.charAt(0).toLowerCase()}${subject.slice(1)}` : ""}.`);
      break;
    case "closed":
      parts.push("Those terms are already agreed.");
      break;
    case "answer":
      break;
  }
  if (plan.questions.length > 0 && plan.move !== "closed") {
    // Say what is confirmed, then be plain that nothing beyond it is: never a bare "I don't know".
    const facts = view.publicFacts.slice(0, 3);
    if (facts.length > 0) {
      for (const fact of facts) parts.push(/[.!?]$/.test(fact) ? fact : `${fact}.`);
      parts.push(`I don't have anything beyond that confirmed, so I can check with ${principal}.`);
    } else {
      parts.push(`I don't have that detail confirmed, so I can check with ${principal}.`);
    }
  }
  if (clarifying) parts.push(clarifying);
  if (plan.ask) parts.push(plan.ask.text);
  if (parts.length === 0 || (parts.length === 1 && plan.introduce)) parts.push("What would you like to know?");
  return clean(parts.join(" "));
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** No em or en dashes in anything Kritva says. */
export function clean(text: string): string {
  return text
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/\s+([.,?!])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The wrap-up close: nothing is final yet, how they will hear back, and thanks. */
function closing(principal: string, contact: "chat" | "call" | "whatsapp" | null): string {
  const how = contact === "call" || contact === "whatsapp" ? " with a call" : contact === "chat" ? " here" : "";
  return `It's not final until ${principal} confirms, and I'll get back to you${how} as soon as I hear. Thanks so much for your time!`;
}
