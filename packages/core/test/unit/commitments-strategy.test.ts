/** Epics 7 and 8: commitments, outcomes, package assessment and move selection. Test values only. */
import { describe, expect, it } from "vitest";
import { projectCommitments, noAgreementSummary } from "../../src/commitments/model.ts";
import { gateTerms } from "../../src/governance/gate.ts";
import type { StructuredLlm, StructuredRequest, StructuredResponse } from "../../src/llm/types.ts";
import type { ValidConfirmedMandate } from "../../src/mandate/confirm.ts";
import { NegotiationEngine, type TurnResult } from "../../src/negotiation/engine.ts";
import { formatValue } from "../../src/negotiation/mandate-view.ts";
import type { Plan } from "../../src/negotiation/policy.ts";
import { projectState } from "../../src/negotiation/state.ts";
import { hashTerms, newEventId, type OfferTerm, type PayloadOf, type RecordedEvent } from "../../src/index.ts";
import { assessPackage } from "../../src/strategy/assess.ts";
import { negotiationInsights } from "../../src/strategy/insights.ts";
import { projectAllowance } from "../../src/strategy/allowance.ts";
import { projectCounterparty } from "../../src/counterparty/model.ts";
import { MINIMAL_GUIDANCE, parseGuidance, type StrategyGuidance } from "../../src/strategy/guidance.ts";
import type { Value } from "../../src/schema/records.ts";
import { buildMandate, conditionalMandate, conflictingMinimumsMandate, exceptionMandate, listingOnlyDeliveryMandate, noExceptionMandate } from "../support/mandates.ts";
import { openRecord } from "../support/record.ts";

type Interp = Record<string, unknown>;
const v = (type: string, fields: Record<string, unknown>) => ({ type, amount: null, currency: null, unit: null, text: null, boolean: null, ...fields });
const price = (amount: number) => ({ term_id: "term_price", value: v("money", { amount }) });
const day = (text: string) => ({ term_id: "term_day", value: v("date_text", { text }) });
const offer = (amount: number, extra: Interp = {}) => ({ intent: "offer", offer_terms: [price(amount)], offer_kind: "offer", ...extra });
const money = (amount: number): Value => ({ type: "money", amount, currency: "INR" });
const pkg = (amount: number, more: OfferTerm[] = []): OfferTerm[] => [
  { termId: "term_delivery", value: { type: "boolean", value: false } },
  { termId: "term_pickup", value: { type: "text", value: "Koramangala, Bangalore" } },
  { termId: "term_price", value: money(amount) },
  ...more,
];

/** Tactic parameters in the shape a strategy document supplies them. Test data. */
const GUIDANCE: StrategyGuidance = parseGuidance({
  id: "test-guidance/1",
  source: "Unit test guidance.",
  increment: 100,
  concessionSteps: [1000, 500, 200],
  maxCounteroffers: 3,
  splitTheDifference: true,
  askBeforeConceding: true,
  walkAwayAfterMaxCounteroffers: true,
  walkAwayLine: "Thank you. Please contact me if your terms change.",
  pressureQuestions: { lowestPrice: "What price and collection time can you accept?", cheaperElsewhere: "Are the condition and delivery the same?" },
});

class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Interp[] = [];
  readonly composed: Array<string | null> = [];
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const reply = (json: unknown) => ({ json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 });
    if (request.purpose === "interpret_counterparty") {
      return reply({ intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, offer_kind: "none", offer_conditions: [], ends_negotiation: false, pressure: "none", notes: [], answers: [], new_terms: [], questions: [], ...this.interpretations.shift() });
    }
    if (request.purpose === "language_check") return reply({ concerns: [] });
    const text = this.composed.shift() ?? null;
    if (text === null) throw new Error("template wording");
    return reply({ text });
  }
}

async function setup(mandate: ValidConfirmedMandate, guidance: StrategyGuidance = GUIDANCE) {
  const { record } = openRecord();
  const started = await record.startSession({ mandate });
  if (!started.ok) throw new Error("start failed");
  const llm = new ScriptedLlm();
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", guidance });
  const sessionId = started.session.id;
  const say = async (text: string, interp: Interp, options: { messageId?: string } = {}): Promise<TurnResult> => {
    llm.interpretations.push(interp);
    llm.composed.push(null);
    const result = await engine.handleCounterpartyMessage({ sessionId, text, channel: "text", messageId: options.messageId });
    if (!result.ok) throw new Error(result.message);
    if (result.reply) await engine.reportDelivery({ sessionId, messageId: result.reply.messageId, channel: "text", status: "delivered" });
    return result;
  };
  const events = () => record.read(sessionId, { viewer: "operator" });
  const state = async () => projectState(await record.context(sessionId));
  const commitments = async () => {
    const ctx = await record.context(sessionId);
    const s = projectState(ctx);
    return projectCommitments(ctx, { negotiableTermId: "term_price", termName: (id) => s.space.terms.find((t) => t.termId === id)?.name ?? id, format: (x) => formatValue(x, "en-IN") });
  };
  const decisions = async () => (await events()).filter((e) => e.type === "decision").map((e) => e.payload as PayloadOf<"decision">);
  return { record, engine, llm, sessionId, say, events, state, commitments, decisions };
}

const priceOf = (terms: OfferTerm[]) => (terms.find((t) => t.termId === "term_price")!.value as { amount: number }).amount;
const proposed = (events: RecordedEvent[]) => events.filter((e) => e.type === "offer_proposed").map((e) => ({ id: e.id, ...(e.payload as PayloadOf<"offer_proposed">) }));

/** "Pickup within 5 days" as a hard limit; test data for the departure-date case. */
function deadlineMandate(): ValidConfirmedMandate {
  return buildMandate({
    instructions: "You can negotiate the price, but don't go below ₹18,000. Pickup must be within 5 days because I am leaving. Ask me before accepting any offer.",
    build: (d) => {
      d.terms.push({ id: "term_days", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "Pickup must be within 5 days" }], name: "days until pickup", description: null, valueType: "quantity", unit: "days", currency: null });
      d.limits.push(
        { id: "limit_min", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "don't go below ₹18,000" }], partyId: "seller", termId: "term_price", kind: "minimum", value: money(18_000), conditionIds: [] },
        { id: "limit_days", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "Pickup must be within 5 days" }], partyId: "seller", termId: "term_days", kind: "maximum", value: { type: "quantity", amount: 5, unit: "days" }, conditionIds: [] },
      );
    },
  });
}

