/** Epic 9: complete negotiation through text, on the existing core path. Test values only. */
import { describe, expect, it } from "vitest";
import { projectCommitments } from "../../src/commitments/model.ts";
import { gateTerms } from "../../src/governance/gate.ts";
import type { StructuredLlm, StructuredRequest, StructuredResponse } from "../../src/llm/types.ts";
import type { ValidConfirmedMandate } from "../../src/mandate/confirm.ts";
import { NegotiationEngine, type TurnResult } from "../../src/negotiation/engine.ts";
import { formatValue } from "../../src/negotiation/mandate-view.ts";
import type { Plan } from "../../src/negotiation/policy.ts";
import { projectState } from "../../src/negotiation/state.ts";
import type { OfferTerm, PayloadOf } from "../../src/record/events.ts";
import type { FulfillmentTerms } from "../../src/negotiation/interpret.ts";
import { parseGuidance } from "../../src/strategy/guidance.ts";
import { findAmounts } from "../../src/negotiation/reply-check.ts";
import { buildMandate, conditionalMandate, exceptionMandate, listingOnlyDeliveryMandate, noExceptionMandate } from "../support/mandates.ts";
import { openRecord } from "../support/record.ts";

type Interp = Record<string, unknown>;
const v = (type: string, fields: Record<string, unknown>) => ({ type, amount: null, currency: null, unit: null, text: null, boolean: null, ...fields });
const price = (amount: number) => ({ term_id: "term_price", value: v("money", { amount }) });
const day = (text: string) => ({ term_id: "term_day", value: v("date_text", { text }) });
const offer = (amount: number, extra: Interp = {}) => ({ intent: "offer", offer_terms: [price(amount)], offer_kind: "offer", ...extra });
const pkg = (amount: number): OfferTerm[] => [
  { termId: "term_delivery", value: { type: "boolean", value: false } },
  { termId: "term_pickup", value: { type: "text", value: "Koramangala, Bangalore" } },
  { termId: "term_price", value: { type: "money", amount, currency: "INR" } },
];
const GUIDANCE = parseGuidance({
  id: "test-guidance/1",
  source: "Unit test guidance.",
  increment: 100,
  concessionSteps: [3000],
  maxCounteroffers: 3,
  splitTheDifference: false,
  askBeforeConceding: true,
  walkAwayAfterMaxCounteroffers: false,
  walkAwayLine: null,
  pressureQuestions: { lowestPrice: "What price and collection time can you accept?", cheaperElsewhere: null },
});

class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Interp[] = [];
  readonly composed: Array<string | { text: string; question: string } | null> = [];
  readonly seen: StructuredRequest[] = [];
  readonly reviews: Array<Array<{ type: string; quote: string }>> = [];
  failInterpret = false;
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    this.seen.push(request);
    const reply = (json: unknown) => ({ json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 });
    if (request.purpose === "interpret_counterparty") {
      if (this.failInterpret) throw new Error("model unavailable");
      return reply({ intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, offer_kind: "none", offer_conditions: [], ends_negotiation: false, corrects_previous: false, pressure: "none", notes: [], answers: [], new_terms: [], questions: [], ...this.interpretations.shift() });
    }
    if (request.purpose === "language_check") return reply({ concerns: this.reviews.shift() ?? [] });
    const text = this.composed.shift() ?? null;
    if (text === null) throw new Error("template wording");
    return reply(typeof text === "string" ? { text } : text);
  }
}

async function setup(mandate: ValidConfirmedMandate, listingDetails?: { publicPrincipalName?: string; available?: boolean; fulfillment?: FulfillmentTerms }) {
  const { record } = openRecord();
  const started = await record.startSession({ mandate });
  if (!started.ok) throw new Error("start failed");
  const llm = new ScriptedLlm();
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", guidance: GUIDANCE, listingDetails: listingDetails ? new Map([[mandate.caseId, listingDetails]]) : undefined });
  const sessionId = started.session.id;
  type Draft = string | { text: string; question: string } | null;
  const say = async (text: string, interp: Interp, options: { composed?: Draft | Draft[]; deliver?: boolean; messageId?: string } = {}): Promise<TurnResult> => {
    llm.interpretations.push(interp);
    // A list scripts the first draft and then the one rewrite.
    llm.composed.length = 0;
    llm.composed.push(...(Array.isArray(options.composed) ? options.composed : [options.composed ?? null]));
    const result = await engine.handleCounterpartyMessage({ sessionId, text, channel: "text", messageId: options.messageId });
    if (!result.ok) throw new Error(result.message);
    if (result.reply && options.deliver !== false) await engine.reportDelivery({ sessionId, messageId: result.reply.messageId, channel: "text", status: "delivered" });
    return result;
  };
  const events = () => record.read(sessionId, { viewer: "operator" });
  const buyerEvents = () => record.read(sessionId, { viewer: "counterparty" });
  const state = async () => projectState(await record.context(sessionId));
  const commitments = async () => {
    const ctx = await record.context(sessionId);
    const s = projectState(ctx);
    return projectCommitments(ctx, { negotiableTermId: "term_price", termName: (id) => s.space.terms.find((t) => t.termId === id)?.name ?? id, format: (x) => formatValue(x, "en-IN") });
  };
  return { record, engine, llm, sessionId, say, events, buyerEvents, state, commitments };
}

const priceOf = (terms: OfferTerm[]) => (terms.find((t) => t.termId === "term_price")!.value as { amount: number }).amount;
const FULFILLMENT: FulfillmentTerms = {
  responsibilityTermId: "term_delivery", counterpartyLocationTermId: "term_pickup",
  principalActions: ["deliver"], counterpartyActions: ["collect", "pick up"],
};

