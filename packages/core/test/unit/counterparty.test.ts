/** Epic 5: the counterparty's needs, claims, limit estimates and questions. Test values only. */
import { describe, expect, it } from "vitest";
import { projectCounterparty } from "../../src/counterparty/model.ts";
import type { StructuredLlm, StructuredRequest, StructuredResponse } from "../../src/llm/types.ts";
import { NegotiationEngine } from "../../src/negotiation/engine.ts";
import type { PayloadOf } from "../../src/record/events.ts";
import { listingOnlyDeliveryMandate } from "../support/mandates.ts";
import { openRecord } from "../support/record.ts";

type Interp = Record<string, unknown>;
const v = (type: string, fields: Record<string, unknown>) => ({ type, amount: null, currency: null, unit: null, text: null, boolean: null, ...fields });
const price = (amount: number) => ({ term_id: "term_price", value: v("money", { amount }) });
const note = (kind: string, quote: string, summary: string, extra: Record<string, unknown> = {}) => ({ kind, quote, summary, term_id: null, value: null, condition: null, basis: "stated", ...extra });

class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Interp[] = [];
  readonly seen: StructuredRequest[] = [];
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    this.seen.push(request);
    const reply = (json: unknown) => ({ json, rawText: "", model: "scripted", latencyMs: 0 });
    if (request.purpose === "interpret_counterparty") {
      return reply({ intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, notes: [], answers: [], new_terms: [], questions: [], ...this.interpretations.shift() });
    }
    if (request.purpose === "language_check") return reply({ concerns: [] });
    throw new Error("template wording");
  }
}

async function setup() {
  const { record } = openRecord();
  const started = await record.startSession({ mandate: listingOnlyDeliveryMandate(18_000) });
  if (!started.ok) throw new Error("start failed");
  const llm = new ScriptedLlm();
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN" });
  const sessionId = started.session.id;
  const say = async (text: string, interp: Interp) => {
    llm.interpretations.push(interp);
    const r = await engine.handleCounterpartyMessage({ sessionId, text, channel: "text" });
    if (!r.ok) throw new Error(r.message);
    if (r.reply) await engine.reportDelivery({ sessionId, messageId: r.reply.messageId, channel: "text", status: "delivered" });
    return r;
  };
  const model = async () => projectCounterparty(await record.context(sessionId), "term_price");
  const events = () => record.read(sessionId, { viewer: "operator" });
  return { record, engine, llm, sessionId, say, model, events };
}

