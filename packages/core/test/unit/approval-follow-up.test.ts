/**
 * Approval with a later follow-up: the wrap-up after the buyer accepts (how long the offer stands, how to
 * reach them, "not final yet"), the seller's approve / counter / decline, the follow-up, and the rule that
 * only the buyer's yes after an approval records the agreement.
 */
import { describe, expect, it } from "vitest";
import type { StructuredLlm, StructuredRequest, StructuredResponse } from "../../src/llm/types.ts";
import { NegotiationEngine, type TurnResult } from "../../src/negotiation/engine.ts";
import { readFollowUp } from "../../src/negotiation/interpret.ts";
import { composeBrief } from "../../src/negotiation/compose.ts";
import { readMandate } from "../../src/negotiation/mandate-view.ts";
import { findAmounts } from "../../src/negotiation/reply-check.ts";
import type { Channel, PayloadOf } from "../../src/record/events.ts";
import type { Plan } from "../../src/negotiation/policy.ts";
import { acceptance, AGENT, agreement, approvalRequest, approvalResponse, BUYER, delivered, demoTerms, inbound, loadDemoMandate, money, mustAppend, openRecord, outbound, proposed, SELLER, SYSTEM } from "../support/record.ts";

const mandate = loadDemoMandate();
const view = readMandate(mandate);
const terms = demoTerms(mandate);

type FollowUpJson = Partial<{ valid_until: string | null; validity_quote: string | null; contact: string | null; phone_number: string | null; use_this_number: boolean; best_time_quote: string | null; keep_contact: boolean | null; declined: string[] }>;
type Interp = Record<string, unknown> & { follow_up?: FollowUpJson };
const offer = (amount: number) => ({ term_id: terms.price, value: { type: "money", amount, currency: null, unit: null, text: null, boolean: null } });
const yes: Interp = { intent: "accept_stated_terms", accepts_stated_terms: true };
const followUp = (f: FollowUpJson): FollowUpJson => ({ valid_until: null, validity_quote: null, contact: null, phone_number: null, use_this_number: false, best_time_quote: null, keep_contact: null, declined: [], ...f });

/** Scripted model: readings in order; wording always falls back to the checked templates. */
class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Interp[] = [];
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    if (request.purpose === "interpret_counterparty") {
      const json = { intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, questions: [], ...(this.interpretations.shift() ?? {}) };
      return { json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 };
    }
    if (request.purpose === "language_check") return { json: { concerns: [] }, rawText: "", model: "scripted", latencyMs: 0 };
    throw new Error("no scripted wording");
  }
}

async function setup() {
  const { record } = openRecord();
  const started = await record.startSession({ mandate });
  if (!started.ok) throw new Error("start failed");
  const llm = new ScriptedLlm();
  const clock = { now: new Date("2026-11-22T13:30:00Z") };
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", now: () => clock.now });
  const sessionId = started.session.id;
  const deliver = async (reply: TurnResult["reply"], channel: Channel) => {
    if (reply) await engine.reportDelivery({ sessionId, messageId: reply.messageId, channel, status: "delivered" });
  };
  const say = async (text: string, interp: Interp, channel: Channel = "text", contactNumber: string | null = null): Promise<TurnResult> => {
    llm.interpretations.push(interp);
    const result = await engine.handleCounterpartyMessage({ sessionId, text, channel, contactNumber });
    if (!result.ok) throw new Error(result.message);
    await deliver(result.reply, channel);
    return result;
  };
  const events = () => record.read(sessionId, { viewer: "operator" });
  /** Buyer offers ₹19,500 (read back for confirmation) and confirms it: the approval request is pending. */
  const toPending = async (channel: Channel = "text") => {
    await say("I can do ₹19,500.", { intent: "offer", offer_terms: [offer(19_500)] }, channel);
    const accepted = await say("Yes, confirmed.", yes, channel);
    expect(accepted.state.status).toBe("awaiting_approval");
    return accepted;
  };
  return { record, engine, llm, clock, sessionId, say, deliver, events, toPending };
}