describe("Epic 9, Story 1: buyer messages go through the core", () => {
  it("a stated ceiling earns one step toward it with a nudge; casual discount pressure after it makes no further concession", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    await say("It’s too much for me.", { price_concern: "objection" });
    const budget = await say("Budget is the problem. I can’t spend more than ₹18,000.", {});
    expect(budget.events.findLast((event) => event.type === "decision")?.payload).toMatchObject({ kind: "counter", action: "counter" });
    expect(budget.reply!.text).toMatch(/₹19,000.*\?/);
    for (const quote of ["What’s the best you could do?", "Can you go any lower than that?"]) {
      const turn = await say(quote, {
        intent: "question", price_concern: "objection", public_term_questions: [{ term_id: "term_price", basis: "current", quote }],
      });
      // The position holds at ₹19,000; the price is not restated when the last reply already said it.
      expect(findAmounts(turn.reply!.text).every((amount) => amount === 19_000)).toBe(true);
      expect(turn.reply!.offerIds).toEqual([]);
      expect(turn.events.find((event) => event.type === "decision")?.payload).toMatchObject({ kind: "hold", interpretation: { pressure: "lowest_price", asksPrivateInfo: false } });
    }
    // The budget is never an offer, and pressure without a new number earns no second step.
    expect((await events()).some((event) => event.type === "offer_extracted")).toBe(false);
    expect((await events()).filter((event) => event.type === "offer_proposed")).toHaveLength(1);
  });

  it("keeps the payment offer separate from the ancillary cost and does not create a new place from self-fulfillment", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate(), { fulfillment: FULFILLMENT });
    const turn = await say("The truck quote is ₹1,500, so I can pay ₹17,500 for the bed and collect it myself.", {
      intent: "other", offer_kind: "budget_ceiling",
      offer_terms: [{ term_id: "term_pickup", value: v("text", { text: "collect it myself" }) }],
      offer_conditions: ["you collect it yourself"],
    });
    expect(turn.events.find((event) => event.type === "offer_extracted")?.payload).toMatchObject({ kind: "offer", terms: [{ termId: "term_price", value: { amount: 17_500 } }], conditions: [] });
    expect(turn.reply!.text).not.toMatch(/location confirmed|settle before/);
  });

  it("declines a requested service on a full-price offer without treating its destination as the counterparty's location", async () => {
    const mandate = buildMandate({
      instructions: "You can negotiate the price. Pickup only. Ask me before accepting any offer.",
      build: (draft) => draft.limits.push({ id: "limit_no_delivery", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "Pickup only" }], partyId: "seller", termId: "term_delivery", kind: "must_equal", value: { type: "boolean", value: false }, conditionIds: [] }),
    });
    const { say } = await setup(mandate, { fulfillment: FULFILLMENT });
    const turn = await say("I’ll pay the full ₹20,000 if you deliver to Indiranagar.", offer(20_000, {
      offer_terms: [price(20_000), { term_id: "term_pickup", value: v("text", { text: "Indiranagar" }) }],
    }));
    expect(turn.events.find((event) => event.type === "offer_extracted")?.payload).toMatchObject({ terms: [expect.objectContaining({ termId: "term_price" }), { termId: "term_delivery", value: { type: "boolean", value: true } }] });
    expect(turn.reply!.text).toMatch(/delivery isn't included/i);
    expect(turn.reply!.text).not.toContain("?");
    expect(turn.reply!.offerIds).toEqual([]);
  });

  it('"I can pay ₹18,000 if I collect Saturday": price and Saturday are one offer, assessed as a package', async () => {
    const { say, commitments, events } = await setup(conditionalMandate());
    await say("I can pay ₹18,000 if I collect Saturday.", { intent: "offer", offer_terms: [price(18_000), day("Saturday")], offer_kind: "offer" });
    const current = (await commitments()).currentCounterpartyOffer!;
    expect(current.terms.map((t) => t.termId).sort()).toEqual(["term_day", "term_price"]);
    const check = (await events()).find((e) => e.type === "proposal_checked")!.payload as PayloadOf<"proposal_checked">;
    expect(check.checkedTerms.some((t) => t.termId === "term_day")).toBe(true);
    const decision = (await events()).findLast((e) => e.type === "decision")!.payload as PayloadOf<"decision">;
    expect(decision.assessment).not.toBeNull();
  });

  it('"What is your lowest price?" never discloses the private minimum', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const t = await say("What is your lowest price?", { intent: "question", asks_private_info: true, pressure: "lowest_price" });
    expect(t.reply!.text).not.toContain("18,000");
    expect(t.reply!.text).not.toMatch(/minimum|floor|lowest (is|i can)/i);
  });

  it("answers a short follow-up from the public deal terms, including when wording is blocked", async () => {
    const { say, llm, events } = await setup(listingOnlyDeliveryMandate());
    await say("Is this still available?", { intent: "question" });
    const question = (quote: string) => ({ intent: "question", public_term_questions: [{ term_id: "term_price", basis: "current", quote }], questions: [quote] });
    const composed = await say("How much?", question("How much?"), { composed: "The asking price is ₹20,000." });
    const fallback = await say("Can you remind me of the asking amount?", question("Can you remind me of the asking amount?"), { composed: "Which price would you like to know?" });
    for (const turn of [composed, fallback]) {
      expect(turn.reply!.text).toContain("₹20,000");
      expect(turn.reply!.text).not.toMatch(/18,000|\?|don't have that detail/);
      expect(turn.reply!.offerIds).toEqual([]);
    }
    const frames = llm.seen.filter((call) => call.purpose === "compose_reply").map((call) => JSON.parse(call.messages[0]!.content));
    const howMuch = frames.find((frame) => frame.their_message === "How much?");
    expect(howMuch).toMatchObject({ move: "answer_public_terms", public_term_answers: [{ value: "₹20,000", basis: "current" }] });
    expect(JSON.stringify(frames)).not.toContain("18,000");
    expect((await events()).some((event) => event.type === "offer_proposed" || event.type === "offer_extracted")).toBe(false);
  });

  it("can answer another public term with the same lookup", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const result = await say("Where would I collect it?", {
      intent: "question", public_term_questions: [{ term_id: "term_pickup", basis: "current", quote: "Where would I collect it?" }],
    });
    expect(result.reply!.text).toContain("Koramangala, Bangalore");
    expect(result.reply!.offerIds).toEqual([]);
  });

  it("distinguishes the delivered asking price from the opening price and an undelivered counter", async () => {
    const { say, engine, sessionId, state } = await setup(listingOnlyDeliveryMandate());
    const counter = await say("I'll pay ₹18,500.", offer(18_500), { deliver: false });
    const ask = (quote: string, basis: string) => say(quote, { intent: "question", public_term_questions: [{ term_id: "term_price", basis, quote }] });
    expect((await ask("How much is it right now?", "current")).reply!.text).toContain("₹20,000");
    await engine.reportDelivery({ sessionId, messageId: counter.reply!.messageId, channel: "text", status: "delivered" });
    const updatedAsk = (await state()).currentAsk;
    expect(updatedAsk).toBeLessThan(20_000);
    const formatted = formatValue({ type: "money", amount: updatedAsk!, currency: "INR" }, "en-IN");
    expect((await ask("What's the current ask?", "current")).reply!.text).toContain(formatted);
    expect((await ask("What was it listed for originally?", "opening")).reply!.text).toContain("₹20,000");
  });

  it("a question about a mattress, with no mattress fact, gets no invented answer", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const t = await say("Is a mattress included?", { intent: "question", questions: ["Is a mattress included?"] });
    expect(t.reply!.text).toMatch(/don't have anything beyond that confirmed/);
    expect(t.reply!.text).not.toMatch(/mattress (is|comes) included|includes a mattress/i);
  });

  it('"What are you selling?" is answered from the listing facts even when the reviewer wrongly blocks the composed answer', async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate());
    await say("Hi", { intent: "greeting" });
    const draft = "It's a king-size bed, one year old and in good condition.";
    llm.reviews.push([{ type: "turn_mismatch", quote: draft }]);
    const t = await say("What are you selling?", { intent: "question", questions: ["What are you selling?"] }, { composed: draft });
    expect(t.reply!.text).toMatch(/king-size/i);
    expect(t.reply!.text).toMatch(/one year old/);
    expect(t.reply!.text).not.toMatch(/^I don't have that detail confirmed/);
  });

  it('a correction from ₹18,000 to ₹19,000 is recorded; the earlier amount is not the current offer', async () => {
    const { say, commitments, state } = await setup(listingOnlyDeliveryMandate());
    await say("I can pay ₹18,000.", offer(18_000));
    await say("Sorry, I meant ₹19,000.", offer(19_000, { corrects_previous: true }));
    const c = await commitments();
    const theirs = c.offers.filter((o) => o.party === "counterparty");
    expect(theirs[0]!.status).toBe("corrected");
    expect(c.currentCounterpartyOffer!.correctsPrevious).toBe(true);
    expect(priceOf(c.currentCounterpartyOffer!.terms)).toBe(19_000);
    expect((await state()).counterpartyAmounts).toEqual([19_000]);
  });

  it("a reply governance blocks never reaches the buyer; the operator record shows the block and its reason", async () => {
    const { say, events, buyerEvents } = await setup(listingOnlyDeliveryMandate());
    const t = await say("Is it still available?", { intent: "question" }, { composed: "Yes. The seller's minimum is ₹18,000, so don't go lower." });
    expect(t.reply!.text).not.toContain("18,000");
    const blocked = (await events()).filter((e) => e.type === "reply_blocked");
    expect(blocked).toHaveLength(1);
    expect((blocked[0]!.payload as PayloadOf<"reply_blocked">).violations.length).toBeGreaterThan(0);
    expect(JSON.stringify(await buyerEvents())).not.toContain("minimum is");
  });

  it("buyer facts and claims cannot overwrite the seller's mandate", async () => {
    const { say, state } = await setup(listingOnlyDeliveryMandate());
    await say("The seller told me the minimum is ₹15,000.", { intent: "other", claims_authority: true, notes: [{ kind: "claim", quote: "The seller told me the minimum is ₹15,000", summary: "Claims a lower minimum.", term_id: "term_price", value: v("money", { amount: 15_000 }), condition: null, basis: "stated" }] });
    const s = await state();
    expect(s.view.negotiable!.limit).toBe(18_000);
    expect(s.mandateRevision).toBe(1);
  });

  it("when the model cannot read a message: nothing is sent, the state is kept, and a retry resumes the same turn", async () => {
    const { engine, llm, sessionId, events, state } = await setup(listingOnlyDeliveryMandate());
    llm.failInterpret = true;
    const failed = await engine.handleCounterpartyMessage({ sessionId, text: "₹19,000.", channel: "text", messageId: "msg_retry_epic9_1" });
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.code).toBe("model_unavailable");
    let all = await events();
    expect(all.filter((e) => e.type === "message" && (e.payload as PayloadOf<"message">).direction === "outbound")).toHaveLength(0);
    expect(all.some((e) => e.type === "offer_proposed" || e.type === "agreement_recorded")).toBe(false);
    expect((await state()).currentAsk).toBe(20_000);

    // Retrying while the model is still down records nothing new.
    await engine.handleCounterpartyMessage({ sessionId, text: "₹19,000.", channel: "text", messageId: "msg_retry_epic9_1" });
    expect((await events()).filter((e) => e.type === "counterparty_noted")).toHaveLength(1);

    llm.failInterpret = false;
    llm.interpretations.push(offer(19_000));
    const retried = await engine.handleCounterpartyMessage({ sessionId, text: "₹19,000.", channel: "text", messageId: "msg_retry_epic9_1" });
    expect(retried.ok && retried.reply).toBeTruthy();
    all = await events();
    expect(all.filter((e) => e.type === "message" && (e.payload as PayloadOf<"message">).direction === "inbound")).toHaveLength(1);
    expect(all.filter((e) => e.type === "message" && (e.payload as PayloadOf<"message">).direction === "outbound")).toHaveLength(1);
  });
});