/** Minimum ₹18,000 and a stated target of ₹19,000. Test data. */
function targetMandate(): ValidConfirmedMandate {
  return buildMandate({
    instructions: "You can negotiate the price, but don't go below ₹18,000. I'd be happy with ₹19,000. Ask me before accepting any offer.",
    build: (d) => {
      d.limits.push({ id: "limit_min", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "don't go below ₹18,000" }], partyId: "seller", termId: "term_price", kind: "minimum", value: money(18_000), conditionIds: [] });
      (d.targets ??= []).push({ id: "target_price", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "I'd be happy with ₹19,000" }], partyId: "seller", termId: "term_price", value: money(19_000), conditionIds: [] });
    },
  });
}

// ---------------------------------------------------------------- Epic 7

describe("Epic 7, Story 1: offers, versions and statuses", () => {
  it('"₹18,000 if I can collect Saturday" is one offer with both terms, not a price-only offer', async () => {
    const { say, commitments } = await setup(conditionalMandate());
    await say("₹18,000 if I can collect Saturday.", { intent: "offer", offer_terms: [price(18_000), day("Saturday")], offer_kind: "offer" });
    const c = await commitments();
    expect(c.offers.filter((o) => o.party === "counterparty")).toHaveLength(1);
    expect(c.currentCounterpartyOffer!.terms.map((t) => t.termId).sort()).toEqual(["term_day", "term_price"]);
    expect(c.currentCounterpartyOffer!.sourceMessageId).not.toBeNull();
  });

  it('"₹18,500, but Sunday pickup" is a new version; the original stays in history', async () => {
    const { say, commitments } = await setup(conditionalMandate());
    await say("₹18,000 if I can collect Saturday.", { intent: "offer", offer_terms: [price(18_000), day("Saturday")], offer_kind: "offer" });
    await say("₹18,500, but Sunday pickup.", { intent: "offer", offer_terms: [price(18_500), day("Sunday")], offer_kind: "offer" });
    const theirs = (await commitments()).offers.filter((o) => o.party === "counterparty");
    expect(theirs).toHaveLength(2);
    expect(theirs[0]!.status).toBe("superseded");
    expect(priceOf(theirs[0]!.terms)).toBe(18_000);
    expect(theirs[1]!.version).toBe(2);
    expect(theirs[1]!.previousOfferId).toBe(theirs[0]!.offerId);
  });

  it("a counter the outgoing check blocks is recorded as an internal offer, never as delivered", async () => {
    const { say, events, commitments, state } = await setup(conflictingMinimumsMandate());
    await say("₹15,000.", offer(15_000));
    const all = await events();
    const blocked = all.filter((e) => e.type === "action_checked" && (e.payload as PayloadOf<"action_checked">).phase === "terms" && (e.payload as PayloadOf<"action_checked">).decision !== "allow");
    expect(blocked).toHaveLength(1);
    const blockedOfferId = (blocked[0]!.payload as PayloadOf<"action_checked">).offerId;
    expect(blockedOfferId).not.toBeNull();
    const c = await commitments();
    const internal = c.offers.find((o) => o.offerId === blockedOfferId)!;
    expect(internal.status).toBe("internal");
    expect(internal.blocked).toBe(true);
    expect(c.currentPrincipalOffer).toBeNull();
    expect((await state()).currentAsk).toBe(20_000);
    const reply = all.findLast((e) => e.type === "message")!.payload as PayloadOf<"message">;
    expect(reply.offerIds).toEqual([]);
  });

  it('"Would you take ₹17,000?" is an enquiry with no acceptance', async () => {
    const { say, commitments, events } = await setup(listingOnlyDeliveryMandate());
    await say("Would you take ₹17,000?", offer(17_000, { intent: "question", offer_kind: "enquiry" }));
    const c = await commitments();
    expect(c.currentCounterpartyOffer!.status).toBe("enquiry");
    expect((await events()).some((e) => e.type === "acceptance_recorded")).toBe(false);
  });

  it("replaying the same message creates no second offer and changes no status twice", async () => {
    const { say, commitments } = await setup(listingOnlyDeliveryMandate());
    await say("₹15,000.", offer(15_000), { messageId: "msg_replay_test_1" });
    const before = await commitments();
    await say("₹15,000.", offer(15_000), { messageId: "msg_replay_test_1" });
    const after = await commitments();
    expect(after.offers).toHaveLength(before.offers.length);
    expect(after.offers.map((o) => o.status)).toEqual(before.offers.map((o) => o.status));
  });
});

