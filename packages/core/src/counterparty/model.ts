/**
 * Epic 5: what the counterparty has said and what is still uncertain, within one session.
 *
 * - Needs, constraints, reasons, preferences, claims, stated authority and budgets are kept as
 *   the counterparty's statements with their quotes, never as verified facts.
 * - Offers are kept with the package they came with. Amounts for different packages are never
 *   compared as if they were the same deal.
 * - A counterparty-limit estimate exists only with a stated basis and explicit assumptions; otherwise
 *   the maximum is unknown. An offer shows willingness at that amount; it is not a maximum.
 * - Contradictions stay visible until corrected. Nothing here grants authority or agreement.
 */
import { createHash } from "node:crypto";
import type { OfferTerm, PayloadOf, RecordedEvent } from "../record/events.ts";
import type { SessionContext } from "../record/rules.ts";
import type { Value } from "../schema/records.ts";

export type NoteKind = PayloadOf<"counterparty_noted">["items"][number]["kind"];

export interface NoteItem {
  id: string;
  eventId: string;
  messageId: string;
  kind: NoteKind;
  quote: string;
  summary: string;
  termId: string | null;
  value: Value | null;
  condition: string | null;
  basis: "stated" | "inferred";
  at: string;
}

export interface PackageOffer {
  offerId: string;
  messageId: string;
  amount: number;
  packageKey: string;
  packageTerms: OfferTerm[];
  at: string;
}

export type MaximumEstimate =
  | { status: "unknown"; reason: string }
  | { status: "working_estimate"; atLeast: number | null; atMost: number; assumptions: string[]; basis: string[]; confidence: "low" }
  | { status: "contradicted"; reason: string; basis: string[] };

export interface PackageEstimate {
  packageKey: string;
  packageTerms: OfferTerm[];
  highestOffer: PackageOffer | null;
  statedMaximum: NoteItem | null;
  finalStatements: NoteItem[];
  maximum: MaximumEstimate;
}

export interface QuestionView {
  id: string;
  issueKey: string;
  issueKind: PayloadOf<"question_prepared">["issueKind"];
  purpose: string;
  text: string;
  status: "open" | "asked" | "answered" | "partial" | "refused";
  answers: Array<{ quote: string | null; resolution: "answered" | "partial" | "refused"; messageId: string }>;
}

export interface CounterpartyModel {
  items: NoteItem[];
  offers: PackageOffer[];
  estimates: PackageEstimate[];
  contradictions: Array<{ detail: string; basis: string[] }>;
  questions: QuestionView[];
  failedMessages: string[];
}