describe("Epic 9, Story 2: offers and the correct outcome", () => {
  it("₹17,500 under a ₹18,000 minimum with no exceptions is blocked", async () => {
    const { state } = await setup(noExceptionMandate());
    const s = await state();
    const plan: Plan = { move: "counter", decision: { kind: "counter", reason: "test" }, offer: { terms: pkg(17_500), basis: "counter" }, acceptanceOf: null, declined: [], refuseDisclosure: false, ignoreAuthorityClaim: false, questions: [], respondingTo: null, notice: null, clarify: [], unresolved: [], ask: null };
    expect(gateTerms(s, plan, s.mandateRevision).decision).toBe("block");
  });

  it('"I do not want to speak to an AI" ends without agreement, as the buyer\'s refusal', async () => {
    const { say, commitments, events } = await setup(listingOnlyDeliveryMandate());
    const t = await say("I do not want to speak to an AI.", { intent: "reject", ends_negotiation: true });
    expect(t.state.status).toBe("no_agreement");
    const c = await commitments();
    expect(c.stopped!.by).toBe("counterparty");
    expect((await events()).some((e) => e.type === "agreement_recorded")).toBe(false);
    expect(t.reply!.text).toBe("Understood. Thanks for your time.");
  });

  it("an approved seller offer that was never delivered cannot be agreed by a buyer's 'yes'", async () => {
    const { say, engine, sessionId, events, state } = await setup(exceptionMandate());
    await say("₹15,000.", offer(15_000));
    await say("₹17,000, that's my limit.", offer(17_000));
    const request = (await state()).pendingApproval!;
    expect(request.purpose).toBe("exception");
    const approved = await engine.respondToApproval({ sessionId, requestId: request.requestId, decision: "approved" });
    expect(approved.ok && approved.reply).toBeTruthy();
    // The approved terms were sent but never displayed to the buyer (no delivery report).
    const t = await say("Yes.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    expect(t.state.outcome.kind).not.toBe("agreement");
    expect((await events()).some((e) => e.type === "agreement_recorded" || e.type === "acceptance_recorded")).toBe(false);
  });

  it("silence after a request for approval creates no agreement, and outcomes survive a reload", async () => {
    const { say, record, sessionId } = await setup(listingOnlyDeliveryMandate());
    await say("₹19,000.", offer(19_000));
    await say("₹19,000.", offer(19_000));
    const accepted = await say("Yes, I confirm.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    expect(accepted.state.outcome.kind).toBe("pending_approval");
    const reloaded = projectState(await record.context(sessionId));
    expect(reloaded.outcome.kind).toBe("pending_approval");
    expect(reloaded.pendingApproval!.termsHash).toBe(accepted.state.pendingApproval!.termsHash);
  });
});

describe("Epic 9, Story 3: pause and resume from the saved record", () => {
  it("pause keeps the open offer and sends no negotiation reply; resume continues from the saved state", async () => {
    const { say, engine, sessionId, events, commitments } = await setup(listingOnlyDeliveryMandate());
    await say("₹15,000.", offer(15_000));
    await engine.setPaused({ sessionId, paused: true });
    const paused = await say("₹16,000.", offer(16_000));
    expect(paused.reply!.text).toContain("paused");
    expect((paused.reply!.offerIds ?? []).length).toBe(0);
    expect((await commitments()).currentPrincipalOffer!.status).toBe("delivered");
    await engine.setPaused({ sessionId, paused: false });
    const resumed = await say("₹16,000.", offer(16_000));
    expect(resumed.state.status).toBe("active");
    const sent = (await events()).filter((e) => e.type === "offer_proposed").map((e) => priceOf((e.payload as PayloadOf<"offer_proposed">).terms));
    expect(sent.every((p) => p >= 18_000)).toBe(true);
  });

  it("a refresh (repeated message ID) replays the turn and never resends the counteroffer", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    const first = await say("₹15,000.", offer(15_000), { messageId: "msg_refresh_epic9_1" });
    const again = await say("₹15,000.", offer(15_000), { messageId: "msg_refresh_epic9_1" });
    expect(again.reply!.messageId).toBe(first.reply!.messageId);
    expect((await events()).filter((e) => e.type === "offer_proposed")).toHaveLength(1);
  });
});

describe("Humane conversation guide", () => {
  it("Kritva introduces itself once as the principal's assistant, then never repeats it", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const first = await say("Is it still available?", { intent: "question" });
    expect(first.reply!.text).toMatch(/^Hi, I'm Kritva, the seller's assistant\./);
    const second = await say("₹15,000.", offer(15_000));
    expect(second.reply!.text).not.toContain("Kritva");
  });

  it("keeps the model's own greeting with the configured public name", async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate(), { publicPrincipalName: "Asha" });
    const line = "Hello, Asha's assistant Kritva here. What can I help you with?";
    expect((await say("Hi", { intent: "greeting" }, { composed: line })).reply!.text).toBe(line);
    const request = llm.seen.find((step) => step.purpose === "compose_reply")!;
    expect(JSON.parse(request.messages[0]!.content)).toMatchObject({ who_you_represent: "Asha", introduce: true });
    expect(request.system).not.toMatch(/AI assistant/i);
  });

  it("supplies listing terms to review and preserves the known availability if wording is blocked", async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate(), { available: true });
    const availability = { intent: "question", asks_if_open: true };
    await say("Is the bed still available?", availability, { composed: "Yes, the bed is still available. Pickup is in Koramangala, Bangalore." });
    const review = llm.seen.findLast((step) => step.purpose === "language_check")!;
    const facts = JSON.parse(review.messages[0]!.content).permitted_facts;
    expect(facts).toEqual(expect.arrayContaining([expect.stringMatching(/Koramangala, Bangalore/), expect.stringMatching(/still available/)]));
    llm.reviews.push([{ type: "invented_fact", quote: "A mattress is included." }]);
    const checked = await say("Is the listed item still up for grabs?", availability, { composed: "Yes, it's available. A mattress is included." });
    expect(checked.reply!.text).toBe("Yes, it's still available.");
  });

  it("a composed reply never carries an em or en dash", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    await say("Hi.", { intent: "greeting" });
    const t = await say("₹15,000.", offer(15_000), { composed: "Thanks for the ₹15,000 — I could do ₹18,000 – would that work?" });
    expect(t.reply!.text).not.toMatch(/[\u2014\u2013]/);
    expect(t.reply!.text).toBe("Thanks for the ₹15,000, I could do ₹18,000, would that work?");
  });

  it("internal vocabulary in a composed reply is blocked and replaced by checked wording", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    await say("Hi.", { intent: "greeting" });
    const t = await say("₹15,000.", offer(15_000), { composed: "Per my mandate I could do ₹19,000." });
    expect(t.reply!.text).not.toMatch(/mandate/i);
    const blocked = (await events()).find((e) => e.type === "reply_blocked")!.payload as PayloadOf<"reply_blocked">;
    expect(blocked.violations.some((v) => v.rule === "internal_term")).toBe(true);
  });

  it("the opening greeting invites the counterparty to speak and is recorded once", async () => {
    const { engine, sessionId, events } = await setup(listingOnlyDeliveryMandate());
    const g = await engine.greet({ sessionId, channel: "voice" });
    expect(g.ok && g.reply!.text).toMatch(/^Hi, I'm Kritva, the seller's assistant\. What would you like to discuss\?/);
    const again = await engine.greet({ sessionId, channel: "voice" });
    expect(again.ok && again.reply).toBeNull();
    const all = await events();
    expect(all.filter((e) => e.type === "message")).toHaveLength(1);
    expect(all.some((e) => e.type === "offer_proposed")).toBe(false);
    expect(JSON.stringify(all.filter((e) => e.visibility === "public"))).not.toContain("18,000");
  });

  it("quoting the buyer's own figure back in a question passes the check", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    await say("Hi.", { intent: "greeting" });
    const t = await say("Pickup will cost me ₹2,000.", { intent: "other" }, { composed: "That makes sense. With the ₹2,000 for pickup, what total budget are you working with?" });
    expect(t.reply!.text).toContain("₹2,000");
    expect((await events()).some((e) => e.type === "reply_blocked")).toBe(false);
  });

  it("after a pause notice, the first real reply still introduces Kritva once", async () => {
    const { say, engine, sessionId } = await setup(listingOnlyDeliveryMandate());
    await engine.setPaused({ sessionId, paused: true });
    const paused = await say("₹15,000.", offer(15_000));
    expect(paused.reply!.text).not.toMatch(/Kritva/);
    await engine.setPaused({ sessionId, paused: false });
    const real = await say("₹15,000.", offer(15_000));
    expect(real.reply!.text).toMatch(/^Hi, I'm Kritva/);
  });

  it("a composed reply that opens like the previous one is replaced by varied checked wording", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    await say("Hi.", { intent: "greeting" }, { composed: "Hi, I'm Kritva, the seller's assistant. Happy to help." });
    const first = await say("Is it in good condition?", { intent: "question", questions: ["Is it in good condition?"] }, { composed: "Happy to help with that. I don't have that detail confirmed." });
    const second = await say("And the size?", { intent: "question", questions: ["And the size?"] }, { composed: "Happy to help with that too. I don't have that detail confirmed." });
    expect(first.reply!.text.split(" ").slice(0, 3)).not.toEqual(second.reply!.text.split(" ").slice(0, 3));
  });

  it("a qualifier like \"including pickup costs\" is not turned into a \"when will you know\" question", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    await say("₹17,000 because of pickup.", { ...offer(17_000), notes: [{ kind: "constraint", quote: "because of pickup", summary: "Pickup cost matters.", term_id: null, value: null, condition: "including pickup costs", basis: "stated" }] });
    const kinds = (await events()).filter((e) => e.type === "question_prepared").map((e) => (e.payload as PayloadOf<"question_prepared">).issueKind);
    expect(kinds).not.toContain("conditional");
  });
});