describe("Epic 7, Story 2: agreement on the current terms only", () => {
  /** Buyer offers ₹18,500 with Saturday collection twice, then confirms the stated terms. */
  async function toAcceptance(guidance: StrategyGuidance = MINIMAL_GUIDANCE) {
    const t = await setup(conditionalMandate(), guidance);
    await t.say("₹18,500 if I collect Saturday.", { intent: "offer", offer_terms: [price(18_500), day("Saturday")], offer_kind: "offer" });
    const second = await t.say("₹18,500, Saturday. That's what I can do.", { intent: "offer", offer_terms: [price(18_500), day("Saturday")], offer_kind: "offer" });
    expect(second.reply!.text).toContain("Is that what you're agreeing to?");
    const accepted = await t.say("Yes, I confirm.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    return { ...t, accepted };
  }

  it("seller approves ₹18,500 with Saturday collection and the buyer confirms: agreement, payment and collection pending", async () => {
    const { accepted, engine, sessionId, commitments, say } = await toAcceptance();
    expect(accepted.state.outcome.kind).toBe("pending_approval");
    expect((await commitments()).outcome).toBe("pending_approval");
    const approved = await engine.respondToApproval({ sessionId, requestId: accepted.state.pendingApproval!.requestId, decision: "approved" });
    if (!approved.ok || !approved.reply) throw new Error("no follow-up");
    expect(approved.state.outcome.kind).toBe("in_progress");
    await engine.reportDelivery({ sessionId, messageId: approved.reply.messageId, channel: "text", status: "delivered" });
    const yes = await say("Yes, still good.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    expect(yes.state.outcome.kind).toBe("agreement");
    const c = await commitments();
    expect(c.outcome).toBe("agreement");
    expect(priceOf(c.agreement!.terms)).toBe(18_500);
    expect(c.agreement!.terms.find((t) => t.termId === "term_day")!.value).toEqual({ type: "date_text", value: "Saturday" });
    expect(c.agreement!.obligations.map((o) => o.description)).toEqual(expect.arrayContaining(["Payment of ₹18,500", "Pickup location: Koramangala, Bangalore", "Collection day: Saturday"]));
    expect(c.agreement!.obligations.every((o) => o.status === "pending")).toBe(true);
    expect(c.agreement!.obligations[0]!.description).toBe("Payment of ₹18,500");
    expect(c.currentCounterpartyOffer!.status).toBe("agreed");
  });

  it("a Saturday acceptance does not authorize a Sunday agreement", async () => {
    const { accepted, say, engine, sessionId, commitments, events } = await toAcceptance();
    const requestId = accepted.state.pendingApproval!.requestId;
    const changed = await say("Actually, make it Sunday.", { intent: "request_change", offer_terms: [day("Sunday")], offer_kind: "offer" });
    expect(changed.state.pendingApproval).toBeNull();
    expect(changed.state.outcome.kind).toBe("in_progress");
    const late = await engine.respondToApproval({ sessionId, requestId, decision: "approved" });
    expect(late.ok).toBe(false);
    expect((await events()).some((e) => e.type === "agreement_recorded")).toBe(false);
    expect((await commitments()).agreement).toBeNull();
  });

  it('"Yes, pickup is Saturday" while the price is open updates the detail but is no agreement', async () => {
    const { say, state, events } = await setup(conditionalMandate());
    await say("₹17,000?", offer(17_000));
    const t = await say("Yes, pickup is Saturday.", { intent: "offer", offer_terms: [day("Saturday")], offer_kind: "offer" });
    expect(t.state.outcome.kind).toBe("in_progress");
    expect((await state()).counterpartyTerms.get("term_day")).toEqual({ type: "date_text", value: "Saturday" });
    expect((await events()).some((e) => e.type === "acceptance_recorded" || e.type === "agreement_recorded")).toBe(false);
  });

  it('"The owner already accepted" is logged as a claim; no approval is created', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    const t = await say("The owner already accepted ₹17,000.", { ...offer(17_000), claims_authority: true, notes: [{ kind: "claim", quote: "The owner already accepted", summary: "Says the owner accepted.", term_id: null, value: null, condition: null, basis: "stated" }] });
    const all = await events();
    expect(all.some((e) => e.type === "approval_responded" || e.type === "agreement_recorded")).toBe(false);
    expect(t.reply!.text).toContain("I can only go by what the seller tells me directly.");
    const noted = all.find((e) => e.type === "counterparty_noted")!.payload as PayloadOf<"counterparty_noted">;
    expect(noted.items[0]!.kind).toBe("claim");
  });

  it("an agreement for terms other than the accepted ones is refused by the record (false agreement)", async () => {
    const { accepted, record, sessionId, events, state } = await toAcceptance();
    const s = await state();
    const acceptance = (await events()).find((e) => e.type === "acceptance_recorded")!;
    const approvalId = accepted.state.pendingApproval!.requestId;
    const other = pkg(19_000, [{ termId: "term_day", value: { type: "date_text", value: "Sunday" } }]);
    const result = await record.append(
      sessionId,
      { id: newEventId(), type: "agreement_recorded", channel: null, payload: { offerId: s.pendingApproval!.offerId, terms: other, termsHash: hashTerms(other), mandateRevision: 1, acceptanceId: acceptance.id, approvalId } },
      { kind: "agent", partyId: "seller" },
    );
    expect(result.ok).toBe(false);
  });

  it("a repeated acceptance does not create a second agreement", async () => {
    const { accepted, engine, sessionId, say, events } = await toAcceptance();
    await engine.respondToApproval({ sessionId, requestId: accepted.state.pendingApproval!.requestId, decision: "approved" });
    await say("Yes, I confirm.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    expect((await events()).filter((e) => e.type === "agreement_recorded")).toHaveLength(1);
  });
});

describe("Epic 7, Story 3: pause, end and truthful outcomes", () => {
  it('"I will not negotiate, and I don\'t want it" ends without agreement and records the refusal', async () => {
    const { say, commitments, events } = await setup(listingOnlyDeliveryMandate());
    await say("₹15,000.", offer(15_000));
    const t = await say("I will not negotiate, and I don't want it.", { intent: "reject", ends_negotiation: true });
    expect(t.state.status).toBe("no_agreement");
    expect(t.state.outcome.kind).toBe("no_agreement");
    const c = await commitments();
    expect(c.outcome).toBe("no_agreement");
    expect(c.agreement).toBeNull();
    expect(c.stopped!.by).toBe("counterparty");
    expect(c.stopped!.unresolved).toContain("price");
    expect((await events()).some((e) => e.type === "agreement_recorded")).toBe(false);
    expect(t.reply!.text).toBe("Understood. Thanks for your time.");
    expect(c.currentCounterpartyOffer!.status).toBe("withdrawn");
    expect(c.currentPrincipalOffer!.status).toBe("withdrawn");
  });

  it("the no-agreement summary gives each side's last offer and the difference, never the private limit", async () => {
    const { say, commitments } = await setup(listingOnlyDeliveryMandate());
    await say("₹15,000.", offer(15_000));
    await say("No thanks, I'm out.", { intent: "reject", ends_negotiation: true });
    const c = await commitments();
    const summary = noAgreementSummary(c, { negotiableTermId: "term_price", termName: (id) => (id === "term_price" ? "price" : id), format: (x) => formatValue(x, "en-IN") });
    expect(summary.lastCounterpartyOffer.join(" ")).toContain("₹15,000");
    expect(summary.lastPrincipalOffer.join(" ")).toContain("₹19,000");
    expect(summary.differences).toEqual(["price: ours ₹19,000, theirs ₹15,000"]);
    expect(JSON.stringify(summary)).not.toContain("18,000");
  });

  it('"I need to ask my partner" keeps the case open with no agreement', async () => {
    const { say, commitments } = await setup(listingOnlyDeliveryMandate());
    const t = await say("I need to ask my partner.", { notes: [{ kind: "authority", quote: "I need to ask my partner", summary: "Partner must agree.", term_id: null, value: null, condition: null, basis: "stated" }] });
    expect(t.state.status).toBe("active");
    expect((await commitments()).outcome).toBe("negotiating");
    expect(t.reply!.text).toContain("does someone else need to agree first?");
  });

  it("a pause while an offer is open keeps the last offer and sends no new commitment", async () => {
    const { say, engine, sessionId, commitments, events } = await setup(listingOnlyDeliveryMandate());
    await say("₹15,000.", offer(15_000));
    const before = proposed(await events()).length;
    await engine.setPaused({ sessionId, paused: true });
    const t = await say("₹16,000?", offer(16_000));
    expect(t.reply!.text).toContain("paused");
    expect(proposed(await events())).toHaveLength(before);
    const c = await commitments();
    expect(c.outcome).toBe("paused");
    expect(c.currentPrincipalOffer!.status).toBe("delivered");
    expect(priceOf(c.currentPrincipalOffer!.terms)).toBe(19_000);
  });

  it("a session that stops after a price question infers no agreement", async () => {
    const { say, commitments } = await setup(listingOnlyDeliveryMandate());
    await say("What is the price?", { intent: "question", questions: ["What is the price?"] });
    const c = await commitments();
    expect(c.outcome).toBe("negotiating");
    expect(c.agreement).toBeNull();
  });

  it("the principal can end the negotiation; later messages get no offer", async () => {
    const { say, engine, sessionId, commitments, events } = await setup(listingOnlyDeliveryMandate());
    await say("₹15,000.", offer(15_000));
    const ended = await engine.endNegotiation({ sessionId, reason: "Keeping it for now." });
    expect(ended.ok).toBe(true);
    const c = await commitments();
    expect(c.outcome).toBe("no_agreement");
    expect(c.stopped).toEqual({ by: "principal", reason: "Keeping it for now.", unresolved: ["price"] });
    expect(c.currentCounterpartyOffer!.status).toBe("rejected");
    const before = proposed(await events()).length;
    const late = await say("OK, ₹19,000 then.", offer(19_000));
    expect(late.reply!.text).toBe("This conversation has ended without an agreement. Thanks for your time.");
    expect(proposed(await events())).toHaveLength(before);
    expect(late.state.status).toBe("no_agreement");
    expect((await engine.endNegotiation({ sessionId })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- Epic 8

describe("Epic 8, Story 1: assess the complete package", () => {
  it("a higher price with pickup after the departure date conflicts; the lower one with permitted pickup does not", async () => {
    const { state } = await setup(deadlineMandate());
    const s = await state();
    const late = assessPackage(s, pkg(19_500, [{ termId: "term_days", value: { type: "quantity", amount: 10, unit: "days" } }]), "en-IN");
    const early = assessPackage(s, pkg(19_000, [{ termId: "term_days", value: { type: "quantity", amount: 3, unit: "days" } }]), "en-IN");
    expect(late.verdict).toBe("unacceptable");
    expect(late.drivers[0]).toContain("days until pickup");
    expect(early.verdict).toBe("acceptable");
    expect(early.needsApproval).toBe(true);
  });

  it("₹18,500 with Saturday collection under a ₹18,000 Saturday minimum is acceptable but still needs approval", async () => {
    const { state } = await setup(conditionalMandate());
    const a = assessPackage(await state(), pkg(18_500, [{ termId: "term_day", value: { type: "date_text", value: "Saturday" } }]), "en-IN");
    expect(a.verdict).toBe("acceptable");
    expect(a.needsApproval).toBe(true);
    expect(a.drivers).toContain("Agreeing still needs the principal's approval.");
  });

  it("₹19,000 with delivery is not accepted when the listing excludes delivery", async () => {
    const { say, state, events } = await setup(listingOnlyDeliveryMandate());
    const a = assessPackage(await state(), [{ termId: "term_delivery", value: { type: "boolean", value: true } }, ...pkg(19_000).filter((t) => t.termId !== "term_delivery")], "en-IN");
    expect(a.verdict).not.toBe("acceptable");
    const t = await say("₹19,000 with delivery.", { intent: "offer", offer_terms: [price(19_000), { term_id: "term_delivery", value: v("boolean", { boolean: true }) }], offer_kind: "offer" });
    const offered = proposed(await events()).at(-1)!;
    expect(offered.terms.find((x) => x.termId === "term_delivery")!.value).toEqual({ type: "boolean", value: false });
    expect(t.state.outcome.kind).toBe("in_progress");
  });

  it("no stated alternative stays unknown, and the decision records the assessment", async () => {
    const { say, decisions } = await setup(listingOnlyDeliveryMandate());
    await say("₹15,000.", offer(15_000));
    const d = (await decisions()).at(-1)!;
    expect(d.assessment!.verdict).toBe("unacceptable");
    expect(d.assessment!.drivers).toContain("No alternative to a deal is stated; it stays unknown.");
    expect(d.action).toBe("counter");
    expect(d.guidance).toBe("test-guidance/1");
    expect(d.mandateRevision).toBe(1);
  });
});

describe("Epic 8, Story 2: questions that reveal what blocks agreement", () => {
  const costNote = { kind: "constraint", quote: "pickup will cost me ₹2,000", summary: "Pickup costs them ₹2,000.", term_id: null, value: v("money", { amount: 2_000 }), condition: null, basis: "stated" };

  it('"₹20,000 is too much because pickup will cost me ₹2,000": ask about the budget, no automatic ₹2,000 discount', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    const t = await say("₹20,000 is too much because pickup will cost me ₹2,000.", { intent: "other", notes: [costNote] });
    expect(t.reply!.text).toContain("what amount would work for you?");
    expect(proposed(await events()).every((o) => priceOf(o.terms) === 20_000)).toBe(true);
  });

  it('"₹20,000 is too much" after a counter is an objection, never an offer above the current ask', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    await say("₹15,000.", offer(15_000));
    // The model may tag the cost to the price term; it still reads as a cost, not a price.
    const t = await say("₹20,000 is too much because pickup will cost me ₹2,000.", { ...offer(20_000), intent: "reject", notes: [{ ...costNote, kind: "reason", term_id: "term_price" }] });
    expect(t.reply!.text).toMatch(/stay(ing)? at ₹19,000/);
    expect(t.reply!.text).not.toContain("Is that what you're agreeing to");
    expect(t.reply!.text).toContain("what amount would work for you?");
    expect((await events()).filter((e) => e.type === "offer_extracted")).toHaveLength(1);
  });

  it("with an offer and a non-price reason, the strategy asks before conceding", async () => {
    const { say, decisions, events } = await setup(listingOnlyDeliveryMandate());
    const t = await say("I can do ₹17,000 because pickup will cost me ₹2,000.", { ...offer(17_000), notes: [{ ...costNote, quote: "pickup will cost me ₹2,000" }] });
    expect((await decisions()).at(-1)!.action).toBe("ask");
    expect(t.reply!.text).toMatch(/stay(ing)? at ₹20,000/);
    expect(t.reply!.text).toContain("what amount would work for you?");
    expect(proposed(await events()).every((o) => priceOf(o.terms) === 20_000)).toBe(true);
  });

  it('"Saturday only if I get a truck" stays conditional and asks for the missing fact', async () => {
    const { say, commitments, decisions } = await setup(conditionalMandate());
    const t = await say("₹18,000, Saturday, but only if I get a truck.", {
      intent: "offer",
      offer_terms: [price(18_000), day("Saturday")],
      offer_kind: "offer",
      offer_conditions: ["if I get a truck"],
      notes: [{ kind: "constraint", quote: "only if I get a truck", summary: "Collection depends on a truck.", term_id: "term_day", value: v("date_text", { text: "Saturday" }), condition: "if you get a truck", basis: "stated" }],
    });
    expect((await commitments()).currentCounterpartyOffer!.status).toBe("pending_clarification");
    expect((await decisions()).at(-1)!.action).toBe("clarify");
    expect(t.reply!.text).toContain("When will you know whether you get a truck?");
    expect(t.reply!.text).not.toContain("Is that what you're agreeing to");
  });

  it('"I need to ask my partner first" with an offer keeps it conditional and asks what must be settled', async () => {
    const { say, decisions, events } = await setup(listingOnlyDeliveryMandate());
    const t = await say("I'd pay ₹19,000, but I need to ask my partner first.", { ...offer(19_000), offer_conditions: ["I need to ask my partner first"] });
    expect((await decisions()).at(-1)!.action).toBe("clarify");
    expect(t.reply!.text).toContain("What do you need to settle before you can commit to this?");
    expect(t.reply!.text).not.toContain("Is that what you're agreeing to");
    expect((await events()).some((e) => e.type === "question_asked")).toBe(true);
  });

  it("a conditional clarification is asked once; a repeated conditional offer is then evaluated on its terms", async () => {
    const { say, decisions } = await setup(listingOnlyDeliveryMandate());
    const first = await say("I'd pay ₹19,000 if my partner agrees.", { ...offer(19_000), offer_conditions: ["if my partner agrees"] });
    expect(first.reply!.text).toContain("What do you need to settle");
    const again = await say("Still ₹19,000 if my partner agrees.", { ...offer(19_000), offer_conditions: ["if my partner agrees"] });
    expect(again.reply!.text).not.toContain("What do you need to settle");
    expect((await decisions()).at(-1)!.action).not.toBe("clarify");
  });

  it("a price question that comes with an offer is not treated as an unanswered factual question", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const t = await say("Can you do ₹19,000 instead?", { ...offer(19_000), questions: ["Can you do ₹19,000 instead?"] });
    expect(t.reply!.text).not.toContain("I don't have information");
  });

  it("an answered question is resolved and is not asked again", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    await say("₹20,000 is too much because pickup will cost me ₹2,000.", { intent: "other", notes: [costNote] });
    const asked = (await events()).find((e) => e.type === "question_asked")!.payload as PayloadOf<"question_asked">;
    const t = await say("About ₹16,000 for the item.", { ...offer(16_000), answers: [{ question_id: asked.questionId, quote: "About ₹16,000 for the item.", resolution: "answered" }] });
    expect(t.reply!.text).not.toContain("what amount would work for you?");
    expect((await events()).some((e) => e.type === "question_answered")).toBe(true);
  });

  it("a refused budget question is not repeated and no budget is invented", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    await say("₹20,000 is too much because pickup will cost me ₹2,000.", { intent: "other", notes: [costNote] });
    const asked = (await events()).find((e) => e.type === "question_asked")!.payload as PayloadOf<"question_asked">;
    const t = await say("I'd rather not say.", { answers: [{ question_id: asked.questionId, quote: "I'd rather not say.", resolution: "refused" }] });
    expect(t.reply!.text).not.toContain("what amount would work for you?");
    expect(t.reply!.text).toMatch(/^No problem\. .*stay(ing)? at ₹20,000/);
    expect((await events()).filter((e) => e.type === "question_asked")).toHaveLength(1);
  });
});

describe("Epic 8, Story 3: choose, adjust or end the move", () => {
  it("concessions follow the guidance steps, each smaller, rounded, and never past the limit", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    await say("₹15,000.", offer(15_000));
    await say("₹16,000.", offer(16_000));
    await say("₹16,500.", offer(16_500));
    const prices = proposed(await events()).map((o) => priceOf(o.terms));
    expect(prices).toEqual([19_000, 18_500, 18_300]);
    expect(proposed(await events()).map((o) => o.tactic)).toEqual(["concession_step", "concession_step", "concession_step"]);
  });

  it("after the last counteroffer, an offer below the minimum ends without agreement using the guidance line", async () => {
    const { say, commitments, events } = await setup(listingOnlyDeliveryMandate());
    for (const amount of [15_000, 16_000, 16_500]) await say(`₹${amount}`, offer(amount));
    const t = await say("₹17,000, I won't change anything else.", offer(17_000));
    expect(t.reply!.text).toBe("Thank you. Please contact me if your terms change.");
    expect(t.state.status).toBe("no_agreement");
    const c = await commitments();
    expect(c.stopped!.by).toBe("agent");
    for (const o of proposed(await events())) expect(priceOf(o.terms)).toBeGreaterThanOrEqual(18_000);
  });

  it("with the offer already at the limit, a second offer below it ends without agreement", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate(), { ...GUIDANCE, concessionSteps: [3000] });
    await say("₹15,000.", offer(15_000));
    const held = await say("₹16,000.", offer(16_000));
    expect(held.reply!.text).toMatch(/stay(ing)? at ₹18,000/);
    expect(held.state.status).toBe("active");
    const t = await say("₹16,500.", offer(16_500));
    expect(t.state.status).toBe("no_agreement");
    expect(t.reply!.text).toBe("Thank you. Please contact me if your terms change.");
  });

  it("after the last counteroffer, an offer within the minimum is stated for confirmation", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    for (const amount of [15_000, 16_000, 16_500]) await say(`₹${amount}`, offer(amount));
    const t = await say("₹18,000.", offer(18_000));
    expect(t.reply!.text).toContain("₹18,000");
    expect(t.reply!.text).toContain("Is that what you're agreeing to?");
  });

  it("a repeated offer earns no further reduction", async () => {
    const { say, events, decisions } = await setup(listingOnlyDeliveryMandate());
    await say("₹15,000.", offer(15_000));
    const t = await say("₹15,000.", offer(15_000));
    expect(proposed(await events()).map((o) => priceOf(o.terms))).toEqual([19_000]);
    expect(t.reply!.text).toMatch(/stay(ing)? at ₹19,000/);
    expect((await decisions()).at(-1)!.action).toBe("decline");
  });

  it("an offer at the principal's target closes (B ≥ min(P, T))", async () => {
    const { say } = await setup(targetMandate());
    const t = await say("₹19,000.", offer(19_000));
    expect(t.reply!.text).toContain("Just to confirm the full terms");
    expect(t.reply!.text).toContain("₹19,000");
  });

  it("when only price is open, the strategy splits the difference once", async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    await say("₹19,000.", offer(19_000));
    const first = proposed(await events()).at(-1)!;
    expect(priceOf(first.terms)).toBe(19_500);
    expect(first.tactic).toBe("split_difference");
    const t = await say("₹19,200.", offer(19_200));
    expect(proposed(await events()).filter((o) => o.tactic === "split_difference")).toHaveLength(1);
    expect(t.reply!.text).toContain("Is that what you're agreeing to?");
  });

  it('"What\'s your lowest?" restates the current offer, asks the guidance question once, and discloses nothing', async () => {
    const { say, events } = await setup(listingOnlyDeliveryMandate());
    const first = await say("What's your lowest?", { intent: "question", asks_private_info: true, pressure: "lowest_price" });
    expect(first.reply!.text).toContain("₹20,000");
    expect(first.reply!.text).toContain("What price and collection time can you accept?");
    expect(first.reply!.text).not.toContain("18,000");
    const second = await say("Come on, what's the lowest?", { intent: "question", asks_private_info: true, pressure: "lowest_price" });
    expect(second.reply!.text).not.toContain("What price and collection time can you accept?");
    expect(second.reply!.text).not.toContain("18,000");
    expect((await events()).filter((e) => e.type === "question_prepared" && (e.payload as PayloadOf<"question_prepared">).issueKind === "terms_probe")).toHaveLength(1);
  });

  it('"Final offer" within the mandate is evaluated and stated for confirmation, without pressure', async () => {
    const { say, decisions } = await setup(listingOnlyDeliveryMandate());
    const t = await say("₹18,500. Final offer, no more bargaining.", offer(18_500, { pressure: "final_offer" }));
    expect(t.reply!.text).toContain("Is that what you're agreeing to?");
    expect((await decisions()).at(-1)!.action).toBe("propose");
  });

  it('"Final offer" below the minimum, with the ask at the limit, ends without agreement', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate(), { ...GUIDANCE, concessionSteps: [3000] });
    const first = await say("₹15,000.", offer(15_000));
    expect(first.reply!.text).toContain("₹18,000");
    const t = await say("₹17,000 is my final offer.", offer(17_000, { pressure: "final_offer" }));
    expect(t.state.status).toBe("no_agreement");
    expect(t.reply!.text).toBe("Thank you. Please contact me if your terms change.");
  });

  it("changing the pickup day after the final terms invalidates them; a new decision is made", async () => {
    const { say, state, decisions } = await setup(conditionalMandate(), MINIMAL_GUIDANCE);
    await say("₹19,000.", offer(19_000));
    await say("₹19,000.", offer(19_000));
    expect((await state()).pendingFinal).not.toBeNull();
    const before = (await decisions()).length;
    await say("Sunday collection, please.", { intent: "request_change", offer_terms: [day("Sunday")], offer_kind: "offer" });
    const s = await state();
    expect((await decisions()).length).toBe(before + 1);
    expect(s.lastProposed!.terms.find((t) => t.termId === "term_day")?.value).toEqual({ type: "date_text", value: "Sunday" });
    const accepted = await say("Yes, I confirm.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    const acceptedTerms = accepted.state.outcome.terms ?? [];
    expect(acceptedTerms.find((t) => t.termId === "term_day")?.value).not.toEqual({ type: "date_text", value: "Saturday" });
  });

  it("an unauthorized exception is declined; one the mandate allows is put to the principal", async () => {
    const strict = await setup(noExceptionMandate(), { ...GUIDANCE, concessionSteps: [3000], walkAwayAfterMaxCounteroffers: false });
    await strict.say("₹15,000.", offer(15_000));
    await strict.say("₹17,000, please make an exception.", offer(17_000));
    expect((await strict.events()).some((e) => e.type === "approval_requested")).toBe(false);
    const flexible = await setup(exceptionMandate(), { ...GUIDANCE, concessionSteps: [3000], walkAwayAfterMaxCounteroffers: false });
    await flexible.say("₹15,000.", offer(15_000));
    await flexible.say("₹17,000, please make an exception.", offer(17_000));
    const request = (await flexible.events()).find((e) => e.type === "approval_requested")!.payload as PayloadOf<"approval_requested">;
    expect(request.purpose).toBe("exception");
    expect((await flexible.commitments()).outcome).toBe("pending_approval");
  });

  it("guidance cannot breach a confirmed limit: the strategy stops at it and the gate blocks a breaching move", async () => {
    const { say, events, state } = await setup(noExceptionMandate(), { ...GUIDANCE, concessionSteps: [9000] });
    await say("₹10,000.", offer(10_000));
    expect(proposed(await events()).map((o) => priceOf(o.terms))).toEqual([18_000]);
    const s = await state();
    const breaching: Plan = { move: "counter", decision: { kind: "counter", reason: "guidance step" }, offer: { terms: pkg(11_000), basis: "counter" }, acceptanceOf: null, declined: [], refuseDisclosure: false, ignoreAuthorityClaim: false, questions: [], respondingTo: null, notice: null, clarify: [], unresolved: [], ask: null };
    expect(gateTerms(s, breaching, s.mandateRevision).decision).toBe("block");
  });

  it('"Final offer, no more bargaining" with an amount is an offer to evaluate, not a withdrawal', async () => {
    const { say } = await setup(listingOnlyDeliveryMandate());
    const t = await say("₹18,500. Final offer, no more bargaining.", offer(18_500, { pressure: "final_offer", ends_negotiation: true }));
    expect(t.state.status).toBe("active");
    expect(t.reply!.text).toContain("Is that what you're agreeing to?");
  });

  it("a strategy failure returns a safe status: nothing offered, no agreement", async () => {
    const broken = { ...GUIDANCE } as StrategyGuidance;
    Object.defineProperty(broken, "concessionSteps", { get: () => { throw new Error("bad guidance"); } });
    const { say, events } = await setup(listingOnlyDeliveryMandate(), broken);
    const t = await say("₹15,000.", offer(15_000));
    expect(t.reply!.text).toContain("needs the seller's approval");
    expect(proposed(await events())).toHaveLength(0);
    expect(t.state.outcome.kind).toBe("in_progress");
  });

  it("without a strategy document the core still negotiates inside the mandate (minimal guidance)", async () => {
    const { say, events, decisions } = await setup(listingOnlyDeliveryMandate(), MINIMAL_GUIDANCE);
    await say("₹15,000.", offer(15_000));
    expect(priceOf(proposed(await events())[0]!.terms)).toBe(19_000);
    expect((await decisions()).at(-1)!.guidance).toBe("minimal");
  });
});

