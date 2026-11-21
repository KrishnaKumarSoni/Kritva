/** Epic 2: the shared negotiation record. Supplied text, voice and approval events only. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { hashTerms, type OfferTerm } from "../../src/record/events.ts";
import { SqliteRecordBackend } from "../../src/record/sqlite.ts";
import { NegotiationRecord, type EventRow } from "../../src/record/store.ts";
import {
  acceptance,
  AGENT,
  agreement,
  approvalRequest,
  approvalResponse,
  BUYER,
  delivered,
  demoTerms,
  extracted,
  inbound,
  loadDemoMandate,
  money,
  mustAppend,
  openRecord,
  outbound,
  proposed,
  recordAgreement,
  SELLER,
  SYSTEM,
  tempDbPath,
} from "../support/record.ts";

const mandate = loadDemoMandate();
const t = demoTerms(mandate);
const priceOnly = (amount: number): OfferTerm[] => [{ termId: t.price, value: money(amount) }];
const fullTerms = (amount: number): OfferTerm[] => [
  { termId: t.price, value: money(amount) },
  { termId: t.pickup, value: { type: "text", value: "Koramangala, Bangalore" } },
  { termId: t.delivery, value: { type: "boolean", value: false } },
];

let record: NegotiationRecord;
let path: string;
let sessionId: string;

beforeEach(async () => {
  ({ record, path } = openRecord());
  const started = await record.startSession({ mandate });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  sessionId = started.session.id;
});

const rejected = async (event: Parameters<NegotiationRecord["append"]>[1], actor: Parameters<NegotiationRecord["append"]>[2]) => {
  const result = await record.append(sessionId, event, actor);
  if (result.ok) throw new Error(`expected ${event.id} to be rejected`);
  return result.error;
};

describe("Story 1: record what happened", () => {
  it("saves the supplied mandate and its revision at session start", async () => {
    const [start] = await record.read(sessionId, { viewer: "operator" });
    expect(start).toMatchObject({ seq: 1, type: "session_started", sessionId, visibility: "private" });
    expect(start!.payload).toMatchObject({ mandateRevision: 1, previousSessionId: null });
    expect((start!.payload as { mandate: unknown }).mandate).toEqual(mandate);
  });

  it("saves a changed mandate as the next revision, by the principal only", async () => {
    const revised = { ...structuredClone(mandate) };
    const event = { id: "rev2", type: "mandate_revised" as const, channel: null, payload: { mandate: revised, mandateRevision: 2, reason: "Seller lowered the asking price." } };
    expect((await rejected(event, BUYER)).errors.map((e) => e.path)).toContain("actor.kind");
    await mustAppend(record, sessionId, event, SELLER);
    expect((await record.context(sessionId)).mandateRevision).toBe(2);
  });

  it("buyer offers ₹17,000: message and offer stored separately, with a source link", async () => {
    await mustAppend(record, sessionId, inbound("m1", "Would you take ₹17,000?"), BUYER);
    await mustAppend(record, sessionId, extracted("o1", "m1", priceOnly(17_000)), AGENT);
    const events = await record.read(sessionId, { viewer: "operator" });
    const message = events.find((e) => e.id === "m1")!;
    const offer = events.find((e) => e.id === "o1")!;
    expect(message.type).toBe("message");
    expect(offer.type).toBe("offer_extracted");
    expect(offer.payload).toMatchObject({ sourceMessageId: "m1", byPartyId: "buyer", terms: priceOnly(17_000) });
    expect(message.channel).toBe("text");
  });

  it("every event has an ID, session, sequence, time, type, source and content", async () => {
    await mustAppend(record, sessionId, inbound("m1", "Hi"), BUYER);
    for (const e of await record.read(sessionId, { viewer: "operator" })) {
      expect(e.id).toBeTruthy();
      expect(e.sessionId).toBe(sessionId);
      expect(Number.isInteger(e.seq)).toBe(true);
      expect(Date.parse(e.recordedAt)).not.toBeNaN();
      expect(e.type).toBeTruthy();
      expect(e.actor.kind).toBeTruthy();
      expect(e.payload).toBeTruthy();
    }
  });

  it("principal approves offer A; agent creates offer B: the approval stays attached to A", async () => {
    await mustAppend(record, sessionId, inbound("m1", "₹19,000?"), BUYER);
    await mustAppend(record, sessionId, extracted("A", "m1", priceOnly(19_000)), AGENT);
    await mustAppend(record, sessionId, approvalRequest("reqA", "A", priceOnly(19_000)), AGENT);
    await mustAppend(record, sessionId, approvalResponse("aprA", "reqA", "A", priceOnly(19_000)), SELLER);
    await mustAppend(record, sessionId, proposed("B", fullTerms(18_500)), AGENT);

    const ctx = await record.context(sessionId);
    const approval = ctx.payloadOf("aprA", "approval_responded")!;
    expect(approval.offerId).toBe("A");
    expect(approval.termsHash).toBe(hashTerms(priceOnly(19_000)));
    expect(approval.termsHash).not.toBe(ctx.offerTerms("B")!.termsHash);

    // The approval cannot be re-pointed at B, or used to record an agreement on B.
    const reuse = await rejected(approvalResponse("aprB", "reqA", "B", fullTerms(18_500)), SELLER);
    expect(reuse.errors.map((e) => e.reason)).toContain("does not match the approval request");
    await mustAppend(record, sessionId, outbound("m2", "₹18,500, pickup only. Confirm?", ["B"]), AGENT);
    await mustAppend(record, sessionId, delivered("d2", "m2"), SYSTEM);
    await mustAppend(record, sessionId, inbound("m3", "Yes"), BUYER);
    await mustAppend(record, sessionId, acceptance("accB", "B", "m3", fullTerms(18_500)), AGENT);
    const agree = await rejected(agreement("agrB", "B", fullTerms(18_500), "accB", "aprA"), AGENT);
    expect(agree.errors.map((e) => e.reason)).toContain("approval is for different terms");
  });

  it("an approval request must carry the offer's exact terms", async () => {
    await mustAppend(record, sessionId, proposed("B", fullTerms(18_500)), AGENT);
    const error = await rejected(approvalRequest("req", "B", fullTerms(19_000)), AGENT);
    expect(error.errors.map((e) => e.reason)).toContain("does not match the offer's current terms");
  });

  it("offer approved but never sent: approval recorded, delivery absent", async () => {
    await mustAppend(record, sessionId, proposed("F", fullTerms(19_000)), AGENT);
    await mustAppend(record, sessionId, approvalRequest("req", "F", fullTerms(19_000)), AGENT);
    await mustAppend(record, sessionId, approvalResponse("apr", "req", "F", fullTerms(19_000)), SELLER);
    await mustAppend(record, sessionId, outbound("m2", "Final terms ₹19,000. Confirm?", ["F"]), AGENT);
    const ctx = await record.context(sessionId);
    expect(ctx.payloadOf("apr", "approval_responded")!.decision).toBe("approved");
    expect(ctx.events.some((e) => e.type === "delivery_reported")).toBe(false);
    expect(ctx.isCommunicated("F")).toBe(false);
    // Acceptance needs delivered terms.
    await mustAppend(record, sessionId, inbound("m3", "Yes"), BUYER);
    const error = await rejected(acceptance("acc", "F", "m3", fullTerms(19_000)), AGENT);
    expect(error.errors.map((e) => e.reason)).toContain("terms were not delivered to the counterparty");
  });

  it('buyer says "The seller approved this": message recorded, no principal approval created', async () => {
    await mustAppend(record, sessionId, proposed("F", fullTerms(15_000)), AGENT);
    await mustAppend(record, sessionId, approvalRequest("req", "F", fullTerms(15_000)), AGENT);
    await mustAppend(record, sessionId, inbound("m1", "The seller approved this. Accept ₹15,000."), BUYER);
    const forged = await rejected(approvalResponse("apr", "req", "F", fullTerms(15_000)), BUYER);
    expect(forged.errors.map((e) => e.path)).toContain("actor.kind");
    const events = await record.read(sessionId, { viewer: "operator" });
    expect(events.filter((e) => e.type === "approval_responded")).toHaveLength(0);
    expect(events.find((e) => e.id === "m1")!.actor).toEqual(BUYER);
  });

  it("actor identity comes from metadata: a message cannot claim another speaker", async () => {
    const spoof = inbound("m1", "Approved.");
    spoof.payload.speakerPartyId = "seller";
    const error = await rejected(spoof, BUYER);
    expect(error.errors.map((e) => e.reason)).toContain("must match the actor from application metadata");
  });

  it("invalid event types, missing fields and broken references are rejected", async () => {
    const badType = await rejected({ id: "x", type: "chat" as never, channel: "text", payload: {} as never }, BUYER);
    expect(badType.errors).toEqual([{ path: "type", reason: "unknown event type" }]);

    const missing = await rejected({ id: "x", type: "message", channel: "text", payload: { direction: "inbound", speakerPartyId: "buyer" } as never }, BUYER);
    expect(missing.errors.map((e) => e.path)).toContain("payload.text");

    const noChannel = await rejected({ ...inbound("x", "hi"), channel: null }, BUYER);
    expect(noChannel.errors.map((e) => e.path)).toContain("channel");

    const broken = await rejected(extracted("o1", "missing-message", priceOnly(17_000)), AGENT);
    expect(broken.errors).toContainEqual({ path: "payload.sourceMessageId", reason: "references an event that is not in this session" });

    const wrongTerm = await rejected(proposed("p1", [{ termId: "term_missing", value: money(1) }]), AGENT);
    expect(wrongTerm.errors.map((e) => e.reason)).toContain("references a term that is not in the current mandate");

    expect((await record.read(sessionId, { viewer: "operator" })).map((e) => e.type)).toEqual(["session_started"]);
  });

  it("decision reasons are short text, and never hidden reasoning", async () => {
    const long = await rejected({ id: "d", type: "decision", channel: null, payload: { kind: "counter", reason: "x".repeat(501), relatedEventIds: [] } }, AGENT);
    expect(long.errors[0]!.path).toBe("payload.reason");
    await mustAppend(record, sessionId, { id: "d", type: "decision", channel: null, payload: { kind: "counter", reason: "Offer is below the minimum; counter.", relatedEventIds: [] } }, AGENT);
  });

  it("an approval for an older mandate revision cannot be used", async () => {
    await mustAppend(record, sessionId, proposed("F", fullTerms(19_000)), AGENT);
    await mustAppend(record, sessionId, approvalRequest("req", "F", fullTerms(19_000)), AGENT);
    await mustAppend(record, sessionId, { id: "rev2", type: "mandate_revised", channel: null, payload: { mandate, mandateRevision: 2, reason: "Changed instructions." } }, SELLER);
    const stale = await rejected(approvalResponse("apr", "req", "F", fullTerms(19_000)), SELLER);
    expect(stale.errors.map((e) => e.reason)).toContain("does not match the current mandate revision");
  });

  it("a full approved agreement records, and a second agreement is refused", async () => {
    const { final } = await recordAgreement(record, sessionId, mandate);
    const ctx = await record.context(sessionId);
    expect(ctx.status).toBe("agreed");
    const again = await rejected(agreement("agr2", "a-f1", final, "a-acc", "a-apr"), AGENT);
    expect(again.errors.map((e) => e.reason)).toContain("this session already has an agreement");
  });

  it("an agreement without the required approval is refused", async () => {
    await mustAppend(record, sessionId, proposed("F", fullTerms(19_000)), AGENT);
    await mustAppend(record, sessionId, outbound("m2", "₹19,000 pickup. Confirm?", ["F"]), AGENT);
    await mustAppend(record, sessionId, delivered("d", "m2"), SYSTEM);
    await mustAppend(record, sessionId, inbound("m3", "Yes"), BUYER);
    await mustAppend(record, sessionId, acceptance("acc", "F", "m3", fullTerms(19_000)), AGENT);
    const error = await rejected(agreement("agr", "F", fullTerms(19_000), "acc", null), AGENT);
    expect(error.errors).toContainEqual({ path: "payload.approvalId", reason: "the mandate requires the principal's approval" });
  });
});

describe("Story 2: one history across text and voice", () => {
  it("text message, voice reply, then text message: one ordered history with channel labels", async () => {
    await mustAppend(record, sessionId, inbound("m1", "Is it available?"), BUYER);
    await mustAppend(record, sessionId, outbound("m2", "Yes, it is.", [], "voice"), AGENT);
    await mustAppend(record, sessionId, delivered("d2", "m2", "voice"), SYSTEM);
    await mustAppend(record, sessionId, inbound("m3", "Great."), BUYER);
    const messages = (await record.read(sessionId, { viewer: "operator" })).filter((e) => e.type === "message");
    expect(messages.map((m) => [m.id, m.channel])).toEqual([["m1", "text"], ["m2", "voice"], ["m3", "text"]]);
    const seqs = messages.map((m) => m.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("a partial transcript becoming a completed transcript counts as one message", async () => {
    for (const [i, text] of ["Would you", "Would you take", "Would you take eighteen"].entries()) {
      await mustAppend(record, sessionId, { id: `frag${i}`, type: "transcript_fragment", channel: "voice", payload: { utteranceId: "u1", speakerPartyId: "buyer", text } }, BUYER);
    }
    await mustAppend(record, sessionId, inbound("m1", "Would you take eighteen thousand?", "voice", "u1"), BUYER);
    const events = await record.read(sessionId, { viewer: "operator" });
    expect(events.filter((e) => e.type === "message")).toHaveLength(1);
    expect(events.filter((e) => e.type === "transcript_fragment")).toHaveLength(3);
    // A fragment cannot be the source of an offer.
    const error = await rejected(extracted("o1", "frag2", priceOnly(18_000)), AGENT);
    expect(error.errors.map((e) => e.reason)).toContain("must reference message");
  });

  it("a completed transcript does not establish an agreement", async () => {
    await mustAppend(record, sessionId, inbound("m1", "Deal, I accept ₹19,000.", "voice", "u1"), BUYER);
    const ctx = await record.context(sessionId);
    expect(ctx.status).toBe("active");
    expect(ctx.events.some((e) => e.type === "agreement_recorded" || e.type === "acceptance_recorded")).toBe(false);
  });

  it("an interrupted voice offer is not communicated", async () => {
    await mustAppend(record, sessionId, proposed("F", fullTerms(19_000)), AGENT);
    await mustAppend(record, sessionId, outbound("m1", "Final terms: ₹19,000, pickup from Koramangala, no delivery.", ["F"], "voice"), AGENT);
    await mustAppend(record, sessionId, { id: "d1", type: "delivery_reported", channel: "voice", payload: { messageId: "m1", status: "interrupted", deliveredText: "Final terms: ₹19,000," } }, SYSTEM);
    expect((await record.context(sessionId)).isCommunicated("F")).toBe(false);
    const missingText = await rejected({ id: "d2", type: "delivery_reported", channel: "voice", payload: { messageId: "m1", status: "interrupted", deliveredText: null } }, SYSTEM);
    expect(missingText.errors[0]!.path).toBe("payload.deliveredText");
  });

  it("console and evaluation reads return the same IDs, content and order", async () => {
    await recordAgreement(record, sessionId, mandate);
    const consoleRead = await record.read(sessionId, { viewer: "operator" });
    const evalRead = await record.read(sessionId, { viewer: "evaluator" });
    expect(evalRead).toEqual(consoleRead);
  });

  it("repeated reads of unchanged history return the same content, and reading writes nothing", async () => {
    await recordAgreement(record, sessionId, mandate);
    const first = await record.read(sessionId, { viewer: "operator" });
    for (let i = 0; i < 3; i += 1) await record.read(sessionId, { viewer: "counterparty" });
    await record.context(sessionId);
    expect(await record.read(sessionId, { viewer: "operator" })).toEqual(first);
  });

  it("a counterparty view excludes the private floor and internal notes", async () => {
    await mustAppend(record, sessionId, inbound("m1", "What's your lowest?"), BUYER);
    await mustAppend(record, sessionId, { id: "dec", type: "decision", channel: null, payload: { kind: "decline_request", reason: "Floor is private; do not disclose.", relatedEventIds: ["m1"] } }, AGENT);
    await mustAppend(record, sessionId, { id: "blk", type: "reply_blocked", channel: null, payload: { draftText: "My minimum is ₹18,000.", violations: [{ rule: "private_amount", detail: "Mentions the private minimum." }] } }, AGENT);
    await mustAppend(record, sessionId, outbound("m2", "I can't share that, but the asking price is ₹20,000."), AGENT);
    const view = await record.read(sessionId, { viewer: "counterparty" });
    expect(view.map((e) => e.type)).toEqual(["message", "message"]);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("18000");
    expect(serialized).not.toContain("18,000");
    expect(serialized).not.toContain("Floor is private");
    // The operator still sees everything.
    expect((await record.read(sessionId, { viewer: "operator" })).map((e) => e.type)).toContain("reply_blocked");
  });

  it("changing input channel preserves preceding history", async () => {
    await mustAppend(record, sessionId, inbound("m1", "Hi, text first."), BUYER);
    const before = await record.read(sessionId, { viewer: "operator" });
    await mustAppend(record, sessionId, inbound("m2", "Now on voice.", "voice", "u2"), BUYER);
    const after = await record.read(sessionId, { viewer: "operator" });
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe("Story 3: retries, corrections and reset", () => {
  it("submitting the same event twice stores one event, and both calls identify it", async () => {
    const event = inbound("m1", "₹17,000?");
    const first = await record.append(sessionId, event, BUYER);
    const second = await record.append(sessionId, structuredClone(event), BUYER);
    if (!first.ok || !second.ok) throw new Error("expected both to succeed");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event).toEqual(first.event);
    expect((await record.read(sessionId, { viewer: "operator" })).filter((e) => e.id === "m1")).toHaveLength(1);
  });

  it("retries do not duplicate offers or approvals", async () => {
    await mustAppend(record, sessionId, proposed("F", fullTerms(19_000)), AGENT);
    await mustAppend(record, sessionId, approvalRequest("req", "F", fullTerms(19_000)), AGENT);
    for (let i = 0; i < 3; i += 1) {
      await record.append(sessionId, proposed("F", fullTerms(19_000)), AGENT);
      await record.append(sessionId, approvalResponse("apr", "req", "F", fullTerms(19_000)), SELLER);
    }
    const events = await record.read(sessionId, { viewer: "operator" });
    expect(events.filter((e) => e.type === "offer_proposed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "approval_responded")).toHaveLength(1);
  });

  it("changed content under the same ID is rejected", async () => {
    await mustAppend(record, sessionId, inbound("m1", "₹17,000?"), BUYER);
    const error = await rejected(inbound("m1", "₹10,000?"), BUYER);
    expect(error.code).toBe("id_conflict");
  });

  it("correcting ₹17,000 to ₹18,000 keeps the original and a linked correction", async () => {
    await mustAppend(record, sessionId, inbound("m1", "Would you take seventeen... eighteen thousand?"), BUYER);
    await mustAppend(record, sessionId, extracted("o1", "m1", priceOnly(17_000)), AGENT);
    const fixed = extracted("o1", "m1", priceOnly(18_000)).payload;
    await mustAppend(record, sessionId, { id: "c1", type: "correction", channel: null, payload: { correctsEventId: "o1", replacement: fixed, reason: "Buyer said eighteen, not seventeen." } }, AGENT);

    const events = await record.read(sessionId, { viewer: "operator" });
    expect(events.find((e) => e.id === "o1")!.payload).toMatchObject({ terms: priceOnly(17_000) });
    expect(events.find((e) => e.id === "c1")!.payload).toMatchObject({ correctsEventId: "o1", replacement: { terms: priceOnly(18_000) } });
    const ctx = await record.context(sessionId);
    expect(ctx.offerTerms("o1")!.terms).toEqual(priceOnly(18_000));
    expect(events.find((e) => e.id === "c1")!.visibility).toBe("public");
  });

  it("commitments cannot be corrected, and a no-op correction is refused", async () => {
    await mustAppend(record, sessionId, proposed("F", fullTerms(19_000)), AGENT);
    await mustAppend(record, sessionId, approvalRequest("req", "F", fullTerms(19_000)), AGENT);
    await mustAppend(record, sessionId, approvalResponse("apr", "req", "F", fullTerms(19_000)), SELLER);
    const error = await rejected({ id: "c1", type: "correction", channel: null, payload: { correctsEventId: "apr", replacement: {}, reason: "Change approval." } }, AGENT);
    expect(error.errors[0]!.reason).toContain("cannot be corrected");
    await mustAppend(record, sessionId, inbound("m1", "Hello"), BUYER);
    const noop = await rejected({ id: "c2", type: "correction", channel: null, payload: { correctsEventId: "m1", replacement: inbound("m1", "Hello").payload, reason: "Same." } }, AGENT);
    expect(noop.errors[0]!.reason).toBe("the correction changes nothing");
  });

  it("restart after a successful write: saved events and order remain intact", async () => {
    await recordAgreement(record, sessionId, mandate);
    const before = await record.read(sessionId, { viewer: "operator" });
    record.close();
    const reopened = new NegotiationRecord(new SqliteRecordBackend(path));
    const after = await reopened.read(sessionId, { viewer: "operator" });
    expect(after).toEqual(before);
    expect((await reopened.context(sessionId)).status).toBe("agreed");
    // Recovery read sends nothing and repeats nothing.
    expect(await reopened.read(sessionId, { viewer: "operator" })).toHaveLength(before.length);
    reopened.close();
  });

  it("a forced write failure returns an error and claims nothing as saved", async () => {
    class FailingBackend extends SqliteRecordBackend {
      failNext = false;
      override insertEvent(row: EventRow): void {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("disk full");
        }
        super.insertEvent(row);
      }
    }
    const backend = new FailingBackend(tempDbPath());
    const failing = new NegotiationRecord(backend);
    const started = await failing.startSession({ mandate });
    if (!started.ok) throw new Error("start failed");
    const id = started.session.id;

    backend.failNext = true;
    const result = await failing.append(id, inbound("m1", "₹17,000?"), BUYER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("write_failed");
    expect(await failing.read(id, { viewer: "operator" })).toHaveLength(1);

    // The same event can be saved on retry, with the next sequence number.
    const retry = await failing.append(id, inbound("m1", "₹17,000?"), BUYER);
    expect(retry.ok && retry.created && retry.event.seq).toBe(2);
  });

  it("reset after an agreement: the new session has its starting mandate and nothing else", async () => {
    await recordAgreement(record, sessionId, mandate);
    const reset = await record.resetSession(sessionId, mandate);
    if (!reset.ok) throw new Error(JSON.stringify(reset.error));
    const fresh = await record.read(reset.session.id, { viewer: "operator" });
    expect(fresh.map((e) => e.type)).toEqual(["session_started"]);
    expect(fresh[0]!.payload).toMatchObject({ previousSessionId: sessionId, mandateRevision: 1 });
    const ctx = await record.context(reset.session.id);
    expect(ctx.status).toBe("active");

    // The old session is retained unchanged.
    expect((await record.context(sessionId)).status).toBe("agreed");

    // The new session cannot reference the old session's offer or approval.
    const crossed = await record.append(reset.session.id, approvalRequest("x-req", "a-f1", fullTerms(19_000)), AGENT);
    expect(crossed.ok).toBe(false);
    if (!crossed.ok) expect(crossed.error.errors[0]!.reason).toBe("references an offer that is not in this session");
  });

  it("session reads and event IDs cannot mix data between sessions", async () => {
    await mustAppend(record, sessionId, inbound("m1", "Hi"), BUYER);
    const other = await record.startSession({ mandate });
    if (!other.ok) throw new Error("start failed");
    const reused = await record.append(other.session.id, inbound("m1", "Hi"), BUYER);
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error.code).toBe("id_conflict");
    expect((await record.read(other.session.id, { viewer: "operator" })).map((e) => e.type)).toEqual(["session_started"]);
  });

  it("saved records cannot be changed in storage", async () => {
    await mustAppend(record, sessionId, inbound("m1", "Hi"), BUYER);
    record.close();
    const db = new DatabaseSync(path);
    expect(() => db.exec("UPDATE events SET payload = '{}' WHERE id = 'm1'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM events WHERE id = 'm1'")).toThrow(/append-only/);
    db.close();
  });

  it("a session can only start from a valid confirmed mandate", async () => {
    const unconfirmed = { ...structuredClone(mandate), approval: { status: "unapproved" } };
    const result = await record.startSession({ mandate: unconfirmed as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_mandate");
  });
});

describe("Epic 2 non-functional requirements", () => {
  it("record code makes no model calls and has no case-specific fields", () => {
    const dir = join(import.meta.dirname, "../../src/record");
    for (const file of readdirSync(dir)) {
      if (!statSync(join(dir, file)).isFile()) continue;
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/from\s+["'](openai|\.\.\/llm|\.\.\/mapping)/);
      expect(text, file).not.toMatch(/\bbed\b|koramangala|pickup|delivery_included|₹/i);
    }
  });
});