describe("Current-turn negotiation regressions", () => {
  const budgetNote = (quote: string, condition: string | null, amount: number) => ({
    kind: "budget", quote, summary: "Stated budget.", term_id: "term_price",
    value: v("money", { amount }), condition, basis: "stated",
  });

  it("passes the same saved message to interpretation, composition and review", async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate());
    const earlier = "Is it still available?";
    await say(earlier, { intent: "question", questions: [earlier] }, { composed: "Hi, I'm Kritva, the seller's assistant. It's a king-size bed." });
    const current = "TBH, I want it, but it seems too expensive.";
    const question = "Is it your budget or what you'd get for the price that's holding you back?";
    const reply = await say(current, { intent: "reject" }, { composed: { text: "I hear you on the price.", question } });
    expect(reply.reply?.text).toBe("I hear you on the price. " + question);
    const input = (purpose: string) => JSON.parse(llm.seen.findLast((request) => request.purpose === purpose)!.messages[0]!.content);
    expect(input("interpret_counterparty").counterparty_message).toBe(current);
    expect(input("compose_reply").their_message).toBe(current);
    expect(input("language_check").their_message).toBe(current);
    expect(input("language_check").public_amounts).toEqual(["₹20,000"]);
    expect(reply.events.find((event) => event.type === "question_asked")?.payload).toMatchObject({ text: question });
  });

  it.each([true, false])("addresses the current price turn with composition=%s", async (compose) => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    const opening = await say("Is it still available?", { intent: "question", questions: ["Is it still available?"] });
    expect(opening.reply?.text).toContain("still open for discussion");
    const objection = await say("I want it, but it's too expensive.", { intent: "reject" }, {
      composed: compose ? { text: "The price sounds like the sticking point.", question: "Does it exceed your budget, or do the terms need to offer more value?" } : null,
    });
    expect(objection.reply?.text).toMatch(/price.*budget/i);
    expect(objection.reply?.text).not.toMatch(/available|20,000/i);
    expect(objection.reply?.offerIds).toEqual([]);
    const result = await say("Do you really think that's a good enough price?", { intent: "question", questions: ["Is that a good enough price?"] }, {
      composed: compose ? "The asking amount is ₹20,000 for a king-size bed that's one year old. I don't have a market comparison." : null,
    });
    expect(result.reply?.text).toMatch(/₹20,000/);
    expect(result.reply?.text).toMatch(/king-size/);
    expect(result.reply?.text).toMatch(/one year old/);
    expect(result.reply?.text).not.toMatch(/that detail confirmed|\?/);
    expect(result.reply?.offerIds).toEqual([]);
    expect((await events()).filter((event) => event.type === "question_asked")).toHaveLength(1);
  });

  it("keeps a bare ceiling out of offer history, including across pause and resume", async () => {
    const { say, engine, sessionId, events, commitments } = await setup(listingOnlyDeliveryMandate());
    const text = "My budget is not more than 17500";
    const wrongRead = offer(17_500, { intent: "question", offer_kind: "enquiry", notes: [budgetNote(text, "including the purchase price", 17_500)] });
    expect((await engine.setPaused({ sessionId, paused: true })).ok).toBe(true);
    expect((await say(text, wrongRead)).reply?.text).toMatch(/paused/);
    expect((await engine.setPaused({ sessionId, paused: false })).ok).toBe(true);
    const reply = await say(text, wrongRead);
    expect(reply.reply?.text).toMatch(/budget.*₹17,500/i);
    expect(reply.reply?.text).not.toMatch(/after|\?/);
    expect(reply.state.counterpartyAmounts).toEqual([]);
    expect((await commitments()).currentCounterpartyOffer).toBeNull();
    const log = await events();
    expect(log.filter((event) => event.type === "question_prepared" || event.type === "offer_extracted")).toHaveLength(0);
    for (const event of log.filter((event) => event.type === "counterparty_noted")) {
      expect((event.payload as PayloadOf<"counterparty_noted">).items[0]).toMatchObject({ kind: "budget", condition: null });
    }
  });

  it("asks about a distinct quoted cost once and never subtracts the agreed term from itself", async () => {
    const { say, engine, sessionId, events } = await setup(listingOnlyDeliveryMandate());
    const text = "My budget is ₹19,000 including the purchase price and transport.";
    const interpretation = { notes: [budgetNote(text, "including the purchase price and transport", 19_000)] };
    const first = await say(text, interpretation);
    expect(first.reply?.text).toContain("after transport?");
    expect(first.reply?.text).not.toContain("after the purchase price");
    await engine.setPaused({ sessionId, paused: true });
    await engine.setPaused({ sessionId, paused: false });
    expect((await say(text, interpretation)).reply?.text).not.toMatch(/\?/);
    expect((await events()).filter((event) => event.type === "question_prepared")).toHaveLength(1);
  });

  it("answers an enquiry without a price move and preserves a distinct offer made alongside a ceiling", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    const budget = "My budget is not more than 17500";
    await say(budget, {});
    const enquiry = await say("Would you take ₹19,000?", offer(19_000, { notes: [budgetNote(budget, null, 17_500)] }));
    expect(enquiry.reply?.offerIds).toEqual([]);
    expect(enquiry.state.counterpartyAmounts).toEqual([]);
    // The budget earned one step toward it (half the room to the limit), so ₹19,000 is now the current ask.
    expect(enquiry.reply?.text).toContain("₹19,000");
    expect(enquiry.reply?.text).not.toContain("₹17,500");
    const proposed = await say("My budget is ₹19,000, but I can offer ₹18,500.", offer(18_500));
    expect(proposed.state.counterpartyAmounts).toEqual([18_500]);
    expect((await events()).filter((event) => event.type === "offer_extracted").map((event) => event.payload)).toMatchObject([{ kind: "enquiry" }, { kind: "offer", previousOfferId: null }]);
  });

  it("keeps a checked public asking price when the reviewer flags it as disclosure", async () => {
    const { say, llm, events } = await setup(listingOnlyDeliveryMandate());
    const line = "I'd like to stay at ₹20,000.";
    llm.reviews.push([{ type: "private_disclosure", quote: line }]);
    const reply = await say("That's more than I had in mind.", { intent: "reject" }, { composed: line });
    expect(reply.reply?.text).toContain(line);
    expect((await events()).filter((event) => event.type === "reply_blocked")).toHaveLength(0);
  });

  it("rejects an obsolete answer and delivers a question about the current objection", async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate());
    await say("Is it still available?", { intent: "question", questions: ["Is it still available?"] });
    llm.reviews.push([{ type: "turn_mismatch", quote: "Yes, it's still available." }]);
    const result = await say("This seems too expensive.", { intent: "reject" }, {
      composed: "Yes, it's still available. Is the issue your budget or what's included?",
    });
    expect(result.reply?.text).toMatch(/concern.*price.*budget/i);
    expect(result.reply?.text).not.toMatch(/still available/);
    // Not answering the turn is a conversation-quality note: the writer is asked for a rewrite, nothing is recorded as blocked.
    expect(result.events.some((event) => event.type === "reply_blocked")).toBe(false);
  });
});