describe("the wrap-up after the buyer accepts", () => {
  it("asks in one question how long the offer stands and when to get back to them, then says it is not final, once", async () => {
    const t = await setup();
    const accepted = await t.toPending();
    expect(accepted.reply!.text).toMatch(/How long does your offer stand, and when's a good time to get back to you\?/);
    expect(accepted.reply!.text).not.toMatch(/\bagreed\b|\bdeal\b/i);

    const answer = await t.say("Good till tonight. Here in the chat is fine, any time.", { intent: "other", follow_up: followUp({ valid_until: "2026-11-22T23:59:00+05:30", validity_quote: "Good till tonight", contact: "chat", best_time_quote: "any time" }) });
    expect(answer.reply!.text).toMatch(/not final until/i);
    expect(answer.reply!.text).not.toContain("?");
    expect(answer.endCall).toBe(false);

    const later = await t.say("Any news?", { intent: "question" });
    expect(later.reply!.text).not.toMatch(/not final until/i);
    const s = later.state;
    expect(s.followUp).toMatchObject({ validity: "Good till tonight", contact: "chat", bestTime: "any time" });
    expect(s.followUp.validUntil).toBe("2026-11-22T18:29:00.000Z");
    expect(s.followUp.closedOfferIds).toEqual([s.pendingApproval!.offerId]);
    const asked = (await t.events()).filter((e) => e.type === "question_asked");
    expect(asked).toHaveLength(1);
  });

  it("when they only say how long it stands, the close follows: no second question about reaching them", async () => {
    const t = await setup();
    await t.toPending();
    const validity = await t.say("Good till tonight.", { intent: "other", follow_up: followUp({ valid_until: "2026-11-22T23:59:00+05:30", validity_quote: "Good till tonight" }) });
    expect(validity.reply!.text).toMatch(/not final until/i);
    expect(validity.reply!.text).not.toContain("?");
  });

  it("several details in one message all count, so the close comes straight away", async () => {
    const t = await setup();
    await t.say("I can do ₹19,500.", { intent: "offer", offer_terms: [offer(19_500)] });
    const accepted = await t.say("Yes, good till tonight. Chat me here.", { ...yes, follow_up: followUp({ valid_until: "2026-11-22T23:59:00+05:30", validity_quote: "good till tonight", contact: "chat" }) });
    expect(accepted.state.status).toBe("awaiting_approval");
    expect(accepted.reply!.text).toMatch(/not final until/i);
  });

  it("on a call, only the closing line ends the call, and 'call me' means the line they are calling from", async () => {
    const t = await setup();
    const accepted = await t.toPending("voice");
    expect(accepted.endCall).toBe(false);
    const answer = await t.say("Till tonight. Call me after six.", { intent: "other", follow_up: followUp({ valid_until: "2026-11-22T23:59:00+05:30", validity_quote: "Till tonight", contact: "call", best_time_quote: "after six" }) }, "voice", "+91 98765 43210");
    expect(answer.endCall).toBe(true);
    expect(answer.reply!.text).toMatch(/not final until/i);
    expect(answer.state.followUp).toMatchObject({ contact: "call", phone: "919876543210", bestTime: "after six" });
    // No number was asked for: the caller's own line is the one to call back.
    expect((await t.events()).filter((e) => e.type === "question_asked").map((e) => (e.payload as { text: string }).text).join(" ")).not.toMatch(/What number/);
  });

  it("asks for a number when they want a call but gave none, and the number they give is never read as an offer", async () => {
    const t = await setup();
    await t.toPending();
    const contact = await t.say("Till tonight. Call me.", { intent: "other", follow_up: followUp({ valid_until: "2026-11-22T23:59:00+05:30", validity_quote: "Till tonight", contact: "call" }) });
    expect(contact.reply!.text).toMatch(/What number should I call you on\?/);
    // The reader also took the digits for a price: the number stays a number, and the approval still waits.
    const number = await t.say("9876543210", { intent: "offer", offer_terms: [offer(9_876_543_210)], follow_up: followUp({ phone_number: "9876543210" }) });
    expect(number.state.followUp.phone).toBe("919876543210");
    expect(number.state.status).toBe("awaiting_approval");
    expect(number.reply!.text).toMatch(/not final until/i);
    expect(number.reply!.text).not.toMatch(/9,?876,?543,?210/);
  });
});

describe("the seller decides later, and Kritva follows up", () => {
  it("approve: the buyer is asked again, and only their yes records the agreement", async () => {
    const t = await setup();
    const pending = await t.toPending();
    const approved = await t.engine.respondToApproval({ sessionId: t.sessionId, requestId: pending.state.pendingApproval!.requestId, decision: "approved" });
    if (!approved.ok) throw new Error(approved.message);
    expect(approved.state.status).toBe("active");
    expect(approved.state.outcome.kind).toBe("in_progress");
    expect(approved.reply!.text).toMatch(/^Good news/);
    expect(approved.reply!.text).toContain("₹19,500");
    await t.deliver(approved.reply, "text");
    const agreed = await t.say("Yes, still good.", yes);
    expect(agreed.state.outcome.kind).toBe("agreement");
    const agreementEvent = (await t.events()).find((e) => e.type === "agreement_recorded")!;
    const p = agreementEvent.payload as PayloadOf<"agreement_recorded">;
    const acceptanceSeq = (await t.events()).find((e) => e.id === p.acceptanceId)!.seq;
    const approvalSeq = (await t.events()).find((e) => e.id === p.approvalId)!.seq;
    expect(acceptanceSeq).toBeGreaterThan(approvalSeq);
  });

  it("an offer whose time has passed is re-confirmed first", async () => {
    const t = await setup();
    await t.toPending();
    await t.say("Till 8 tonight.", { intent: "other", follow_up: followUp({ valid_until: "2026-11-22T20:00:00+05:30", validity_quote: "Till 8 tonight" }) });
    t.clock.now = new Date("2026-11-22T16:00:00Z"); // 21:30 in Bangalore
    const s = await t.engine.state(t.sessionId);
    const approved = await t.engine.respondToApproval({ sessionId: t.sessionId, requestId: s.pendingApproval!.requestId, decision: "approved" });
    if (!approved.ok) throw new Error(approved.message);
    expect(approved.reply!.text).not.toMatch(/Good news/);
    expect(approved.reply!.text).toMatch(/still good for you\?/i);
  });

  it("counter: the seller's terms go to the buyer, and their yes starts a new approval", async () => {
    const t = await setup();
    const pending = await t.toPending();
    const countered = await t.engine.respondToApproval({ sessionId: t.sessionId, requestId: pending.state.pendingApproval!.requestId, decision: "countered", counterTerms: [{ termId: terms.price, value: money(20_000) }] });
    if (!countered.ok) throw new Error(countered.message);
    expect(countered.reply!.text).toContain("₹20,000");
    expect(countered.reply!.text).toMatch(/Would that work/);
    await t.deliver(countered.reply, "text");
    const accepted = await t.say("Yes, ₹20,000 works.", yes);
    expect(accepted.state.outcome.kind).toBe("pending_approval");
    expect((await t.events()).filter((e) => e.type === "approval_requested")).toHaveLength(2);
    expect((await t.events()).some((e) => e.type === "agreement_recorded")).toBe(false);
  });

  it("a counter outside the instructions, or the same as the offer, is refused and records nothing", async () => {
    const t = await setup();
    const pending = await t.toPending();
    const before = (await t.events()).length;
    const requestId = pending.state.pendingApproval!.requestId;
    const low = await t.engine.respondToApproval({ sessionId: t.sessionId, requestId, decision: "countered", counterTerms: [{ termId: terms.price, value: money(15_000) }] });
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.code).toBe("invalid_counter");
    const same = await t.engine.respondToApproval({ sessionId: t.sessionId, requestId, decision: "countered", counterTerms: [{ termId: terms.price, value: money(19_500) }] });
    expect(same.ok).toBe(false);
    expect((await t.events()).length).toBe(before);
  });

  it("decline: a kind no, a keep-in-touch question, and their answer is kept", async () => {
    const t = await setup();
    const pending = await t.toPending("voice");
    const declined = await t.engine.respondToApproval({ sessionId: t.sessionId, requestId: pending.state.pendingApproval!.requestId, decision: "declined", message: "Thanks for understanding." });
    if (!declined.ok) throw new Error(declined.message);
    expect(declined.state.outcome.kind).toBe("no_agreement");
    expect(declined.reply!.text).toMatch(/can't do that one/);
    expect(declined.reply!.text).toMatch(/keep your number/);
    expect(findAmounts(declined.reply!.text)).toEqual([]);
    const status = (await t.events()).filter((e) => e.type === "status_changed").at(-1)!.payload as PayloadOf<"status_changed">;
    expect(status.outcome).toBe("declined_by_principal");
    await t.deliver(declined.reply, "voice");
    const answer = await t.say("Sure, keep it.", { intent: "other", follow_up: followUp({ keep_contact: true }) }, "voice");
    expect(answer.state.followUp.keepContact).toBe(true);
    expect(answer.reply!.text).not.toContain("?");
    expect(answer.endCall).toBe(true);
  });

  it("a buyer who asked for a call gets a call-back: no message until the call, then Kritva introduces itself", async () => {
    const t = await setup();
    await t.toPending("voice");
    await t.say("Till tonight.", { intent: "other", follow_up: followUp({ valid_until: "2026-11-22T23:59:00+05:30", validity_quote: "Till tonight" }) }, "voice");
    await t.say("Call me back on this number.", { intent: "other", follow_up: followUp({ contact: "call", use_this_number: true }) }, "voice", "9876543210");
    // The call ended.
    await t.record.append(t.sessionId, { id: "voice_end_1", type: "voice_connection", channel: "voice", payload: { status: "ended", transport: "phone", reason: "server" } }, { kind: "system", partyId: null });
    const s = await t.engine.state(t.sessionId);
    const approved = await t.engine.respondToApproval({ sessionId: t.sessionId, requestId: s.pendingApproval!.requestId, decision: "approved" });
    if (!approved.ok) throw new Error(approved.message);
    expect(approved.followUp).toEqual({ via: "call", phone: "919876543210" });
    expect(approved.reply).toBeNull();

    const opened = await t.engine.followUp({ sessionId: t.sessionId, channel: "voice", callBack: true });
    if (!opened.ok || !opened.reply) throw new Error("no follow-up");
    expect(opened.reply.text).toMatch(/Kritva/);
    expect(opened.reply.text).toContain("₹19,500");
    // Said once only.
    const again = await t.engine.followUp({ sessionId: t.sessionId, channel: "voice", callBack: true });
    expect(again.ok && again.reply).toBeNull();
    await t.deliver(opened.reply, "voice");
    const agreed = await t.say("Yes, still good.", yes, "voice");
    expect(agreed.state.outcome.kind).toBe("agreement");
    expect(agreed.endCall).toBe(true);
  });

  it("changing a term on the follow-up voids the approval", async () => {
    const t = await setup();
    const pending = await t.toPending();
    const approved = await t.engine.respondToApproval({ sessionId: t.sessionId, requestId: pending.state.pendingApproval!.requestId, decision: "approved" });
    if (!approved.ok) throw new Error(approved.message);
    await t.deliver(approved.reply, "text");
    const changed = await t.say("Actually, make it ₹19,000.", { intent: "offer", offer_terms: [offer(19_000)] });
    expect(changed.state.outcome.kind).not.toBe("agreement");
    expect((await t.events()).some((e) => e.type === "agreement_recorded")).toBe(false);
  });

  it("no answer after the retry: the follow-up lapses with no agreement", async () => {
    const t = await setup();
    const pending = await t.toPending();
    await t.engine.respondToApproval({ sessionId: t.sessionId, requestId: pending.state.pendingApproval!.requestId, decision: "approved" });
    const lapsed = await t.engine.lapseFollowUp({ sessionId: t.sessionId });
    if (!lapsed.ok) throw new Error(lapsed.message);
    expect(lapsed.state.outcome.kind).toBe("no_agreement");
    const status = (await t.events()).filter((e) => e.type === "status_changed").at(-1)!.payload as PayloadOf<"status_changed">;
    expect(status.outcome).toBe("lapsed");
  });
});

describe("follow-up details are grounded in their own words", () => {
  const input = (message: string) => ({ view, lastStated: null, conversation: [], message, locale: "en-IN", followUp: { now: new Date("2026-11-22T13:30:00Z"), timeZone: "Asia/Kolkata" } });
  it("keeps quotes, numbers and times only when they are really there", () => {
    const read = readFollowUp(input("Good till tonight, call 98765 43210"), { follow_up: followUp({ valid_until: "2026-11-22T23:59:00+05:30", validity_quote: "Good till tonight", contact: "call", phone_number: "9876543210" }) })!;
    expect(read).toMatchObject({ validity: "Good till tonight", contact: "call", phone: "9876543210" });
    const invented = readFollowUp(input("Sure."), { follow_up: followUp({ valid_until: "2026-11-22T23:59:00+05:30", validity_quote: "till tonight", phone_number: "9876543210", best_time_quote: "after six" }) })!;
    expect(invented).toMatchObject({ validity: null, validUntil: null, phone: null, bestTime: null });
    const far = readFollowUp(input("Good till next year"), { follow_up: followUp({ valid_until: "2027-11-22T23:59:00+05:30", validity_quote: "Good till next year" }) })!;
    expect(far).toMatchObject({ validity: "Good till next year", validUntil: null });
  });
  it("keeps a way to reach them only when they named one", () => {
    expect(readFollowUp(input("It's good till tonight."), { follow_up: followUp({ contact: "chat", validity_quote: "good till tonight" }) })!.contact).toBeNull();
    expect(readFollowUp(input("Just message me here."), { follow_up: followUp({ contact: "chat" }) })!.contact).toBe("chat");
    expect(readFollowUp(input("मुझे कॉल कर दीजिए"), { follow_up: followUp({ contact: "call" }) })!.contact).toBe("call");
  });
  it("reads nothing when no offer is waiting", () => {
    expect(readFollowUp({ ...input("Good till tonight"), followUp: null }, { follow_up: followUp({ validity_quote: "Good till tonight" }) })).toBeUndefined();
  });
});

describe("wording carries the seller's message, and nothing private", () => {
  it("passes the seller's message on through the brief", () => {
    const plan = { move: "end_negotiation", decision: { kind: "end", reason: "t" }, offer: null, acceptanceOf: null, declined: [], refuseDisclosure: false, ignoreAuthorityClaim: false, questions: [], respondingTo: null, notice: null, clarify: [], unresolved: [], ask: null, end: { requestedBy: "principal", reason: "t", unresolved: [], line: null }, followUp: { step: "declined", messageFromPrincipal: "Thanks for understanding." } } as Plan;
    const brief = composeBrief({ view, plan, publicTerms: view.defaultPackage, theirMessage: null, conversation: [], locale: "en-IN", outcome: "no_agreement" });
    expect(brief.follow_up).toMatchObject({ step: "declined", message_from_who_you_represent: "Thanks for understanding." });
    expect((brief.must as string[]).some((m) => m.includes("Thanks for understanding."))).toBe(true);
    expect((brief.must as string[]).some((m) => /decided not to go ahead/.test(m))).toBe(false);
  });
});

describe("the record: approval never closes a deal by itself", () => {
  it("refuses an agreement whose acceptance came before the approval", async () => {
    const { record } = openRecord();
    const started = await record.startSession({ mandate });
    if (!started.ok) throw new Error("start failed");
    const sessionId = started.session.id;
    const final = [{ termId: terms.price, value: money(19_000) }, { termId: terms.pickup, value: { type: "text" as const, value: "Koramangala, Bangalore" } }, { termId: terms.delivery, value: { type: "boolean" as const, value: false } }];
    await mustAppend(record, sessionId, inbound("m1", "I can pay ₹19,000."), BUYER);
    await mustAppend(record, sessionId, proposed("f1", final), AGENT);
    await mustAppend(record, sessionId, outbound("m2", "₹19,000, pickup Koramangala. Confirm?", ["f1"]), AGENT);
    await mustAppend(record, sessionId, delivered("d1", "m2"), SYSTEM);
    await mustAppend(record, sessionId, inbound("m3", "Yes."), BUYER);
    await mustAppend(record, sessionId, acceptance("acc", "f1", "m3", final), AGENT);
    await mustAppend(record, sessionId, approvalRequest("req", "f1", final, "acc"), AGENT);
    await mustAppend(record, sessionId, approvalResponse("apr", "req", "f1", final), SELLER);
    const early = await record.append(sessionId, agreement("agr", "f1", final, "acc", "apr"), AGENT);
    expect(early.ok).toBe(false);
    await mustAppend(record, sessionId, inbound("m4", "Yes, still good."), BUYER);
    await mustAppend(record, sessionId, acceptance("acc2", "f1", "m4", final), AGENT);
    const after = await record.append(sessionId, agreement("agr2", "f1", final, "acc2", "apr"), AGENT);
    expect(after.ok).toBe(true);
  });
});
