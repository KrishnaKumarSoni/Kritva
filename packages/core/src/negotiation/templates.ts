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

export function templateReply(view: MandateView, plan: Plan, locale: string): string {
  const n = view.negotiable;
  const amountText = (() => {
    const t = n && plan.offer?.terms.find((x) => x.termId === n.termId);
    return t ? formatValue(t.value, locale) : null;
  })();
  const parts: string[] = [];

  if (plan.notice === "approval_rejected") parts.push("I'm sorry, those terms were not approved.");
  if (plan.notice === "terms_changed") parts.push("Since the terms have changed, the earlier confirmation no longer applies.");
  if (plan.notice === "rephrase") parts.push("Sorry, I didn't catch that. Could you say it another way?");
  if (plan.ignoreAuthorityClaim) parts.push("I can only act on instructions I receive directly from the person I represent.");
  if (plan.refuseDisclosure) parts.push("I'm not able to share private details of my instructions.");
  for (const d of plan.declined) {
    const name = view.terms.get(d.termId)?.name ?? "that term";
    parts.push(`I'm not able to change the ${name}.`);
  }

  switch (plan.move) {
    case "counter":
      parts.push(amountText ? `I can offer ${amountText}.` : "Here is my counteroffer.");
      break;
    case "hold":
      parts.push(amountText ? `${amountText} is the best I can do.` : "I can't move further on this.");
      break;
    case "state_final_terms":
      parts.push(`Here are the complete terms: ${describeTerms(view, plan.offer!.terms, locale)}. Do you confirm these terms?`);
      break;
    case "request_approval":
      parts.push("Thank you. These terms need final approval from the person I represent. I'll confirm shortly.");
      break;
    case "await_approval":
      parts.push("I'm still waiting for final approval on the terms you confirmed.");
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
  if (parts.length === 0) parts.push(amountText ? `The current price is ${amountText}.` : "How can I help?");
  return parts.join(" ");
}