describe("Story 1: the buyer's position and needs", () => {
  it('"₹18,000 for the bed, but transport adds ₹2,000": the offer and the collection cost stay distinct', async () => {
    const { say, model } = await setup();
    await say("₹18,000 for the bed, but transport adds ₹2,000.", {
      intent: "offer",
      offer_terms: [price(18_000)],
      notes: [note("constraint", "transport adds ₹2,000", "Transport will cost the buyer 2,000.", { value: v("money", { amount: 2_000 }) })],
    });
    const m = await model();
    expect(m.offers.map((o) => o.amount)).toEqual([18_000]);
    const cost = m.items.find((i) => i.kind === "constraint")!;
    expect(cost.value).toMatchObject({ type: "money", amount: 2_000 });
    expect(cost.quote).toBe("transport adds ₹2,000");
  });

  it('"Saturday works only if I can get a vehicle": availability stays conditional', async () => {
    const { say, model } = await setup();
    await say("Saturday works only if I can get a vehicle.", {
      notes: [note("constraint", "Saturday works only if I can get a vehicle", "Saturday collection depends on getting a vehicle.", { condition: "you can get a vehicle" })],
    });
    const item = (await model()).items[0]!;
    expect(item.condition).toBe("you can get a vehicle");
  });

  it('"My partner must approve": further buyer-side approval is recorded as required', async () => {
    const { say, model } = await setup();
    await say("My partner must approve before I buy.", { notes: [note("authority", "My partner must approve", "The buyer needs their partner's approval.")] });
    const m = await model();
    expect(m.items[0]!.kind).toBe("authority");
    expect(m.questions.map((q) => q.issueKind)).toContain("authority");
  });

  it('"The seller promised a mattress": recorded as a claim; not a fact, a term or a permission', async () => {
    const { say, model, engine, sessionId } = await setup();
    await say("The seller promised a mattress with it.", { notes: [note("claim", "The seller promised a mattress", "The buyer says a mattress was promised.")] });
    const m = await model();
    expect(m.items[0]).toMatchObject({ kind: "claim", basis: "stated" });
    const s = await engine.state(sessionId);
    expect(JSON.stringify(s.view.mandate)).not.toMatch(/mattress/i);
  });

  it("a quote that is not in the message is dropped, and the buyer's words stay exact", async () => {
    const { say, model } = await setup();
    await say("I can collect on Saturday.", { notes: [note("preference", "I prefer weekends", "Prefers weekends."), note("preference", "collect on Saturday", "Can collect on Saturday.")] });
    expect((await model()).items.map((i) => i.quote)).toEqual(["collect on Saturday"]);
  });

  it("notes are private: the buyer's view never includes the agent's reading", async () => {
    const { say, record, sessionId } = await setup();
    await say("My budget is ₹19,000.", { notes: [note("budget", "My budget is ₹19,000", "Budget 19,000.", { value: v("money", { amount: 19_000 }) })] });
    const view = await record.read(sessionId, { viewer: "counterparty" });
    expect(view.some((e) => e.type === "counterparty_noted" || e.type === "question_prepared")).toBe(false);
  });

  it("a failed read preserves earlier context and flags the message", async () => {
    const { say, model, llm, engine, sessionId } = await setup();
    await say("My budget is ₹19,000.", { notes: [note("budget", "My budget is ₹19,000", "Budget.", { value: v("money", { amount: 19_000 }) })] });
    const original = llm.generate.bind(llm);
    llm.generate = async (r) => (r.purpose === "interpret_counterparty" ? Promise.reject(new Error("timeout")) : original(r));
    const failed = await engine.handleCounterpartyMessage({ sessionId, text: "asdf", channel: "text" });
    expect(failed.ok === false && failed.code).toBe("model_unavailable");
    const m = await model();
    expect(m.items).toHaveLength(1);
    expect(m.failedMessages).toHaveLength(1);
  });
});

describe("Story 2: a qualified estimate of buyer limits", () => {
  it("only offer ₹17,000: the offer is recorded and the maximum stays unknown", async () => {
    const { say, model } = await setup();
    await say("₹17,000?", { intent: "offer", offer_terms: [price(17_000)] });
    const e = (await model()).estimates[0]!;
    expect(e.highestOffer?.amount).toBe(17_000);
    expect(e.maximum.status).toBe("unknown");
  });

  it("a claimed ₹18,000 maximum, then an ₹18,500 offer: the ceiling is contradicted and the maximum uncertain", async () => {
    const { say, model } = await setup();
    await say("My maximum is ₹18,000.", { notes: [note("budget", "My maximum is ₹18,000", "Claims a maximum of 18,000.", { value: v("money", { amount: 18_000 }) })] });
    await say("Okay, ₹18,500.", { intent: "offer", offer_terms: [price(18_500)] });
    const m = await model();
    expect(m.estimates.some((e) => e.maximum.status === "contradicted")).toBe(true);
    expect(m.contradictions).toHaveLength(1);
    // The earlier claim is preserved.
    expect(m.items.find((i) => i.kind === "budget")!.quote).toBe("My maximum is ₹18,000");
  });

  it("₹18,000 with collection versus ₹19,000 including delivery: different packages, no direct comparison", async () => {
    const { say, model } = await setup();
    await say("₹18,000 and I'll collect.", { intent: "offer", offer_terms: [price(18_000)] });
    await say("₹19,000 if you deliver.", { intent: "offer", offer_terms: [price(19_000), { term_id: "term_delivery", value: v("boolean", { boolean: true }) }] });
    const m = await model();
    expect(new Set(m.offers.map((o) => o.packageKey)).size).toBe(2);
    expect(m.estimates).toHaveLength(2);
    for (const e of m.estimates) expect(e.maximum.status).toBe("unknown");
  });

  it('"Another seller charges ₹16,000": a claim, with no benchmark or limit inferred', async () => {
    const { say, model, engine, sessionId } = await setup();
    await say("Another seller charges ₹16,000.", { notes: [note("claim", "Another seller charges ₹16,000", "Claims a cheaper alternative.", { value: v("money", { amount: 16_000 }) })] });
    const m = await model();
    expect(m.estimates).toHaveLength(0);
    expect((await engine.state(sessionId)).view.negotiable!.limit).toBe(18_000);
  });

  it('"This is my final offer" stays a stated position, not a maximum', async () => {
    const { say, model } = await setup();
    await say("₹17,500, this is my final offer.", { intent: "offer", offer_terms: [price(17_500)], notes: [note("final_position", "this is my final offer", "Says the offer is final.")] });
    const e = (await model()).estimates[0]!;
    expect(e.finalStatements).toHaveLength(1);
    expect(e.maximum.status).toBe("unknown");
  });

  it("estimates never change the principal's limits or grant authority", async () => {
    const { say, engine, sessionId } = await setup();
    await say("My budget is ₹15,000.", { notes: [note("budget", "My budget is ₹15,000", "Budget 15,000.", { value: v("money", { amount: 15_000 }) })] });
    const s = await engine.state(sessionId);
    expect(s.view.negotiable!.limit).toBe(18_000);
    expect(s.outcome.kind).toBe("in_progress");
  });
});