describe("Reviewer accuracy and repeated invitations", () => {
  const blocked = async (events: () => Promise<Array<{ type: string }>>) => (await events()).filter((event) => event.type === "reply_blocked");

  it("keeps a plain introduction the reviewer misreads as a counterparty claim", async () => {
    const { say, llm, events } = await setup(listingOnlyDeliveryMandate(), { publicPrincipalName: "Asha" });
    llm.reviews.push([{ type: "counterparty_claim_as_fact", quote: "Hi, I'm Kritva, assisting Asha." }]);
    const reply = await say("hi", {}, { composed: "Hi, I'm Kritva, assisting Asha. How can I help?" });
    expect(reply.reply?.text).toBe("Hi, I'm Kritva, assisting Asha. How can I help?");
    expect(await blocked(events)).toHaveLength(0);
    const input = JSON.parse(llm.seen.findLast((request) => request.purpose === "language_check")!.messages[0]!.content);
    expect(input.permitted_facts).toContain("Kritva is the assistant of Asha.");
  });

  it("still blocks an introduction that carries an invented detail", async () => {
    const { say, llm, events } = await setup(listingOnlyDeliveryMandate(), { publicPrincipalName: "Asha" });
    const line = "Hi, I'm Kritva, assisting Asha, and delivery is free.";
    llm.reviews.push([{ type: "invented_fact", quote: line }]);
    const reply = await say("hi", {}, { composed: line });
    expect(reply.reply?.text).not.toContain("free");
    expect(await blocked(events)).toHaveLength(1);
  });

  it("keeps the public ask the reviewer misreads as a counterparty claim, but not a hint at a limit", async () => {
    const { say, llm, events } = await setup(listingOnlyDeliveryMandate());
    await say("hi", {});
    const question = "Is it the budget that feels tight, or does the amount seem high for what's included?";
    llm.reviews.push([{ type: "counterparty_claim_as_fact", quote: "₹20,000 is the current price." }]);
    const kept = await say("It's too much!", { price_concern: "objection" }, { composed: { text: "₹20,000 is the current price.", question } });
    expect(kept.reply?.text).toBe(`₹20,000 is the current price. ${question}`);
    expect(await blocked(events)).toHaveLength(0);

    const { say: say2, llm: llm2, events: events2 } = await setup(listingOnlyDeliveryMandate());
    await say2("hi", {});
    const hint = "₹20,000 is the current price, and that is close to as low as it goes.";
    llm2.reviews.push([{ type: "private_disclosure", quote: hint }]);
    const stopped = await say2("It's too much!", { price_concern: "objection" }, { composed: { text: hint, question } });
    expect(stopped.reply?.text).not.toContain("as low as");
    expect(await blocked(events2)).toHaveLength(1);
  });

  it("gives the reviewer every current public term and who handles fulfillment", async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate(), { fulfillment: FULFILLMENT });
    await say("Is it still available?", { intent: "question", questions: ["Is it still available?"] }, { composed: "Hi, I'm Kritva, the seller's assistant. Yes, and you'd collect it yourself." });
    const input = JSON.parse(llm.seen.findLast((request) => request.purpose === "language_check")!.messages[0]!.content);
    expect(input.permitted_facts.some((fact: string) => /^Current public price: ₹20,000/.test(fact))).toBe(true);
    expect(input.permitted_facts.some((fact: string) => /^The buyer handles: collect, pick up, at Koramangala, Bangalore\. The represented side does not deliver\.$/.test(fact))).toBe(true);
  });

  it("uses a single closing question in the text even when the separate field words it differently", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    await say("hi", {});
    const text = "My total budget is ₹19,000 including transport. I don't know what a truck will cost yet.";
    const embedded = "Noted, your total budget is ₹19,000 including transport, so what amount is left for the bed after transport?";
    const reply = await say(text, { notes: [{ kind: "budget", quote: text.split(".")[0]! + ".", summary: "Stated budget.", term_id: "term_price", value: v("money", { amount: 19_000 }), condition: "including transport", basis: "stated" }] }, {
      composed: { text: embedded, question: "What can you pay for the bed itself?" },
    });
    expect(reply.reply?.text).toBe(embedded);
    expect(await blocked(events)).toHaveLength(0);
    expect(reply.events.find((event) => event.type === "question_asked")?.payload).toMatchObject({ text: embedded });
  });

  it("drops a duplicate firm-offer invitation and does not repeat it on the next turns", async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate());
    await say("It’s too much for me.", { price_concern: "objection" });
    // The first statement of the budget earns one step (₹19,000); saying it again earns none and gets the firm-offer probe.
    await say("Budget is the problem. I can’t spend more than ₹18,000.", {});
    const question = "Would you like to make a firm offer on the current package?";
    const budget = await say("Like I said, I can’t spend more than ₹18,000.", {}, {
      composed: { text: "Noted, you've said your ceiling is ₹18,000. If you'd like, you can send a firm offer on the current package.", question },
    });
    expect(budget.reply?.text).toBe(`Noted, you've said your ceiling is ₹18,000. ${question}`);
    for (const quote of ["What’s the best you could do?", "Can you go any lower than that?"]) {
      const turn = await say(quote, { intent: "question", price_concern: "objection", public_term_questions: [{ term_id: "term_price", basis: "current", quote }] });
      expect(findAmounts(turn.reply!.text).every((amount) => amount === 19_000)).toBe(true);
      expect(turn.reply?.text).not.toMatch(/firm offer|make an offer/i);
      expect(JSON.parse(llm.seen.findLast((request) => request.purpose === "compose_reply")!.messages[0]!.content).offer_invited_recently).toBe(true);
    }
  });
});

describe("Final positions, repeated invitations and clarifying questions", () => {
  it('"₹17,500 is really the most I can do" after a counter is a final offer at ₹17,500, not a budget note', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    await say("₹17,000.", offer(17_000));
    const text = "₹17,500 is really the most I can do.";
    const turn = await say(text, { intent: "other", offer_kind: "budget_ceiling", notes: [{ kind: "budget", quote: text, summary: "Stated budget.", term_id: "term_price", value: v("money", { amount: 17_500 }), condition: null, basis: "stated" }] });
    expect(turn.events.find((e) => e.type === "offer_extracted")?.payload).toMatchObject({ kind: "offer", terms: [{ termId: "term_price", value: { amount: 17_500 } }] });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ interpretation: { offerKind: "offer", pressure: "final_offer" } });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).not.toMatchObject({ kind: "acknowledge_budget" });
  });

  it('"My budget is just ₹18,000" stays a budget ceiling: never an offer, answered with one step toward it', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const turn = await say("My budget is just ₹18,000", {});
    expect(turn.events.some((e) => e.type === "offer_extracted")).toBe(false);
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ kind: "counter", interpretation: { offerKind: "budget_ceiling" } });
  });

  it("after a recent invitation, the brief tells the writer not to repeat it, and an exactly repeated sentence goes back for a rewrite", async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate());
    await say("It’s too much for me.", { price_concern: "objection" });
    await say("Budget is the problem. I can’t spend more than ₹18,000.", {});
    const first = await say("Like I said, I can’t spend more than ₹18,000.", {});
    const quote = "Can you go any lower than that?";
    const repeat = first.reply!.text.split(/(?<=[.!?])\s+/).find((x) => x.split(" ").length >= 4)!;
    const fresh = "I hear you. ₹19,000 is where it stands for now, and I'm glad to look at any number you put forward.";
    const turn = await say(quote, { intent: "question", price_concern: "objection", public_term_questions: [{ term_id: "term_price", basis: "current", quote }] }, { composed: [`Got it, thanks. ${repeat}`, fresh] });
    const briefs = llm.seen.filter((c) => c.purpose === "compose_reply").map((c) => JSON.parse(c.messages[0]!.content));
    expect(briefs.at(-2)).toMatchObject({ offer_invited_recently: true, must: expect.arrayContaining([expect.stringMatching(/do not invite one again/)]) });
    expect(briefs.at(-1).revise.problems.join(" ")).toMatch(/You already said/);
    expect(turn.reply?.text).toBe(fresh);
  });

  it("a reply may ask for a detail the offer depends on, even on an enquiry", async () => {
    const { say, events } = await setup(conditionalMandate());
    await say("hi", {});
    const turn = await say("Would you take ₹18,000 for it?", offer(18_000), { composed: "You asked about ₹18,000, and the current asking amount is ₹20,000. Which collection day did you have in mind?" });
    expect(turn.reply?.text).toBe("You asked about ₹18,000, and the current asking amount is ₹20,000. Which collection day did you have in mind?");
    expect((await events()).filter((e) => e.type === "reply_blocked")).toHaveLength(0);
  });
});

describe("Bare proposals", () => {
  it.each(["₹17,000 then?", "How about ₹17,000?", "Okay, 17000."])('"%s" is a proposal at ₹17,000, not an enquiry', async (text) => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const turn = await say(text, { intent: "question", offer_kind: "enquiry", offer_terms: [price(17_000)] });
    expect(turn.events.find((e) => e.type === "offer_extracted")?.payload).toMatchObject({ kind: "offer", terms: [{ termId: "term_price", value: { amount: 17_000 } }] });
  });

  it('"Would you take ₹17,000?" stays an enquiry: no price move, but a nudge for a firm offer', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    const turn = await say("Would you take ₹17,000?", { intent: "question", offer_kind: "enquiry", offer_terms: [price(17_000)] });
    expect(turn.reply?.offerIds).toEqual([]);
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ kind: "answer_enquiry", action: "ask" });
    expect((await events()).some((e) => e.type === "question_prepared" && /firm offer/i.test((e.payload as { text: string }).text))).toBe(true);
  });
});

describe("Enquiries that name their amount", () => {
  it('"Would you take ₹18,000 for it?" is an enquiry about ₹18,000 even when the model drops the amount, and asks for the missing day', async () => {
    const { say } = await setup(conditionalMandate());
    const turn = await say("Would you take ₹18,000 for it?", { intent: "question", offer_kind: "enquiry", pressure: "lowest_price" });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ kind: "answer_enquiry" });
    expect(turn.reply?.text).toMatch(/collection day/i);
    expect(turn.reply?.offerIds).toEqual([]);
  });
});