describe("Discount allowance per counterparty commitment", () => {
  const ALLOWANCE: StrategyGuidance = parseGuidance({
    ...GUIDANCE,
    splitTheDifference: false,
    walkAwayAfterMaxCounteroffers: false,
    commitmentAllowance: {
      betterOffer: 1000,
      terms: [{ termId: "term_day", value: { type: "date_text", value: "Saturday" }, allowance: 500, label: "Collection on Saturday" }],
    },
  });
  const lastDecision = (turn: TurnResult) => turn.events.findLast((e) => e.type === "decision")!.payload as PayloadOf<"decision">;

  it("a better offer earns the allowance, a worse or repeated one earns nothing, and the ledger records each step", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate(), ALLOWANCE);
    const first = await say("₹15,000.", offer(15_000));
    expect(priceOf(proposed(first.events)[0]!.terms)).toBe(19_000);
    expect(lastDecision(first).allowance).toMatchObject({ earned: 1000, used: 0, remaining: 1000, entries: [{ kind: "better_offer", earned: 1000, used: 0 }] });

    const worse = await say("₹14,500.", offer(14_500));
    expect(proposed(worse.events).every((p) => priceOf(p.terms) === 19_000)).toBe(true);
    expect(worse.reply!.text).toContain("₹19,000");
    expect(lastDecision(worse)).toMatchObject({ kind: "hold", allowance: { earned: 1000, used: 1000, remaining: 0 } });
    expect(lastDecision(worse).reason).toMatch(/no unused discount allowance/i);

    const better = await say("₹16,000.", offer(16_000));
    expect(priceOf(proposed(better.events)[0]!.terms)).toBe(18_500);
    expect(lastDecision(better).allowance).toMatchObject({ earned: 2000, used: 1000, remaining: 1000 });
    expect(better.reply!.text).not.toMatch(/allowance|earned|remaining/i);
  });

  it("without a configured allowance, the same worse offer still gets the next approved step", async () => {
    const { say } = await setup(listingOnlyDeliveryMandate(), { ...ALLOWANCE, commitmentAllowance: null });
    await say("₹15,000.", offer(15_000));
    const worse = await say("₹14,500.", offer(14_500));
    expect(priceOf(proposed(worse.events)[0]!.terms)).toBe(18_500);
    expect(lastDecision(worse).allowance).toBeNull();
  });

  it("a non-price commitment listed in the guidance earns its own allowance, once", async () => {
    const { say } = await setup(conditionalMandate(), { ...ALLOWANCE, commitmentAllowance: { ...ALLOWANCE.commitmentAllowance!, betterOffer: 0 } });
    const plain = await say("₹17,000.", offer(17_000));
    expect(proposed(plain.events).every((p) => priceOf(p.terms) === 20_000)).toBe(true);
    expect(lastDecision(plain).allowance).toMatchObject({ earned: 0, remaining: 0 });

    const saturday = await say("₹17,000 if I collect on Saturday.", offer(17_000, { offer_terms: [price(17_000), day("Saturday")] }));
    expect(priceOf(proposed(saturday.events)[0]!.terms)).toBe(19_500);
    expect(lastDecision(saturday).allowance).toMatchObject({ earned: 500, remaining: 500, entries: [{ kind: "term", commitment: "Collection on Saturday", earned: 500 }] });

    const again = await say("₹17,000, Saturday.", offer(17_000, { offer_terms: [price(17_000), day("Saturday")] }));
    expect(proposed(again.events).every((p) => priceOf(p.terms) === 19_500)).toBe(true);
    expect(lastDecision(again).allowance).toMatchObject({ earned: 500, used: 500, remaining: 0 });
  });

  it("the buyer view never carries the allowance", async () => {
    const { say, record, sessionId } = await setup(listingOnlyDeliveryMandate(), ALLOWANCE);
    await say("₹15,000.", offer(15_000));
    const buyer = await record.read(sessionId, { viewer: "counterparty" });
    expect(JSON.stringify(buyer)).not.toMatch(/allowance/);
  });
});

