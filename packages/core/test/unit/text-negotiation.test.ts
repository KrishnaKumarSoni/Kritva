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
import { parseGuidance } from "../../src/strategy/guidance.ts";
import { conditionalMandate, exceptionMandate, listingOnlyDeliveryMandate, noExceptionMandate } from "../support/mandates.ts";
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

async function setup(mandate: ValidConfirmedMandate, listingDetails?: { publicPrincipalName?: string; available?: boolean }) {
  const { record } = openRecord();
  const started = await record.startSession({ mandate });
  if (!started.ok) throw new Error("start failed");
  const llm = new ScriptedLlm();
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", guidance: GUIDANCE, listingDetails: listingDetails ? new Map([[mandate.caseId, listingDetails]]) : undefined });
  const sessionId = started.session.id;
  const say = async (text: string, interp: Interp, options: { composed?: string | { text: string; question: string } | null; deliver?: boolean; messageId?: string } = {}): Promise<TurnResult> => {
    llm.interpretations.push(interp);
    llm.composed.push(options.composed ?? null);
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

describe("Epic 9, Story 1: buyer messages go through the core", () => {
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
    expect(frames.at(-2)).toMatchObject({ their_message: "How much?", move: "answer_public_terms", public_term_answers: [{ value: "₹20,000", basis: "current" }] });
    expect(JSON.stringify(frames.at(-2))).not.toContain("18,000");
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
    expect(t.reply!.text).toContain("I don't have that detail confirmed");
    expect(t.reply!.text).not.toMatch(/mattress (is|comes) included|includes a mattress/i);
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
    const t = await say("₹15,000.", offer(15_000), { composed: "Thanks for that — I could do ₹18,000 – would that work?" });
    expect(t.reply!.text).not.toMatch(/[\u2014\u2013]/);
    expect(t.reply!.text).toBe("Thanks for that, I could do ₹18,000, would that work?");
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
    expect(enquiry.reply?.text).toContain("₹20,000");
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
    expect(result.events.some((event) => event.type === "reply_blocked")).toBe(true);
  });
});