describe("One rewrite before the checked fallback", () => {
  const bad = "Sure. It's a great bed and other buyers are interested.";
  const good = "It's a king-size bed, one year old and in good condition.";
  const frames = (llm: { seen: Array<{ purpose: string; messages: Array<{ content: string }> }> }) =>
    llm.seen.filter((c) => c.purpose === "compose_reply").map((c) => JSON.parse(c.messages[0]!.content));

  it("a blocked draft goes back once with the reason, and a rewrite that passes is delivered", async () => {
    const { say, llm, events } = await setup(listingOnlyDeliveryMandate());
    await say("Hi", { intent: "greeting" });
    llm.reviews.push([{ type: "invented_competition", quote: "other buyers are interested" }], []);
    const turn = await say("What are you selling?", { intent: "question", questions: ["What are you selling?"] }, { composed: [bad, good] });
    expect(turn.reply!.text).toBe(good);
    expect(frames(llm).at(-2).revise).toBeNull();
    expect(frames(llm).at(-1).revise).toMatchObject({ rejected_draft: bad, problems: [expect.stringMatching(/compet/i)] });
    expect((await events()).filter((e) => e.type === "reply_blocked")).toHaveLength(1);
  });

  it("when the rewrite is blocked too, the checked fallback answers and both blocks are recorded", async () => {
    const { say, llm, events } = await setup(listingOnlyDeliveryMandate());
    await say("Hi", { intent: "greeting" });
    llm.reviews.push([{ type: "invented_competition", quote: "other buyers are interested" }], [{ type: "invented_competition", quote: "other buyers are interested" }]);
    const turn = await say("What are you selling?", { intent: "question", questions: ["What are you selling?"] }, { composed: [bad, bad] });
    expect(turn.reply!.text).not.toContain("other buyers");
    expect(turn.reply!.text).toMatch(/king-size/i);
    expect(frames(llm).filter((f) => f.their_message === "What are you selling?")).toHaveLength(2);
    expect((await events()).filter((e) => e.type === "reply_blocked")).toHaveLength(2);
  });

  it("the checked fallback is said in Kritva's voice when that passes every check, and fixed wording is the last resort", async () => {
    const warm = "Ah, it's a king-size bed, a year old and in good condition. Anything else you'd like to know?";
    const reviewed = async (reword: string) => {
      const { say, llm, events } = await setup(listingOnlyDeliveryMandate());
      await say("Hi", { intent: "greeting" });
      llm.reviews.push([{ type: "invented_competition", quote: "other buyers are interested" }], [{ type: "invented_competition", quote: "other buyers are interested" }], []);
      const turn = await say("What are you selling?", { intent: "question", questions: ["What are you selling?"] }, { composed: [bad, bad, reword] });
      const rewordCall = llm.seen.findLast((c) => c.purpose === "reword_checked_reply");
      return { text: turn.reply!.text, rewordCall, blocked: (await events()).filter((e) => e.type === "reply_blocked").length };
    };
    const used = await reviewed(warm);
    expect(used.text).toBe(warm);
    expect(JSON.parse(used.rewordCall!.messages[0]!.content).checked_reply).toMatch(/king-size/i);
    // A reword that adds an amount the checked wording did not carry is never used.
    const added = await reviewed("Ah, it's a king-size bed for ₹12,000. Anything else?");
    expect(added.text).not.toContain("12,000");
    expect(added.text).toMatch(/king-size/i);
  });

  it("the brief names the reply language from the script they wrote in, so an English chat never turns Hindi", async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate());
    await say("Hi", { intent: "greeting" });
    expect(frames(llm).at(-1).reply_language).toBe("English");
    await say("बेड का दाम क्या है?", { intent: "question", questions: ["बेड का दाम क्या है?"] });
    expect(frames(llm).at(-1).reply_language).toBe("Hindi");
    expect(frames(llm).at(-1).must.join(" ")).toMatch(/Reply in Hindi/);
  });

  it("a draft that exposed a private amount is never sent back to the model, only the reason", async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate());
    await say("Hi", { intent: "greeting" });
    await say("What's your lowest?", { intent: "question", asks_private_info: true, questions: ["What's your lowest?"] }, { composed: ["I can't go below ₹18,000.", null] });
    const last = frames(llm).at(-1);
    expect(last.revise).toMatchObject({ rejected_draft: null });
    expect(JSON.stringify(last)).not.toContain("18,000");
  });
});

describe("Reviewer accepts the planned offer", () => {
  it.each(["I can do ₹19,000.", "How about ₹19,000?", "I can do ₹19,000 for the bed."])('"%s" on a counter is delivered even when the reviewer calls it a mismatch', async (line) => {
    const { say, llm, events } = await setup(listingOnlyDeliveryMandate());
    await say("Hi", { intent: "greeting" });
    const first = await say("₹17,000.", offer(17_000), { composed: null });
    const amount = (first.reply!.text.match(/₹[\d,]+/) ?? [""])[0];
    const draft = line.replace("₹19,000", amount);
    llm.reviews.push([{ type: "action_mismatch", quote: draft }]);
    const turn = await say("₹17,200.", offer(17_200), { composed: draft });
    if (turn.events.some((e) => e.type === "decision" && (e.payload as { kind: string }).kind === "counter")) {
      expect(turn.reply!.text).toContain(draft.replace(amount, (turn.reply!.text.match(/₹[\d,]+/) ?? [""])[0]));
    }
    expect((await events()).filter((e) => e.type === "reply_blocked" && JSON.stringify(e.payload).includes("action mismatch"))).toHaveLength(0);
  });

  it("still blocks an offer sentence that adds a promise", async () => {
    const { say, llm, events } = await setup(listingOnlyDeliveryMandate());
    await say("Hi", { intent: "greeting" });
    const draft = "I can do ₹19,000 and deliver it free.";
    llm.reviews.push([{ type: "promise_outside_terms", quote: draft }], [{ type: "promise_outside_terms", quote: draft }]);
    await say("₹17,000.", offer(17_000), { composed: [draft, draft] });
    expect((await events()).filter((e) => e.type === "reply_blocked").length).toBeGreaterThan(0);
  });

  it('"Any chance you\'d take ₹18,500 if I collect it myself?" is an enquiry, not an offer', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const turn = await say("Any chance you’d take ₹18,500 if I collect it myself?", { intent: "offer", offer_kind: "offer", offer_terms: [price(18_500)] });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ kind: "answer_enquiry" });
    expect(turn.reply!.offerIds).toEqual([]);
  });
});

describe("Reading grounding for acceptances and own fulfillment", () => {
  it("an acceptance mislabelled as a value question stays an acceptance", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    await say("₹19,000.", offer(19_000));
    const turn = await say("Okay, I'll go with the price you just quoted.", { intent: "accept_stated_terms", accepts_stated_terms: true, price_concern: "value_question" });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).not.toMatchObject({ kind: "explain_price" });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ interpretation: { priceConcern: null } });
  });

  it('"I\'ll pay ₹19,500 and collect it myself" is an offer, not a need about the pickup location', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate(), { fulfillment: FULFILLMENT });
    const turn = await say("I’ll pay ₹19,500 and collect it myself.", { ...offer(19_500), notes: [{ kind: "need", quote: "collect it myself", summary: "They will pick it up.", term_id: "term_pickup", value: null, condition: null, basis: "stated" }] });
    expect(turn.events.some((e) => e.type === "question_prepared")).toBe(false);
    // Without an invented obstacle, the strategy evaluates the offer instead of asking about pickup.
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).not.toMatchObject({ action: "ask" });
  });

  it('"₹19,500 works." is never said outside an agreement confirmation', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    const turn = await say("Is it still available?", { intent: "question", asks_if_open: true }, { composed: ["Yes, and ₹20,000 works for the bed.", null] });
    expect(turn.reply!.text).not.toMatch(/20,000 works/);
    expect((await events()).some((e) => e.type === "reply_blocked" && JSON.stringify(e.payload).includes("false_commitment"))).toBe(true);
  });
});

describe("An alternative's price is not their offer", () => {
  it('"I found a similar one for ₹16,000. Can you do better?" compares packages instead of answering an enquiry about ₹16,000', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const text = "I found a similar one for ₹16,000. Can you do better?";
    const turn = await say(text, {
      intent: "question", offer_kind: "enquiry", offer_terms: [price(16_000)], pressure: "cheaper_elsewhere",
      notes: [{ kind: "alternative", quote: "I found a similar one for ₹16,000", summary: "Cites a cheaper similar item.", term_id: "term_price", value: v("money", { amount: 16_000 }), condition: null, basis: "stated" }],
    });
    expect(turn.events.some((e) => e.type === "offer_extracted")).toBe(false);
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).not.toMatchObject({ kind: "answer_enquiry" });
    expect(turn.reply!.offerIds).toEqual([]);
  });
});

describe("Questions and read-backs", () => {
  it('"For how much?" is never an acceptance of the stated terms', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const turn = await say("For how much?", { intent: "accept_stated_terms", accepts_stated_terms: true, public_term_questions: [{ term_id: "term_price", basis: "current", quote: "For how much?" }] });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).not.toMatchObject({ kind: "state_final_terms" });
    expect(turn.reply!.offerIds).toEqual([]);
  });

  it("text after the inserted terms starts a new sentence", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    await say("₹19,000.", offer(19_000));
    const turn = await say("Yes, I confirm.", { intent: "accept_stated_terms", accepts_stated_terms: true }, { composed: "Thanks. [[TERMS]] Payment and handover still need to be arranged. Could you confirm the complete package?" });
    if (turn.reply!.text.includes("Payment and handover")) expect(turn.reply!.text).toMatch(/included\. Payment and handover/);
  });

  it("inside a sentence the inserted terms are not capitalised, and a comma continues the sentence", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    await say("₹19,000.", offer(19_000));
    const turn = await say("Yes, I confirm.", { intent: "accept_stated_terms", accepts_stated_terms: true }, { composed: "Thanks. The full package would be [[TERMS]], so could you confirm the complete package?" });
    if (turn.reply!.text.startsWith("Thanks. The full package")) expect(turn.reply!.text).toMatch(/would be ₹19,000.*included, so could you confirm/);
  });
});

describe("A question proposes nothing", () => {
  it.each(["for how much?", "What terms?"])('"%s" with the asking price read into the offer is still a question, not an offer at the ask', async (text) => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const turn = await say(text, { intent: "question", offer_kind: "offer", offer_terms: [price(20_000)], public_term_questions: [{ term_id: "term_price", basis: "current", quote: text }] });
    expect(turn.events.some((e) => e.type === "offer_extracted")).toBe(false);
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).not.toMatchObject({ kind: "state_final_terms" });
  });
});

