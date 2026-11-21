/**
 * Epic 5, Story 3: questions that would resolve an unknown or conflict affecting a possible
 * agreement. Generated from session context in code, one clear thing per question, with no
 * assumed answer and no concession. Strategy (Epic 8) decides whether and when to ask.
 *
 * A question already answered or refused is never prepared again; a partial answer leaves it open.
 */
import type { PayloadOf } from "../record/events.ts";
import type { CounterpartyModel, NoteItem } from "./model.ts";

export interface QuestionCandidate {
  issueKey: string;
  issueKind: PayloadOf<"question_prepared">["issueKind"];
  purpose: string;
  text: string;
  relatedEventIds: string[];
}

export function prepareQuestions(model: CounterpartyModel, termName: (termId: string) => string, format: (amount: number) => string): QuestionCandidate[] {
  const known = new Set(model.questions.map((q) => q.issueKey));
  const out: QuestionCandidate[] = [];
  const add = (q: QuestionCandidate) => {
    if (known.has(q.issueKey) || out.some((x) => x.issueKey === q.issueKey)) return;
    out.push(q);
  };

  for (const item of model.items) {
    switch (item.kind) {
      case "budget":
        // A budget that covers something besides the item: what is left for the item itself?
        if (item.condition && item.value && "amount" in item.value) {
          add({
            issueKey: `budget_scope:${item.id}`,
            issueKind: "budget_scope",
            purpose: "Separate the amount available for the item from other costs the budget includes.",
            text: `Of the ${format(item.value.amount)}, how much is available for the item itself, ${item.condition.replace(/^(including|incl\.?|with)\s+/i, "after ")}?`,
            relatedEventIds: [item.eventId],
          });
        }
        break;
      case "reason":
      case "constraint":
      case "need":
        if (item.condition && item.kind !== "reason") addConditional(add, item);
        else if (item.kind !== "need" && item.value && "amount" in item.value && !model.offers.some((o) => o.amount === (item.value as { amount: number }).amount)) {
          // An amount named as a reason or constraint (e.g. a transport cost behind a price objection):
          // ask what is left for the item. The term the model attached is not trusted for this.
          add({
            issueKey: `budget_scope:cost:${item.id}`,
            issueKind: "budget_scope",
            purpose: "Understand how a cost or limit the counterparty mentioned affects what they can pay for the item.",
            text: `With that in mind, what amount could you pay for the item itself?`,
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
    add({
      issueKey: `contradiction:${c.basis.join(",")}`,
      issueKind: "contradiction",
      purpose: "Resolve a contradiction between what the counterparty said and what they offered.",
      text: "Earlier you mentioned a different budget. Which amount should I work with?",
      relatedEventIds: c.basis,
    });
  }
  return out;
}

function addConditional(add: (q: QuestionCandidate) => void, item: NoteItem): void {
  add({
    issueKey: `conditional:${item.id}`,
    issueKind: "conditional",
    purpose: "Learn when a condition the counterparty attached will be settled.",
    text: `When will you know whether ${item.condition!.replace(/^(if|only if|provided that)\s+/i, "")}?`,
    relatedEventIds: [item.eventId],
  });
}
