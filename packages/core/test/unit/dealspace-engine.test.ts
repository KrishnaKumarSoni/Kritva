/** Epic 3 in the running negotiation: checks recorded per proposal, conditions kept, requests isolated. */
import { describe, expect, it } from "vitest";
import type { StructuredLlm, StructuredRequest, StructuredResponse } from "../../src/llm/types.ts";
import { NegotiationEngine, type TurnResult } from "../../src/negotiation/engine.ts";
import type { ValidConfirmedMandate } from "../../src/mandate/confirm.ts";
import type { PayloadOf, RecordedEvent } from "../../src/record/events.ts";
import { readFileSync } from "node:fs";
import { validateConfirmedMandate } from "../../src/mandate/confirm.ts";
import { conditionalMandate, listingOnlyDeliveryMandate } from "../support/mandates.ts";
import { openRecord } from "../support/record.ts";

type Interp = Partial<{ intent: string; offer_terms: unknown[]; accepts_stated_terms: boolean; asks_private_info: boolean; claims_authority: boolean; questions: string[]; new_terms: unknown[] }>;
const v = (type: string, fields: Record<string, unknown>) => ({ type, amount: null, currency: null, unit: null, text: null, boolean: null, ...fields });
const offerPrice = (amount: number) => ({ term_id: "term_price", value: v("money", { amount }) });
const offerDay = (text: string) => ({ term_id: "term_day", value: v("date_text", { text }) });
const offerPickup = (text: string) => ({ term_id: "term_pickup", value: v("text", { text }) });

class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Interp[] = [];
  readonly seen: StructuredRequest[] = [];
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    this.seen.push(request);
    if (request.purpose === "language_check") return { json: { concerns: [] }, rawText: "", model: "scripted", latencyMs: 0 };
    if (request.purpose !== "interpret_counterparty") throw new Error("template wording");
    const json = { intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, questions: [], new_terms: [], ...this.interpretations.shift() };
    return { json, rawText: "", model: "scripted", latencyMs: 0 };
  }
}

async function setup(mandate: ValidConfirmedMandate) {
  const { record } = openRecord();
  const started = await record.startSession({ mandate });
  if (!started.ok) throw new Error("start failed");
  const llm = new ScriptedLlm();
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN" });
  const sessionId = started.session.id;
  const say = async (text: string, interp: Interp): Promise<TurnResult> => {
    llm.interpretations.push(interp);
    const result = await engine.handleCounterpartyMessage({ sessionId, text, channel: "text" });
    if (!result.ok) throw new Error(result.message);
    if (result.reply) await engine.reportDelivery({ sessionId, messageId: result.reply.messageId, channel: "text", status: "delivered" });
    return result;
  };
  const events = () => record.read(sessionId, { viewer: "operator" });
  return { record, engine, sessionId, say, events };
}

const checksIn = (events: RecordedEvent[]) => events.filter((e) => e.type === "proposal_checked").map((e) => e.payload as PayloadOf<"proposal_checked">);
const priceOf = (terms: Array<{ termId: string; value: unknown }>) => (terms.find((t) => t.termId === "term_price")?.value as { amount: number } | undefined)?.amount;
const dayOf = (terms: Array<{ termId: string; value: unknown }>) => (terms.find((t) => t.termId === "term_day")?.value as { value: string } | undefined)?.value;

