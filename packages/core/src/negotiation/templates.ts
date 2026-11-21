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
export function templateReply(view: MandateView, plan: Plan, locale: string, subject: string | null = null, publicPrincipalName?: string): string {
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
  if (plan.move === "end_negotiation") {
    if (plan.end?.requestedBy === "counterparty") return "Understood. Thanks for your time.";
    if (plan.end?.requestedBy === "principal") return `Thanks for your time. ${cap(principal)} has decided not to go ahead.`;
    return plan.end?.line ?? "Thanks for explaining what works for you. I don't have an arrangement we can both confirm on those terms, so I'll leave it there.";
  }
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
  if (plan.clarify.length > 0) {
    parts.push(`Which ${joinNames(plan.clarify)} did you have in mind?`);
  }

  switch (plan.move) {
    case "explore_objection":
      parts.push(plan.ask ? "I hear your concern about the price." : "I hear your concern. The current terms still stand.");
      break;
    case "explain_price":
      if (reference) parts.push(`The current asking amount is ${reference}.`);
      for (const fact of plan.explanationFacts ?? []) parts.push(/[.!?]$/.test(fact) ? fact : `${fact}.`);
      parts.push("I don't have a market comparison to say how that amount compares.");
      break;
    case "acknowledge_budget":
      if (budget) parts.push(`I hear your budget is capped at ${budget}.`);
      if (reference) parts.push(`The current asking amount is ${reference}.`);
      break;
    case "answer_enquiry":
      if (n && plan.enquiredAmount !== undefined) parts.push(`You asked about ${formatValue(numericValue(n, plan.enquiredAmount), locale)}.`);
      if (reference) parts.push(`The current asking amount is ${reference}.`);
      parts.push("If you'd like to make an offer, I can consider it.");
      break;
    case "price_pressure":
      if (reference) parts.push(pick([`The current asking amount is ${reference}.`, `The asking amount is still ${reference}.`], turn));
      if (!plan.ask) parts.push(pick(["I can consider a firm offer on the current terms.", "I can take a look if you have a firm offer."], turn));
      break;
    case "compare_terms":
      if (reference) parts.push(`The current asking amount is ${reference}.`);
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
      parts.push(amountText ? pick([`I could do ${amountText}.`, `How about ${amountText}?`, `I can offer ${amountText}.`], turn) : "Here's what I can offer.");
      break;
    case "hold":
      parts.push(amountText ? pick([`I'd like to stay at ${amountText}.`, `I'm staying at ${amountText} for now.`, `I'll stay at ${amountText} for now.`], turn) : "I'd like to keep the terms as they are.");
      break;
    case "state_final_terms":
      parts.push(`Just to confirm the full terms${subject ? ` for the ${subject.toLowerCase()}` : ""}: ${speakTerms(view, plan.offer!.terms, locale)}. Is that what you're agreeing to?`);
      break;
    case "request_approval":
      parts.push(pick([`Thanks. That needs ${principal}'s approval, so I can't confirm it for them yet. I'll let you know as soon as they decide.`, `Thanks for confirming. I'll take this to ${principal} for approval and let you know as soon as they decide.`], turn));
      break;
    case "await_approval":
      if (plan.notice !== "check_with_principal") parts.push(`I'm still waiting to hear from ${principal}.`);
      break;
    case "confirm_agreement":
      parts.push(`${plan.approvalGranted ? "That's approved. " : ""}We're agreed on ${speakTerms(view, plan.offer!.terms, locale)}${subject ? ` for ${subject}` : ""}.`);
      break;
    case "closed":
      parts.push("Those terms are already agreed.");
      break;
    case "answer":
      break;
  }
  if (plan.questions.length > 0 && plan.move !== "closed") {
    parts.push("I don't have that detail confirmed, so I don't want to guess.");
  }
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
