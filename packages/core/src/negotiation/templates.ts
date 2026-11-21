/**
 * Deterministic wording for each planned move. Used when the composed reply is blocked,
 * and as the safe baseline. Built only from the plan and public mandate content.
 */
import { formatValue, orderTerms, type MandateView } from "./mandate-view.ts";
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

export function templateReply(view: MandateView, plan: Plan, locale: string): string {
  const n = view.negotiable;
  const amountText = (() => {
    const t = n && plan.offer?.terms.find((x) => x.termId === n.termId);
    if (!t) return null;
    // Name any extra term the amount is tied to, so a conditional concession never travels without its condition.
    const extras = (plan.offer?.terms ?? []).filter((x) => x.termId !== n!.termId && !view.defaultPackage.some((d) => d.termId === x.termId));
    const tied = extras.map((x) => `${view.terms.get(x.termId)?.name ?? x.termId}: ${formatValue(x.value, locale)}`).join(", ");
    return tied ? `${formatValue(t.value, locale)} (${tied})` : formatValue(t.value, locale);
  })();
  const parts: string[] = [];

  if (plan.notice === "approval_rejected") parts.push("I'm sorry, those terms were not approved.");
  if (plan.notice === "terms_changed") parts.push("Since the terms have changed, the earlier confirmation no longer applies.");
  if (plan.notice === "rephrase") parts.push("Sorry, I didn't catch that. Could you say it another way?");
  if (plan.notice === "paused") return "This conversation is paused for now. You'll hear back when it resumes.";
  if (plan.notice === "ended") return "This negotiation has ended without an agreement. Thank you for your time.";
  if (plan.move === "end_negotiation") {
    if (plan.end?.requestedBy === "counterparty") return "Understood. Thank you for your time.";
    if (plan.end?.requestedBy === "principal") return "Thank you for your time. We won't be going ahead with this.";
    return plan.end?.line ?? "Thank you for your time. I'm not able to go further, so I'll leave it here.";
  }
  if (plan.notice === "check_with_principal") parts.push("I'll need to check this with the person I represent and come back to you.");
  if (plan.ignoreAuthorityClaim) parts.push("I can only act on instructions I receive directly from the person I represent.");
  if (plan.refuseDisclosure) parts.push("I'm not able to share private details of my instructions.");
  for (const d of plan.declined) {
    const name = view.terms.get(d.termId)?.name ?? "that term";
    parts.push(`I'm not able to change the ${name}.`);
  }

  if (plan.unresolved.length > 0) {
    parts.push(`I'll need to check with the person I represent about ${joinNames(plan.unresolved)}. I can't promise that or quote a price for it yet.`);
  }
  if (plan.clarify.length > 0) {
    parts.push(`Could you tell me the ${joinNames(plan.clarify)} you have in mind?`);
  }

  switch (plan.move) {
    case "counter":
      parts.push(amountText ? `I can offer ${amountText}.` : "Here is my counteroffer.");
      break;
    case "hold":
      parts.push(amountText ? `My offer stays at ${amountText}.` : "My offer stays as it is.");
      break;
    case "state_final_terms":
      parts.push(`Here are the complete terms: ${describeTerms(view, plan.offer!.terms, locale)}. Do you confirm these terms?`);
      break;
    case "request_approval":
      parts.push("Thank you. These terms need final approval from the person I represent. I'll confirm shortly.");
      break;
    case "await_approval":
      if (plan.notice !== "check_with_principal") parts.push("I'm still waiting to hear back from the person I represent.");
      break;
    case "confirm_agreement":
      parts.push(`Approved. The agreed terms are: ${describeTerms(view, plan.offer!.terms, locale)}.`);
      break;
    case "closed":
      parts.push("The terms are already agreed.");
      break;
    case "answer":
      break;
  }
  if (plan.questions.length > 0 && plan.move !== "closed") {
    parts.push("I don't have information about that. I can check and get back to you.");
  }
  if (plan.ask) parts.push(plan.ask.text);
  if (parts.length === 0) parts.push(amountText ? `The current price is ${amountText}.` : "How can I help?");
  return parts.join(" ");
}