describe("Package-specific targets", () => {
  /** Minimum ₹19,000 (₹18,000 on Saturday); target ₹19,800, or ₹18,800 for Saturday collection. Test data. */
  function packageTargetMandate(): ValidConfirmedMandate {
    const extra = " I'd be happy with ₹19,800. For Saturday collection, ₹18,800 is a good result.";
    return buildMandate({
      instructions: `You can negotiate the price, but don't go below ₹19,000. I'll accept ₹18,000 only if collection is on Saturday. Collection from Koramangala only. Ask me before accepting any offer.${extra}`,
      build: (d) => {
        d.terms.push({ id: "term_day", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "collection is on Saturday" }], name: "collection day", description: null, valueType: "date_text", unit: null, currency: null });
        d.conditions.push({ id: "condition_saturday", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "only if collection is on Saturday" }], description: "Collection is on Saturday", termId: "term_day", operator: "equals", value: { type: "date_text", value: "Saturday" } });
        d.limits.push(
          { id: "limit_min", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "don't go below ₹19,000" }], partyId: "seller", termId: "term_price", kind: "minimum", value: money(19_000), conditionIds: [] },
          { id: "limit_min_saturday", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "I'll accept ₹18,000 only if collection is on Saturday" }], partyId: "seller", termId: "term_price", kind: "minimum", value: money(18_000), conditionIds: ["condition_saturday"] },
        );
        (d.targets ??= []).push(
          { id: "target_price", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "I'd be happy with ₹19,800" }], partyId: "seller", termId: "term_price", value: money(19_800), conditionIds: [] },
          { id: "target_price_saturday", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: "instructions", quote: "For Saturday collection, ₹18,800 is a good result" }], partyId: "seller", termId: "term_price", value: money(18_800), conditionIds: ["condition_saturday"] },
        );
      },
    });
  }

  it("an offer at the Saturday target closes on the Saturday package; the same price without Saturday does not", async () => {
    const saturday = await setup(packageTargetMandate());
    const t = await saturday.say("₹18,800 if I collect on Saturday.", offer(18_800, { offer_terms: [price(18_800), day("Saturday")] }));
    expect(t.events.findLast((e) => e.type === "decision")?.payload).toMatchObject({ kind: "state_final_terms" });
    expect(proposed(t.events)[0]!.terms).toEqual(expect.arrayContaining([{ termId: "term_day", value: { type: "date_text", value: "Saturday" } }, { termId: "term_price", value: money(18_800) }]));

    const weekday = await setup(packageTargetMandate());
    const w = await weekday.say("₹18,800.", offer(18_800));
    expect(w.events.findLast((e) => e.type === "decision")?.payload).not.toMatchObject({ kind: "state_final_terms" });
  });

  it("the assessment names only the target that applies to the package", async () => {
    const { state } = await setup(packageTargetMandate());
    const s = await state();
    const sat = assessPackage(s, pkg(18_800, [{ termId: "term_day", value: { type: "date_text", value: "Saturday" } }]), "en-IN");
    expect(sat.drivers.join(" ")).toContain("₹18,800");
    const plain = assessPackage(s, pkg(19_000), "en-IN");
    expect(plain.drivers.join(" ")).toContain("₹19,800");
    expect(plain.drivers.join(" ")).not.toContain("₹18,800");
  });
});