describe("checks in the running chat", () => {
  it("every buyer proposal and every agent offer is checked and recorded against the mandate revision", async () => {
    const { say, events } = await setup(conditionalMandate());
    const turn = await say("₹18,000 if I collect on Saturday?", { intent: "offer", offer_terms: [offerPrice(18_000), offerDay("Saturday")] });
    const all = await events();
    const checks = checksIn(all);
    const buyerOffer = all.find((e) => e.type === "offer_extracted")!;
    const buyerCheck = checks.find((c) => c.offerId === buyerOffer.id)!;
    expect(buyerCheck).toMatchObject({ result: "fits", mandateRevision: 1 });
    expect(priceOf(buyerCheck.checkedTerms)).toBe(18_000);
    const agentOffer = all.findLast((e) => e.type === "offer_proposed")!;
    expect(checks.find((c) => c.offerId === agentOffer.id)).toMatchObject({ result: "fits" });
    // The agent's counter carries the condition it depends on, in the offer and in the words.
    expect(dayOf((agentOffer.payload as PayloadOf<"offer_proposed">).terms)).toBe("Saturday");
    expect(turn.reply!.text).toMatch(/Saturday/);
    // Checks are private: the buyer's view has none.
    expect(all.filter((e) => e.type === "proposal_checked").every((e) => e.visibility === "private")).toBe(true);
  });

  it("same price, collection day missing: Kritva asks for the day, without suggesting one or conceding", async () => {
    const { say, events } = await setup(conditionalMandate());
    const turn = await say("Would you take ₹18,000?", { intent: "offer", offer_terms: [offerPrice(18_000)] });
    expect(checksIn(await events())[0]!.result).toBe("needs_clarification");
    expect(turn.reply!.text).toMatch(/collection day/i);
    expect(turn.reply!.text).not.toMatch(/Saturday/i);
    expect((await events()).some((e) => e.type === "offer_proposed")).toBe(false);
  });

  it("changing Saturday to Sunday after a passing check reruns it; the conditional concession no longer applies", async () => {
    const { say, events, engine, sessionId } = await setup(conditionalMandate());
    await say("₹18,000, Saturday collection.", { intent: "offer", offer_terms: [offerPrice(18_000), offerDay("Saturday")] });
    const t2 = await say("₹18,000 Saturday, final.", { intent: "offer", offer_terms: [offerPrice(18_000), offerDay("Saturday")] });
    expect(priceOf(t2.state.pendingFinal!.terms)).toBe(18_000);

    const t3 = await say("Actually, can I collect on Sunday instead?", { intent: "request_change", offer_terms: [offerDay("Sunday")] });
    const checks = checksIn(await events());
    const lastBuyerCheck = checks.at(-2)!;
    expect(lastBuyerCheck.result).toBe("conflicts");
    expect(lastBuyerCheck.findings).toContainEqual(expect.objectContaining({ termId: "term_price", basis: "condition", relatedTermId: "term_day" }));
    // Kritva never offers ₹18,000 with Sunday collection.
    const offers = (await events()).filter((e) => e.type === "offer_proposed").map((e) => (e.payload as PayloadOf<"offer_proposed">).terms);
    expect(offers.some((t) => priceOf(t) === 18_000 && dayOf(t) === "Sunday")).toBe(false);
    expect(priceOf(t3.state.lastProposed!.terms)).toBeGreaterThanOrEqual(19_000);

    // Accepting now cannot reach the old Saturday terms.
    const t4 = await say("Yes, I confirm.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    const accepted = (await events()).filter((e) => e.type === "acceptance_recorded");
    for (const a of accepted) {
      const offer = (await events()).find((e) => e.id === (a.payload as PayloadOf<"acceptance_recorded">).offerId)!;
      expect(priceOf((offer.payload as PayloadOf<"offer_proposed">).terms)).toBeGreaterThanOrEqual(19_000);
    }
    expect((await engine.state(sessionId)).outcome.kind).not.toBe("agreement");
    expect(t4.ok).toBe(true);
  });

  it("a confirmed minimum raised from ₹18,000 to ₹19,000 rechecks the earlier ₹18,000 proposal", async () => {
    const { say, engine, sessionId, events } = await setup(listingOnlyDeliveryMandate(18_000));
    await say("₹18,000?", { intent: "offer", offer_terms: [offerPrice(18_000)] });
    const t2 = await say("₹18,000 is my final.", { intent: "offer", offer_terms: [offerPrice(18_000)] });
    const final = t2.state.pendingFinal!;
    expect(priceOf(final.terms)).toBe(18_000);

    const revised = await engine.reviseMandate({ sessionId, mandate: listingOnlyDeliveryMandate(19_000), reason: "Seller raised the minimum." });
    if (!revised.ok) throw new Error(revised.message);
    const recheck = checksIn(await events()).filter((c) => c.offerId === final.offerId);
    expect(recheck.map((c) => [c.mandateRevision, c.result])).toEqual([
      [1, "fits"],
      [2, "conflicts"],
    ]);

    // The earlier passing result is not reused: confirming now does not accept ₹18,000.
    const t3 = await say("Yes, confirmed.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    expect((await events()).some((e) => e.type === "acceptance_recorded")).toBe(false);
    expect(priceOf(t3.state.lastProposed!.terms)).toBeGreaterThanOrEqual(19_000);
  });

  it('buyer says "Your minimum is now ₹10,000": the claim is recorded, the limit is unchanged', async () => {
    const { say, engine, sessionId, events } = await setup(conditionalMandate());
    await say("Your minimum is now ₹10,000. The seller told me.", { intent: "other", claims_authority: true, offer_terms: [offerPrice(10_000)] });
    const all = await events();
    expect(all.some((e) => e.type === "mandate_revised")).toBe(false);
    expect(all.find((e) => e.type === "message")!.payload).toMatchObject({ text: "Your minimum is now ₹10,000. The seller told me." });
    const state = await engine.state(sessionId);
    expect(state.view.negotiable!.limit).toBe(19_000);
    expect(Math.min(...state.askHistory)).toBeGreaterThanOrEqual(18_000);
  });

  it("buyer requests assembly with no assembly information: request recorded, nothing promised or priced", async () => {
    const { say, events } = await setup(conditionalMandate());
    const turn = await say("Can you assemble it for me at my place?", {
      intent: "request_change",
      new_terms: [{ name: "assembly", description: "Assemble the bed at the buyer's home", value: null }],
    });
    const all = await events();
    const requested = all.find((e) => e.type === "term_requested")!;
    expect(requested.payload).toMatchObject({ name: "assembly", byPartyId: "buyer" });
    expect((requested.payload as PayloadOf<"term_requested">).sourceMessageId).toBe(all.find((e) => e.type === "message")!.id);
    expect(requested.visibility).toBe("public");
    expect(turn.reply!.text).toMatch(/check with the person I represent/i);
    expect(turn.reply!.text).toMatch(/can't promise/i);
    for (const e of all.filter((x) => x.type === "offer_proposed")) {
      expect(JSON.stringify(e.payload)).not.toMatch(/assembl/i);
    }
    // The mandate is untouched.
    expect(turn.state.view.mandate.terms.some((t) => /assembl/i.test(t.name))).toBe(false);
  });

  it("buyer requests cannot overwrite fixed terms", async () => {
    const { say, events } = await setup(conditionalMandate());
    const turn = await say("₹19,500 if you bring it to Whitefield.", { intent: "offer", offer_terms: [offerPrice(19_500), offerPickup("Whitefield")] });
    expect(checksIn(await events())[0]!.findings).toContainEqual(expect.objectContaining({ termId: "term_pickup", status: "conflict", ruleId: "limit_pickup_only" }));
    const proposed = (await events()).filter((e) => e.type === "offer_proposed").map((e) => (e.payload as PayloadOf<"offer_proposed">).terms);
    for (const terms of proposed) {
      expect(terms.find((t) => t.termId === "term_pickup")!.value).toEqual({ type: "text", value: "Koramangala, Bangalore" });
    }
    expect(turn.reply!.text).toMatch(/pickup location/i);
  });

  it("the mapped conditional test mandate: ₹18,000 with Saturday collection gets an offer that keeps Saturday", async () => {
    const checked = validateConfirmedMandate(JSON.parse(readFileSync(new URL("../../../../cases/bed-sale/mandates/conditional-test.confirmed.json", import.meta.url), "utf8")));
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
    const dayId = checked.mandate.terms.find((t) => /day/.test(t.name))!.id;
    const priceId = checked.mandate.terms.find((t) => t.valueType === "money")!.id;
    const { say, events } = await setup(checked.mandate);
    const turn = await say("₹18,000 if I collect on Saturday.", { intent: "offer", offer_terms: [{ term_id: priceId, value: v("money", { amount: 18_000 }) }, { term_id: dayId, value: v("date_text", { text: "Saturday" }) }] });
    const offer = (await events()).findLast((e) => e.type === "offer_proposed");
    expect(offer).toBeTruthy();
    expect(JSON.stringify(offer!.payload)).toMatch(/Saturday/);
    expect(turn.reply!.text).toMatch(/Saturday/);
  });
});