describe("Acknowledging their number", () => {
  it('"Thanks for the ₹15,000 offer. I can do ₹19,000." passes; "I can do ₹15,000" below the limit does not', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    const first = await say("₹15,000.", offer(15_000));
    const counter = (first.reply!.text.match(/₹[\d,]+/g) ?? []).find((a) => a !== "₹15,000") ?? "";
    const { say: say2, events: events2 } = await setup(listingOnlyDeliveryMandate());
    const ok = await say2("₹15,000.", offer(15_000), { composed: [`Thanks for the ₹15,000 offer. I can do ${counter}.`, null] });
    expect(ok.reply!.text).toContain(`Thanks for the ₹15,000 offer. I can do ${counter}.`);
    expect((await events2()).some((e) => e.type === "reply_blocked")).toBe(false);
    const { say: say3, events: events3 } = await setup(listingOnlyDeliveryMandate());
    await say3("₹15,000.", offer(15_000), { composed: ["Thanks, I can do ₹15,000 if you collect it.", null] });
    expect((await events3()).some((e) => e.type === "reply_blocked" && JSON.stringify(e.payload).includes("crosses_limit"))).toBe(true);
    void events;
  });
});

describe("Reasons already given and offers explained", () => {
  it('"That\'s still out of my budget" gives the reason: no question about where the objection comes from', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    const turn = await say("That's still out of my budget.", { intent: "reject", price_concern: "objection", notes: [{ kind: "budget", quote: "That's still out of my budget.", summary: "Above their budget.", term_id: null, value: null, condition: null, basis: "stated" }] });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ kind: "explore_objection", action: "answer" });
    expect((await events()).some((e) => e.type === "question_prepared" && /budget, or/i.test(JSON.stringify(e.payload)))).toBe(false);
  });

  it('"What 19000?" after a counter: the brief says the value is our current offer, down from the original', async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate());
    const first = await say("₹15,000.", offer(15_000));
    const counter = (first.reply!.text.match(/₹[\d,]+/g) ?? []).find((a) => a !== "₹15,000")!;
    const quote = `What ${counter.replace(/[₹,]/g, "")}?`;
    await say(quote, { intent: "question", public_term_questions: [{ term_id: "term_price", basis: "current", quote }] });
    const brief = JSON.parse(llm.seen.findLast((c) => c.purpose === "compose_reply")!.messages[0]!.content);
    expect(brief.must.join(" ")).toContain(`${counter} is your current offer to them, down from the original ₹20,000`);
  });
});

describe("The objection alone still gets a question", () => {
  it('"It\'s too much!" noted as a reason still asks what the concern is', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const turn = await say("It's too much!", { intent: "reject", price_concern: "objection", notes: [{ kind: "reason", quote: "It's too much!", summary: "Price too high.", term_id: null, value: null, condition: null, basis: "stated" }] });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ kind: "explore_objection", action: "ask" });
  });

  it('"I\'ll pay ₹19,500 and collect it myself" with "collect it myself" read as a condition is still an unconditional offer', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate(), { fulfillment: FULFILLMENT });
    const turn = await say("I’ll pay ₹19,500 and collect it myself.", { ...offer(19_500), offer_conditions: ["collect it myself"] });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).not.toMatchObject({ action: "clarify" });
  });
});

describe("Repeated read-back question", () => {
  it("a second read-back that repeats the earlier confirmation question word for word goes back for a rewrite", async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate());
    await say("₹19,000.", offer(19_000), { composed: "Thanks. [[TERMS]]. Could you confirm the full package?" });
    await say("Actually, ₹19,200.", offer(19_200), { composed: ["Noted. [[TERMS]] Could you confirm the full package?", "Got it. [[TERMS]]. Does that complete package work for you to confirm?"] });
    const briefs = llm.seen.filter((c) => c.purpose === "compose_reply").map((c) => JSON.parse(c.messages[0]!.content));
    expect(briefs.at(-1).revise?.problems?.join(" ") ?? "").toMatch(/You already said/);
  });
});

describe("A budget below the price keeps the negotiation moving (reported chat, 2026-11-22)", () => {
  // Floor ₹18,000, asking ₹20,000: the buyer says the most they can pay is ₹17,500.
  const budgetNote = (amount: number, quote: string) => ({ intent: "offer", offer_kind: "budget_ceiling", price_concern: "objection", notes: [{ kind: "budget", quote, summary: "Stated budget.", term_id: "term_price", value: v("money", { amount }), condition: null, basis: "stated" }] });

  it("a stated budget below the floor gets one step toward it, never below the floor, and a nudge to meet it, not just 'noted'", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate(18_000));
    const turn = await say("Boy I can't pay 20k. Max I can pay is 17500.", budgetNote(17_500, "Max I can pay is 17500."));
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ kind: "counter", action: "counter" });
    const proposed = (await events()).filter((e) => e.type === "offer_proposed").map((e) => priceOf((e.payload as { terms: OfferTerm[] }).terms));
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toBeLessThan(20_000);
    expect(proposed[0]).toBeGreaterThanOrEqual(18_000);
    expect((await events()).some((e) => e.type === "question_prepared" && /come up/i.test((e.payload as { text: string }).text))).toBe(true);
  });

  it('"Can you sell at that price?" asks about their own earlier ₹17,500: an enquiry, never accepted, and no second step for the same number', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate(18_000));
    await say("Boy I can't pay 20k. Max I can pay is 17500.", budgetNote(17_500, "Max I can pay is 17500."));
    const turn = await say("Can you sell at that price?", { intent: "question" });
    expect(turn.events.find((e) => e.type === "offer_extracted")?.payload).toMatchObject({ kind: "enquiry", terms: [{ termId: "term_price", value: { amount: 17_500 } }] });
    // The checked wording attributes their figure, so it passes and the turn is never silent.
    expect(turn.reply?.text).toMatch(/You asked about ₹17,500/);
    expect(turn.reply?.text).toContain("₹19,000");
    expect((await events()).filter((e) => e.type === "offer_proposed")).toHaveLength(1);
    expect((await events()).some((e) => e.type === "acceptance_recorded")).toBe(false);
  });

  it("pressure after a budget below the floor holds the price and asks, once, how close they can come", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate(18_000));
    await say("Boy I can't pay 20k. Max I can pay is 17500.", budgetNote(17_500, "Max I can pay is 17500."));
    const better = await say("Oh come on. Give me a better rate please.", { intent: "request_change", pressure: "lowest_price", price_concern: "objection" });
    expect(better.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ kind: "hold", action: "ask" });
    const final = await say("Is that your final rate?", { intent: "question", pressure: "final_offer" });
    expect(final.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ kind: "hold" });
    expect(final.reply?.offerIds).toEqual([]);
  });

  it('"for how much?" still proposes nothing: only the counterparty\'s own earlier amount can be referred back to', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate(18_000));
    const turn = await say("Can you sell it for that price?", { intent: "question", offer_kind: "offer", offer_terms: [price(20_000)] });
    expect(turn.events.some((e) => e.type === "offer_extracted")).toBe(false);
  });

  it('"Yes please" to an offer of details, before any amount was stated, is not accepting the terms', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate(18_000));
    await say("Hi! I saw your advertisement.", { intent: "greeting" }, { composed: "Hi, I'm Kritva, the seller's assistant. I can share the details if you'd like." });
    const turn = await say("Yes please.", { intent: "other", accepts_stated_terms: true });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).not.toMatchObject({ kind: "state_final_terms" });
    expect((await events()).some((e) => e.type === "offer_proposed")).toBe(false);
  });

  it('"What price works for you?" is price pressure, not a request for private limits', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate(18_000));
    const turn = await say("What price works for you?", { intent: "question", asks_private_info: true });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ interpretation: { pressure: "lowest_price", asksPrivateInfo: false } });
  });

  it('"Yes, I confirm ₹19,500" after a ₹19,800 counter puts ₹19,500 forward; it is not accepting ₹19,800', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate(18_000));
    await say("₹18,500 then.", offer(18_500));
    const stated = priceOf(((await events()).findLast((e) => e.type === "offer_proposed")!.payload as { terms: OfferTerm[] }).terms);
    const mine = stated - 300;
    const turn = await say(`Okay fine, I'll pick it up. Yes, I confirm ₹${mine.toLocaleString("en-IN")}.`, { intent: "accept_stated_terms", accepts_stated_terms: true });
    expect(turn.events.find((e) => e.type === "offer_extracted")?.payload).toMatchObject({ kind: "offer", terms: [{ termId: "term_price", value: { amount: mine } }] });
    expect((await events()).some((e) => e.type === "acceptance_recorded")).toBe(false);
  });

  it("a greeting is never an objection, even with a reason note attached", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate(18_000));
    const turn = await say("Hi! I saw your advertisement.", { intent: "greeting", notes: [{ kind: "reason", quote: "I saw your advertisement.", summary: "Saw the ad.", term_id: null, value: null, condition: null, basis: "stated" }] });
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).not.toMatchObject({ kind: "hold" });
    expect((await events()).some((e) => e.type === "offer_proposed")).toBe(false);
  });

  it('"I confirm ₹X" names their own amount even when the reading calls it a terms question', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate(18_000));
    await say("₹18,500 then.", offer(18_500));
    const stated = priceOf(((await events()).findLast((e) => e.type === "offer_proposed")!.payload as { terms: OfferTerm[] }).terms);
    const mine = stated - 300;
    const text = `Okay fine. Yes, I confirm ₹${mine.toLocaleString("en-IN")}.`;
    const turn = await say(text, { intent: "question", public_term_questions: [{ term_id: "term_price", basis: "current", quote: text }] });
    expect(turn.events.find((e) => e.type === "offer_extracted")?.payload).toMatchObject({ terms: [{ termId: "term_price", value: { amount: mine } }] });
  });

  it('"Is that your final rate?" tells the writer never to answer yes or no, whichever move answers it', async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate(18_000));
    const text = "Is that your final rate?";
    await say(text, { intent: "question", pressure: "final_offer", public_term_questions: [{ term_id: "term_price", basis: "current", quote: text }] });
    const brief = JSON.parse(llm.seen.findLast((r) => r.purpose === "compose_reply")!.messages[0]!.content);
    expect(brief.must.join(" ")).toMatch(/Do not answer yes, no or anything like "not quite"/);
  });

  it("a turn cut off after its reading was recorded (a server restart) resumes on retry and sends a reply, without noting it twice", async () => {
    const { say, record, sessionId, state, events } = await setup(listingOnlyDeliveryMandate(18_000));
    const buyer = (await state()).view.counterpartyId;
    const text = "Max I can pay is 17500.";
    await record.append(sessionId, { id: "msg_cut1", type: "message", channel: "text", payload: { direction: "inbound", speakerPartyId: buyer, text, utteranceId: null, offerIds: [] } }, { kind: "counterparty", partyId: buyer });
    await record.append(sessionId, { id: "noted_cut1", type: "counterparty_noted", channel: null, payload: { sourceMessageId: "msg_cut1", failed: false, items: [{ kind: "budget", quote: text, summary: "Stated budget.", termId: "term_price", value: { type: "money", amount: 17_500, currency: "INR" }, condition: null, basis: "stated" }] } }, { kind: "agent", partyId: (await state()).view.principalId });
    const retried = await say(text, { notes: [{ kind: "budget", quote: text, summary: "Stated budget.", term_id: "term_price", value: v("money", { amount: 17_500 }), condition: null, basis: "stated" }] }, { messageId: "msg_cut1" });
    expect(retried.reply).not.toBeNull();
    expect((await events()).filter((e) => e.type === "counterparty_noted" && (e.payload as { sourceMessageId: string }).sourceMessageId === "msg_cut1")).toHaveLength(1);
    expect((await events()).filter((e) => e.type === "message" && (e.payload as { direction: string }).direction === "inbound")).toHaveLength(1);
  });

  it.each([
    ["I can do 18000 if I pick it up today.", "if I pick it up today", false],
    ["₹18,500 if we collect it this weekend.", "if we collect it this weekend", false],
    ["₹18,500 if I pay cash.", "if I pay cash", false],
    ["₹18,500 if I can arrange a truck.", "if I can arrange a truck", true],
    ["₹18,500 if my wife agrees.", "if my wife agrees", true],
    ["₹18,500 if I see it first.", "if I see it first", true],
  ])('"%s": a condition only when it is not simply their own commitment', async (text, condition, stays) => {
    const { say } = await setup(listingOnlyDeliveryMandate(18_000));
    const turn = await say(text, offer(18_500, { offer_conditions: [condition] }));
    const decision = turn.events.findLast((e) => e.type === "decision")?.payload as { interpretation?: unknown; action?: string };
    const extracted = turn.events.find((e) => e.type === "offer_extracted")?.payload as { conditions: string[] };
    expect(extracted.conditions.length > 0, String(decision?.action)).toBe(stays);
  });
});

