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
  readonly composed: Array<string | null> = [];
  failInterpret = false;
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const reply = (json: unknown) => ({ json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 });
    if (request.purpose === "interpret_counterparty") {
      if (this.failInterpret) throw new Error("model unavailable");
      return reply({ intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, offer_kind: "none", offer_conditions: [], ends_negotiation: false, corrects_previous: false, pressure: "none", notes: [], answers: [], new_terms: [], questions: [], ...this.interpretations.shift() });
    }
    if (request.purpose === "language_check") return reply({ concerns: [] });
    const text = this.composed.shift() ?? null;
    if (text === null) throw new Error("template wording");
    return reply({ text });
  }
}

async function setup(mandate: ValidConfirmedMandate) {
  const { record } = openRecord();
  const started = await record.startSession({ mandate });
  if (!started.ok) throw new Error("start failed");
  const llm = new ScriptedLlm();
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", guidance: GUIDANCE });
  const sessionId = started.session.id;
  const say = async (text: string, interp: Interp, options: { composed?: string | null; deliver?: boolean; messageId?: string } = {}): Promise<TurnResult> => {
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

  it("a question about a mattress, with no mattress fact, gets no invented answer", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const t = await say("Is a mattress included?", { intent: "question", questions: ["Is a mattress included?"] });
    expect(t.reply!.text).toContain("I don't have information about that");
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
    expect(t.reply!.text).toBe("Understood. Thank you for your time.");
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
