/** Helpers for record tests: a temp database, the demo mandate, and event builders. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfirmedMandate, type ValidConfirmedMandate } from "../../src/mandate/confirm.ts";
import { hashTerms, type Actor, type Channel, type NewEvent, type OfferTerm } from "../../src/record/events.ts";
import { SqliteRecordBackend } from "../../src/record/sqlite.ts";
import { NegotiationRecord } from "../../src/record/store.ts";
import { CASES_DIR } from "./cases.ts";

export function loadDemoMandate(): ValidConfirmedMandate {
  const raw = JSON.parse(readFileSync(join(CASES_DIR, "bed-sale/mandates/demo.confirmed.json"), "utf8"));
  const checked = validateConfirmedMandate(raw);
  if (!checked.ok) throw new Error(`demo mandate invalid: ${JSON.stringify(checked.errors)}`);
  return checked.mandate;
}

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "kritva-record-")), "record.sqlite");
}

export function openRecord(path = tempDbPath()): { record: NegotiationRecord; path: string } {
  return { record: new NegotiationRecord(new SqliteRecordBackend(path)), path };
}

/** Term IDs are case data; look them up by type and name rather than hard-coding them in core. */
export function demoTerms(mandate: ValidConfirmedMandate) {
  const price = mandate.terms.find((t) => t.valueType === "money")!;
  const pickup = mandate.terms.find((t) => t.valueType === "text" && /pickup/i.test(t.name))!;
  const delivery = mandate.terms.find((t) => t.valueType === "boolean")!;
  return { price: price.id, pickup: pickup.id, delivery: delivery.id };
}

export const BUYER: Actor = { kind: "counterparty", partyId: "buyer" };
export const SELLER: Actor = { kind: "principal", partyId: "seller" };
export const AGENT: Actor = { kind: "agent", partyId: "seller" };
export const SYSTEM: Actor = { kind: "system", partyId: null };

export const inbound = (id: string, text: string, channel: Channel = "text", utteranceId: string | null = null): NewEvent<"message"> => ({
  id,
  type: "message",
  channel,
  payload: { direction: "inbound", speakerPartyId: "buyer", text, utteranceId, offerIds: [] },
});

export const outbound = (id: string, text: string, offerIds: string[] = [], channel: Channel = "text"): NewEvent<"message"> => ({
  id,
  type: "message",
  channel,
  payload: { direction: "outbound", speakerPartyId: "seller", text, utteranceId: null, offerIds },
});

export const money = (amount: number) => ({ type: "money" as const, amount, currency: "INR" });

export const extracted = (id: string, sourceMessageId: string, terms: OfferTerm[]): NewEvent<"offer_extracted"> => ({
  id,
  type: "offer_extracted",
  channel: null,
  payload: { sourceMessageId, byPartyId: "buyer", terms, termsHash: hashTerms(terms) },
});

export const proposed = (id: string, terms: OfferTerm[], basis: "counter" | "final_terms" = "final_terms"): NewEvent<"offer_proposed"> => ({
  id,
  type: "offer_proposed",
  channel: null,
  payload: { byPartyId: "seller", basis, terms, termsHash: hashTerms(terms) },
});

export const delivered = (id: string, messageId: string, channel: Channel = "text"): NewEvent<"delivery_reported"> => ({
  id,
  type: "delivery_reported",
  channel,
  payload: { messageId, status: "delivered", deliveredText: null },
});

export const approvalRequest = (id: string, offerId: string, terms: OfferTerm[], acceptanceId: string | null = null, revision = 1): NewEvent<"approval_requested"> => ({
  id,
  type: "approval_requested",
  channel: null,
  payload: { offerId, termsHash: hashTerms(terms), mandateRevision: revision, acceptanceId },
});

export const approvalResponse = (id: string, requestId: string, offerId: string, terms: OfferTerm[], decision: "approved" | "rejected" = "approved", revision = 1): NewEvent<"approval_responded"> => ({
  id,
  type: "approval_responded",
  channel: null,
  payload: { requestId, offerId, termsHash: hashTerms(terms), mandateRevision: revision, decision, note: null },
});

export const acceptance = (id: string, offerId: string, messageId: string, terms: OfferTerm[]): NewEvent<"acceptance_recorded"> => ({
  id,
  type: "acceptance_recorded",
  channel: null,
  payload: { offerId, termsHash: hashTerms(terms), messageId, byPartyId: "buyer" },
});

export const agreement = (id: string, offerId: string, terms: OfferTerm[], acceptanceId: string, approvalId: string | null, revision = 1): NewEvent<"agreement_recorded"> => ({
  id,
  type: "agreement_recorded",
  channel: null,
  payload: { offerId, terms, termsHash: hashTerms(terms), mandateRevision: revision, acceptanceId, approvalId },
});

export async function mustAppend(record: NegotiationRecord, sessionId: string, event: NewEvent, actor: Actor) {
  const result = await record.append(sessionId, event, actor);
  if (!result.ok) throw new Error(`append ${event.id} failed: ${JSON.stringify(result.error)}`);
  return result.event;
}

/** Drives a full approved agreement through the record and returns the IDs used. */
export async function recordAgreement(record: NegotiationRecord, sessionId: string, mandate: ValidConfirmedMandate, prefix = "a") {
  const t = demoTerms(mandate);
  const final: OfferTerm[] = [
    { termId: t.price, value: money(19_000) },
    { termId: t.pickup, value: { type: "text", value: "Koramangala, Bangalore" } },
    { termId: t.delivery, value: { type: "boolean", value: false } },
  ];
  await mustAppend(record, sessionId, inbound(`${prefix}-m1`, "I can pay ₹19,000."), BUYER);
  await mustAppend(record, sessionId, extracted(`${prefix}-o1`, `${prefix}-m1`, [final[0]!]), AGENT);
  await mustAppend(record, sessionId, proposed(`${prefix}-f1`, final), AGENT);
  await mustAppend(record, sessionId, outbound(`${prefix}-m2`, "Final terms: ₹19,000, pickup from Koramangala, no delivery. Confirm?", [`${prefix}-f1`]), AGENT);
  await mustAppend(record, sessionId, delivered(`${prefix}-d1`, `${prefix}-m2`), SYSTEM);
  await mustAppend(record, sessionId, inbound(`${prefix}-m3`, "Yes, confirmed."), BUYER);
  await mustAppend(record, sessionId, acceptance(`${prefix}-acc`, `${prefix}-f1`, `${prefix}-m3`, final), AGENT);
  await mustAppend(record, sessionId, approvalRequest(`${prefix}-req`, `${prefix}-f1`, final, `${prefix}-acc`), AGENT);
  await mustAppend(record, sessionId, approvalResponse(`${prefix}-apr`, `${prefix}-req`, `${prefix}-f1`, final), SELLER);
  await mustAppend(record, sessionId, agreement(`${prefix}-agr`, `${prefix}-f1`, final, `${prefix}-acc`, `${prefix}-apr`), AGENT);
  await mustAppend(record, sessionId, { id: `${prefix}-st`, type: "status_changed", channel: null, payload: { from: "active", to: "agreed", reason: "Buyer accepted and the seller approved." } }, AGENT);
  return { final };
}