describe("Code keeps limits; the conversation guide shapes the wording", () => {
  const briefOf = (llm: { seen: StructuredRequest[] }) => JSON.parse(llm.seen.findLast((r) => r.purpose === "compose_reply")!.messages[0]!.content);

  it("the brief gives the price and the other terms separately, and whether the last reply already said the price", async () => {
    const { say, llm } = await setup(listingOnlyDeliveryMandate(18_000));
    await say("₹17,000.", offer(17_000), { composed: "Thanks for the offer. I can do ₹18,500." });
    await say("Can you do better?", { intent: "request_change", pressure: "lowest_price" });
    const brief = briefOf(llm);
    expect(brief.price).toMatchObject({ original: "₹20,000", said_in_your_last_reply: true });
    expect(brief.other_terms.map((t: { term: string }) => t.term)).not.toContain("price");
    expect(brief).not.toHaveProperty("public_deal_terms");
    expect(brief.must.join(" ")).toMatch(/do not repeat the number/);
    expect(brief.must.join(" ")).not.toMatch(/Mention the current asking amount/);
  });

  it("restating the price already put to them is never blocked as an unplanned amount", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate(18_000));
    await say("₹17,000.", offer(17_000));
    const counter = priceOf(((await events()).findLast((e) => e.type === "offer_proposed")!.payload as { terms: OfferTerm[] }).terms);
    const line = `It's still at ₹${counter.toLocaleString("en-IN")} for now. Happy to look at a firm offer from you.`;
    const turn = await say("Hmm, okay. What does it include?", { intent: "question" }, { composed: line });
    expect(turn.reply?.text).toBe(line);
    expect((await events()).filter((e) => e.type === "reply_blocked")).toHaveLength(0);
  });

  it("a style problem asks for one rewrite; a rewrite that still has one is sent, never replaced by the checked fallback", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate(18_000));
    await say("Hi", { intent: "greeting" }, { composed: "Hi, I'm Kritva, the seller's assistant. What can I help you with today?" });
    const second = "Happy to help with that. It's a solid piece, kept with care. What can I help you with today?";
    const turn = await say("Tell me more.", { intent: "question" }, { composed: ["Sure. What can I help you with today?", second] });
    // Both drafts repeat an earlier sentence (style); the second is still sent as written.
    expect(turn.reply?.text).toBe(second);
    expect((await events()).filter((e) => e.type === "reply_blocked")).toHaveLength(0);
  });
});

describe("Buying or selling: the principal's side sets which way a better deal goes", () => {
  /** The principal pays: 20,000 is their opening offer; with `max`, the most they will pay. */
  const payingMandate = (max: number | null) => buildMandate({
    instructions: `You can negotiate the price${max === null ? "" : `, but don't pay more than ₹${max.toLocaleString("en-IN")}`}. Ask me before accepting any offer.`,
    build: (d) => {
      (d as { principalSide?: string }).principalSide = "pays";
      if (max !== null) d.limits.push({ id: "limit_max", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: `don't pay more than ₹${max.toLocaleString("en-IN")}` }], partyId: "seller", termId: "term_price", kind: "maximum", value: { type: "money", amount: max, currency: "INR" }, conditionIds: [] });
    },
  });

  it("a principal who pays never takes a higher price as meeting the offer, even with no limit set", async () => {
    const { say, events } = await setup(payingMandate(null));
    const turn = await say("I can let it go for ₹23,000.", offer(23_000));
    expect(turn.events.findLast((e) => e.type === "decision")?.payload).not.toMatchObject({ kind: "state_final_terms" });
    expect((await events()).filter((e) => e.type === "offer_proposed").map((e) => priceOf((e.payload as { terms: OfferTerm[] }).terms)).every((a) => a <= 20_000)).toBe(true);
  });

  it("with a maximum, a counter moves up toward their price and never past the maximum", async () => {
    const { say, events } = await setup(payingMandate(22_000));
    await say("It's ₹26,000.", offer(26_000));
    const counters = (await events()).filter((e) => e.type === "offer_proposed").map((e) => priceOf((e.payload as { terms: OfferTerm[] }).terms));
    expect(counters.length).toBeGreaterThan(0);
    for (const amount of counters) {
      expect(amount).toBeGreaterThanOrEqual(20_000);
      expect(amount).toBeLessThanOrEqual(22_000);
    }
  });

  it("the brief says which side the principal is on", async () => {
    const { say, llm } = await setup(payingMandate(22_000));
    await say("What's your offer?", { intent: "question" });
    const brief = JSON.parse(llm.seen.findLast((r) => r.purpose === "compose_reply")!.messages[0]!.content);
    expect(brief.principal_side).toBe("pays");
  });

  it("the checked fallback speaks of our offer, never an asking amount, when the principal pays", async () => {
    const { say } = await setup(payingMandate(22_000));
    const texts: string[] = [];
    await say("Hello.", { intent: "other" });
    for (const amount of [24_000, 23_000]) {
      const turn = await say(`Would you pay ₹${amount.toLocaleString("en-IN")}?`, offer(amount, { intent: "question", offer_kind: "enquiry" }), { composed: "Which price would you like to know?" });
      texts.push(turn.reply?.text ?? "");
    }
    expect(texts.join(" ")).toMatch(/(Our current offer is|Our offer is still) ₹20,000/);
    expect(texts.join(" ")).not.toMatch(/asking/i);
  });

  it("a limit that points the other way is a conflict to resolve before confirming", async () => {
    const { withPrincipalSide, principalSideOf, blockers } = await import("../../src/mandate/library.ts");
    const selling = listingOnlyDeliveryMandate(18_000);
    const draft = { ...selling, approval: { status: "unapproved" as const } };
    expect(principalSideOf(draft)).toBe("receives");
    const flipped = withPrincipalSide(draft as never, "pays");
    expect(flipped.principalSide).toBe("pays");
    expect(blockers(flipped).join(" ")).toMatch(/paying, or being paid/);
    expect(withPrincipalSide(draft as never, "receives").issues.some((i) => i.id === "issue_principal_side")).toBe(false);
  });
});