export function projectCounterparty(ctx: SessionContext, negotiableTermId: string | null): CounterpartyModel {
  const items: NoteItem[] = [];
  const offers: PackageOffer[] = [];
  const questions = new Map<string, QuestionView>();
  const failedMessages: string[] = [];
  const checkedPackage = new Map<string, OfferTerm[]>();

  for (const e of ctx.events as RecordedEvent[]) {
    if (e.type === "proposal_checked") {
      const p = e.payload as PayloadOf<"proposal_checked">;
      if (ctx.byId.get(p.offerId)?.type === "offer_extracted" && !checkedPackage.has(p.offerId)) checkedPackage.set(p.offerId, p.checkedTerms);
    }
  }

  for (const e of ctx.events as RecordedEvent[]) {
    switch (e.type) {
      case "counterparty_noted": {
        const p = e.payload as PayloadOf<"counterparty_noted">;
        if (p.failed) failedMessages.push(p.sourceMessageId);
        p.items.forEach((item, i) => items.push({ ...item, id: `${e.id}#${i}`, eventId: e.id, messageId: p.sourceMessageId, at: e.recordedAt }));
        break;
      }
      case "offer_extracted": {
        const p = ctx.effective.get(e.id) as PayloadOf<"offer_extracted">;
        const amountTerm = p.terms.find((t) => t.termId === negotiableTermId);
        if (!amountTerm || !("amount" in amountTerm.value)) break;
        // The package is what the counterparty's amount came with: their terms over the agent's at that time.
        const pkg = (checkedPackage.get(e.id) ?? p.terms).filter((t) => t.termId !== negotiableTermId);
        offers.push({ offerId: e.id, messageId: p.sourceMessageId, amount: amountTerm.value.amount as number, packageKey: packageKey(pkg), packageTerms: pkg, at: e.recordedAt });
        break;
      }
      case "question_prepared": {
        const p = e.payload as PayloadOf<"question_prepared">;
        questions.set(e.id, { id: e.id, issueKey: p.issueKey, issueKind: p.issueKind, purpose: p.purpose, text: p.text, status: "open", answers: [] });
        break;
      }
      case "question_asked": {
        const q = questions.get((e.payload as PayloadOf<"question_asked">).questionId);
        if (q && q.status === "open") q.status = "asked";
        break;
      }
      case "question_answered": {
        const p = e.payload as PayloadOf<"question_answered">;
        const q = questions.get(p.questionId);
        if (q) {
          q.answers.push({ quote: p.quote, resolution: p.resolution, messageId: p.sourceMessageId });
          q.status = p.resolution;
        }
        break;
      }
    }
  }

  // Package of each budget statement: an offer in the same message, else the latest before it,
  // else the first after it (a budget stated before any offer applies to what they then offer).
  const packageAt = (messageId: string, at: string): string | null => {
    const same = offers.find((o) => o.messageId === messageId);
    if (same) return same.packageKey;
    const before = offers.filter((o) => o.at <= at).at(-1);
    if (before) return before.packageKey;
    const after = offers.find((o) => o.at > at);
    return after?.packageKey ?? "";
  };

  const keys = new Set(offers.map((o) => o.packageKey));
  const budgets = items.filter((i) => i.kind === "budget" && i.value && "amount" in i.value);
  for (const b of budgets) keys.add(packageAt(b.messageId, b.at) ?? "");
  const finals = items.filter((i) => i.kind === "final_position");

  const contradictions: CounterpartyModel["contradictions"] = [];
  const estimates: PackageEstimate[] = [...keys].map((key) => {
    const pkgOffers = offers.filter((o) => o.packageKey === key);
    const highestOffer = pkgOffers.reduce<PackageOffer | null>((best, o) => (!best || o.amount > best.amount ? o : best), null);
    const pkgBudgets = budgets.filter((b) => (packageAt(b.messageId, b.at) ?? "") === key);
    const statedMaximum = pkgBudgets.at(-1) ?? null;
    const packageTerms = pkgOffers[0]?.packageTerms ?? [];
    const finalStatements = finals.filter((f) => pkgOffers.some((o) => o.messageId === f.messageId));

    let maximum: MaximumEstimate;
    if (!statedMaximum) {
      maximum = { status: "unknown", reason: highestOffer ? "An offer shows willingness at that amount; it does not show a maximum." : "No offer or stated budget for this package." };
    } else {
      const ceiling = (statedMaximum.value as { amount: number }).amount;
      const above = pkgOffers.find((o) => o.amount > ceiling && o.at >= statedMaximum.at);
      if (above) {
        const detail = `Stated budget of ${ceiling} was followed by an offer of ${above.amount} for the same package.`;
        maximum = { status: "contradicted", reason: `${detail} The actual maximum is uncertain.`, basis: [statedMaximum.eventId, above.offerId] };
        contradictions.push({ detail, basis: [statedMaximum.eventId, above.offerId] });
      } else {
        maximum = {
          status: "working_estimate",
          atLeast: highestOffer?.amount ?? null,
          atMost: ceiling,
          assumptions: ["The counterparty's stated budget is accurate.", ...(statedMaximum.condition ? [`The budget applies ${statedMaximum.condition}.`] : [])],
          basis: [statedMaximum.eventId, ...(highestOffer ? [highestOffer.offerId] : [])],
          confidence: "low",
        };
      }
    }
    return { packageKey: key, packageTerms, highestOffer, statedMaximum, finalStatements, maximum };
  });

  return { items, offers, estimates, contradictions, questions: [...questions.values()], failedMessages };
}

export function packageKey(terms: OfferTerm[]): string {
  const canonical = [...terms].sort((a, b) => a.termId.localeCompare(b.termId)).map((t) => [t.termId, t.value]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}
