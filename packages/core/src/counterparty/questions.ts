/**
 * Epic 5, Story 3: questions that would resolve an unknown or conflict affecting a possible
 * agreement. Generated from session context in code, one clear thing per question, with no
 * assumed answer and no concession. Strategy (Epic 8) decides whether and when to ask.
 *
 * A question already answered or refused is never prepared again; a partial answer leaves it open.
 */
import { normalizeForQuoteMatch, quoteAppearsIn } from "../schema/quotes.ts";
import { findAmounts } from "../negotiation/reply-check.ts";
import type { PayloadOf } from "../record/events.ts";
import type { CounterpartyModel, NoteItem } from "./model.ts";

export interface QuestionCandidate {
  issueKey: string;
  issueKind: PayloadOf<"question_prepared">["issueKind"];
  purpose: string;
  text: string;
  relatedEventIds: string[];
}

const COST_SCOPE = /^(?:including|incl\.?|with|covers?)\s+(.+)$/i;

/** A budget breakdown needs a quoted cost distinct from the negotiated value. */
export function includedBudgetCost(quote: string, condition: string | null, termName: string): string | null {
  if (!condition || !quoteAppearsIn(quote, condition)) return null;
  const cost = condition.match(COST_SCOPE)?.[1]?.trim();
  if (!cost) return null;
  const term = issueValue(termName).replace(/^(?:the|a|an) /, "");
  const distinct = cost.split(/\s+(?:and|plus)\s+/i).filter((part) => {
    const key = issueValue(part).replace(/^(?:the|a|an) /, "");
    if (!key || key === term) return false;
    if (/^(?:(?:total |full )?(?:purchase|asking|agreed|base|quoted|item|sale|total|negotiated) )?(?:price|amount|cost|fee|value)(?: itself)?$/.test(key)) return false;
    return !/^(?:everything|all costs|all fees|all expenses|anything else|itself|everything included)$/.test(key);
  });
  return distinct.length > 0 ? distinct.join(" and ") : null;
}

function issueValue(value: string): string {
  return normalizeForQuoteMatch(value).replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function prepareQuestions(model: CounterpartyModel, termName: (termId: string) => string, format: (amount: number) => string, sourceMessageId: string, negotiableTermId: string | null): QuestionCandidate[] {
  const known = new Set(model.questions.map((q) => q.issueKey));
  const out: QuestionCandidate[] = [];
  const add = (q: QuestionCandidate) => {
    if (known.has(q.issueKey) || out.some((x) => x.issueKey === q.issueKey)) return;
    out.push(q);
  };

  const relevant = model.items.filter((item) => item.messageId === sourceMessageId);
  const hasBudget = model.items.some((item) => item.kind === "budget" && item.basis === "stated" && item.value?.type === "money");
  for (const item of relevant) {
    const termId = item.termId ?? negotiableTermId ?? "amount";
    switch (item.kind) {
      case "budget": {
        // Separate a negotiable amount from ancillary costs covered by a budget.
        const cost = includedBudgetCost(item.quote, item.condition, termName(termId));
        if (cost && item.basis === "stated" && item.value?.type === "money" && cost.split(/\s+and\s+/i).some((part) => findAmounts(part).length === 0)) {
          add({
            issueKey: `budget_scope:${termId}:${issueValue(cost.replace(/[\d.,]+/g, " "))}`,
            issueKind: "budget_scope",
            purpose: "Separate the amount available for the negotiation from ancillary costs.",
            text: `Of the ${format(item.value.amount)}, what amount is available for these terms, after ${cost}?`,
            relatedEventIds: [item.eventId],
          });
        }
        break;
      }
      case "reason":
      case "constraint":
      case "need":
        if (item.condition && item.kind !== "reason") addConditional(add, item);
        else if (!hasBudget && item.kind !== "need" && item.basis === "stated" && item.value?.type === "money" && !model.offers.some((o) => o.amount === (item.value as { amount: number }).amount)) {
          // An amount named as a reason or constraint (e.g. a transport cost behind a price objection):
          // ask how that cost changes the amount available for these terms.
          add({
            issueKey: `budget_scope:cost:${termId}`,
            issueKind: "budget_scope",
            purpose: "Understand how a cost or limit the counterparty mentioned affects the amount they can agree to.",
            text: `With that in mind, what amount would work for you?`,
            relatedEventIds: [item.eventId],
          });
        } else if (item.kind !== "reason" && item.termId && !item.value) {
          add({
            issueKey: `obstacle:${item.termId}`,
            issueKind: "obstacle",
            purpose: `Find out which part of the ${termName(item.termId)} prevents agreement.`,
            text: `Which part of the ${termName(item.termId)} doesn't work for you?`,
            relatedEventIds: [item.eventId],
          });
        }
        break;
      case "preference":
        if (item.condition) addConditional(add, item);
        break;
      case "authority":
        add({
          issueKey: "authority:confirm",
          issueKind: "authority",
          purpose: "Learn whether the counterparty can confirm terms now or needs someone else's agreement first.",
          text: "Can you confirm terms yourself now, or does someone else need to agree first?",
          relatedEventIds: [item.eventId],
        });
        break;
    }
  }

  for (const c of model.contradictions) {
    if (!c.basis.some((id) => relevant.some((item) => item.eventId === id) || model.offers.some((offer) => offer.messageId === sourceMessageId && offer.offerId === id))) continue;
    add({
      issueKey: `contradiction:${c.packageKey}`,
      issueKind: "contradiction",
      purpose: "Resolve a contradiction between what the counterparty said and what they offered.",
      text: "Earlier you mentioned a different budget. Which amount should I work with?",
      relatedEventIds: c.basis,
    });
  }
  return out;
}

function addConditional(add: (q: QuestionCandidate) => void, item: NoteItem): void {
  // Ask when an event-dependent condition will be settled. A qualifier does not describe an event.
  if (!/^(if|only if|provided( that)?|as long as|once|when|unless)\b/i.test(item.condition!.trim())) return;
  add({
    issueKey: `conditional:${item.termId ?? "package"}:${issueValue(item.condition!)}`,
    issueKind: "conditional",
    purpose: "Learn when a condition the counterparty attached will be settled.",
    text: `When will you know whether ${item.condition!.replace(/^(if|only if|provided that)\s+/i, "")}?`,
    relatedEventIds: [item.eventId],
  });
}