describe("Console insights", () => {
  const insightsOf = async (record: Awaited<ReturnType<typeof setup>>["record"], sessionId: string, guidance: StrategyGuidance = GUIDANCE) => {
    const ctx = await record.context(sessionId);
    const s = projectState(ctx);
    return negotiationInsights(s, projectCounterparty(ctx, "term_price"), guidance, projectAllowance(ctx, s.view, guidance))!;
  };
  const budget = (amount: number) => ({ notes: [{ kind: "budget", quote: `My budget is ₹${amount.toLocaleString("en-IN")}.`, summary: "Stated budget.", term_id: "term_price", value: v("money", { amount }), condition: null, basis: "stated" }] });

  it("reports an unknown zone until the other side says something, then the zone between the limit and their stated ceiling", async () => {
    const { say, record, sessionId } = await setup(listingOnlyDeliveryMandate());
    const before = await insightsOf(record, sessionId);
    expect(before).toMatchObject({ opening: 20_000, currentAsk: 20_000, limit: 18_000, zone: { status: "unknown" }, counterparty: { bestOffer: null, statedCeiling: null } });
    await say("My budget is ₹18,500.", budget(18_500));
    await say("₹17,500.", offer(17_500));
    const after = await insightsOf(record, sessionId);
    expect(after.counterparty).toMatchObject({ bestOffer: 17_500, latestOffer: 17_500, statedCeiling: 18_500 });
    expect(after.zone).toEqual({ status: "overlap", from: 18_000, to: 18_500 });
    expect(after.gap).toBe(after.currentAsk! - 17_500);
    // One step toward the stated budget, then one counter to the ₹17,500 offer.
    expect(after.strategy).toMatchObject({ countersMade: 2, maxCounteroffers: 3 });
  });

  it("reports no overlap when the stated ceiling is below the limit", async () => {
    const { say, record, sessionId } = await setup(listingOnlyDeliveryMandate());
    await say("My budget is ₹17,000.", budget(17_000));
    expect((await insightsOf(record, sessionId)).zone).toEqual({ status: "no_overlap", from: null, to: null });
  });
});