describe("Story 3: questions that resolve useful unknowns", () => {
  it('"My budget is ₹19,000 including transport": a question about the amount left for the item', async () => {
    const { say, model } = await setup();
    await say("My budget is ₹19,000 including transport.", {
      notes: [note("budget", "My budget is ₹19,000 including transport", "Budget 19,000 covers transport too.", { value: v("money", { amount: 19_000 }), condition: "including transport" })],
    });
    const q = (await model()).questions.find((x) => x.issueKind === "budget_scope")!;
    expect(q.text).toMatch(/how much is available for the item itself, after transport/i);
    expect(q.purpose).toBeTruthy();
  });

  it('"Collection is the problem": a question about which part of collection does not work', async () => {
    const { say, model } = await setup();
    await say("Collection is the problem.", { notes: [note("constraint", "Collection is the problem", "Collection is an obstacle.", { term_id: "term_pickup" })] });
    const q = (await model()).questions.find((x) => x.issueKind === "obstacle")!;
    expect(q.text).toBe("Which part of the pickup location doesn't work for you?");
  });

  it("partner approval: a question about whether terms can be confirmed now", async () => {
    const { say, model } = await setup();
    await say("My partner must approve.", { notes: [note("authority", "My partner must approve", "Needs partner approval.")] });
    expect((await model()).questions.find((x) => x.issueKind === "authority")!.text).toMatch(/confirm terms yourself now/i);
  });

  it("an answered question links to the answer and is not prepared again", async () => {
    const { say, model, events } = await setup();
    // Kritva asks the prepared question in its holding reply.
    const asked = await say("Collection is the problem.", { notes: [note("constraint", "Collection is the problem", "Collection is an obstacle.", { term_id: "term_pickup" })] });
    const q = (await model()).questions[0]!;
    expect(q.status).toBe("asked");
    expect(asked.reply!.text).toContain(q.text);
    await say("Koramangala is too far for me.", { answers: [{ question_id: q.id, quote: "Koramangala is too far for me", resolution: "answered" }], notes: [note("constraint", "Collection is the problem again", "x", { term_id: "term_pickup" })] });
    const after = await model();
    expect(after.questions.filter((x) => x.issueKey === q.issueKey)).toHaveLength(1);
    expect(after.questions[0]!.status).toBe("answered");
    expect((await events()).find((e) => e.type === "question_answered")!.payload).toMatchObject({ quote: "Koramangala is too far for me" } satisfies Partial<PayloadOf<"question_answered">>);
  });

  it("a refusal stays unknown and is not asked again; answers never change the mandate", async () => {
    const { say, model, engine, sessionId } = await setup();
    await say("My partner must approve.", { notes: [note("authority", "My partner must approve", "Needs partner approval.")] });
    await say("Ok.", {});
    const q = (await model()).questions[0]!;
    expect(q.status).toBe("asked");
    await say("I'd rather not say.", { answers: [{ question_id: q.id, quote: null, resolution: "refused" }] });
    expect((await model()).questions[0]!.status).toBe("refused");
    const next = await say("Hmm.", {});
    expect(next.reply!.text).not.toContain(q.text);
    expect((await engine.state(sessionId)).mandateRevision).toBe(1);
  });

  it("questions are built from session context, not a fixed questionnaire", async () => {
    const { say, model } = await setup();
    await say("₹19,000?", { intent: "offer", offer_terms: [price(19_000)] });
    expect((await model()).questions).toHaveLength(0);
  });
});
