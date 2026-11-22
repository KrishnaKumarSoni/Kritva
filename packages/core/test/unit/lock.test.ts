/** The deal lock across counterparties: the first approval wins, the others are closed politely. */
import { describe, expect, it } from "vitest";
import type { StructuredLlm, StructuredRequest, StructuredResponse } from "../../src/llm/types.ts";
import { NegotiationEngine } from "../../src/negotiation/engine.ts";
import { readMandate } from "../../src/negotiation/mandate-view.ts";
import { projectState } from "../../src/negotiation/state.ts";
import { contactState } from "../../src/negotiation/board.ts";
import { DealGroups } from "../../src/record/groups.ts";
import type { PayloadOf } from "../../src/record/events.ts";
import { demoTerms, loadDemoMandate, openRecord } from "../support/record.ts";

const mandate = loadDemoMandate();
const terms = demoTerms(mandate);
const n = readMandate(mandate).negotiable!;

class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Array<Record<string, unknown>> = [];
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const reply = (json: unknown) => ({ json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 });
    if (request.purpose === "interpret_counterparty") return reply({ intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, questions: [], ...this.interpretations.shift() });
    if (request.purpose === "language_check") return reply({ concerns: [] });
    throw new Error("template wording");
  }
}

async function setup(options: { contactFor?: (id: string) => string | null } = {}) {
  const { record } = openRecord();
  const groups = new DealGroups(record, { maxOpen: 5 });
  const llm = new ScriptedLlm();
  const concluded: string[] = [];
  const closedElsewhere: string[] = [];
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", groups, onDealConcluded: (e) => void concluded.push(e.sessionId), onSessionClosedElsewhere: (id) => void closedElsewhere.push(id), contactFor: options.contactFor });
  const start = async () => {
    const r = await groups.start({ mandate, mandateSource: { mandateId: "m_demo", revision: 1 }, entryId: null, via: "link" });
    if (!r.ok) throw new Error(r.message);
    return r.sessionId;
  };
  const say = async (sessionId: string, text: string, interp: Record<string, unknown> = {}) => {
    llm.interpretations.push(interp);
    const r = await engine.handleCounterpartyMessage({ sessionId, text, channel: "text" });
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    if (r.reply) await engine.reportDelivery({ sessionId, messageId: r.reply.messageId, channel: "text", status: "delivered" });
    return r;
  };
  /** Offers the asking price, then accepts the complete terms Kritva states: the approval request follows. */
  const acceptAtAsking = async (sessionId: string) => {
    await say(sessionId, `I'll pay ${n.opening}`, { intent: "offer", offer_kind: "offer", offer_terms: [{ term_id: terms.price, value: { type: "money", amount: n.opening, currency: null, unit: null, text: null, boolean: null } }] });
    await say(sessionId, "Yes, I confirm those terms.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    const state = projectState(await record.context(sessionId));
    if (!state.pendingApproval) throw new Error(`no approval request (status ${state.status})`);
    return state.pendingApproval;
  };
  const approve = async (sessionId: string, requestId: string) => {
    const r = await engine.respondToApproval({ sessionId, requestId, decision: "approved" });
    if (r.ok && r.reply) await engine.reportDelivery({ sessionId, messageId: r.reply.messageId, channel: "text", status: "delivered" });
    return r;
  };
  /** After the principal's approval, the counterparty says yes again: only that records the agreement. */
  const confirm = (sessionId: string) => say(sessionId, "Yes, still good.", { intent: "accept_stated_terms", accepts_stated_terms: true });
  /** Approve, then their yes. */
  const agree = async (sessionId: string, requestId: string) => {
    const r = await approve(sessionId, requestId);
    if (!r.ok) throw new Error(r.message);
    await confirm(sessionId);
  };
  return { record, groups, engine, start, say, acceptAtAsking, approve, confirm, agree, concluded, closedElsewhere };
}

describe("the deal lock", () => {
  it("the first approval holds the deal; a second is refused; their yes closes the other politely", async () => {
    const { record, engine, start, acceptAtAsking, approve, confirm, groups, concluded, closedElsewhere } = await setup();
    const a = await start();
    const b = await start();
    const ra = await acceptAtAsking(a);
    const rb = await acceptAtAsking(b);
    const first = await approve(a, ra.requestId);
    expect(first.ok).toBe(true);
    expect(groups.groupOf(a)!.reservation?.sessionId).toBe(a);
    const second = await approve(b, rb.requestId);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.message).toMatch(/holds this deal/);
    // Nothing was recorded for the refused approval.
    expect((await record.read(b, { viewer: "operator" })).some((e) => e.type === "approval_responded")).toBe(false);
    await confirm(a);
    await engine.settled();
    expect((await record.context(a)).status).toBe("agreed");
    expect((await record.context(b)).status).toBe("no_agreement");
    expect(groups.groupOf(a)!.concluded?.sessionId).toBe(a);
    expect(concluded).toEqual([a]);
    expect(closedElsewhere).toEqual([b]);
    const closing = (await record.read(b, { viewer: "counterparty" })).filter((e) => e.type === "message").at(-1)!.payload as PayloadOf<"message">;
    expect(closing.direction).toBe("outbound");
    expect(closing.text).toMatch(/agreed terms with someone else/);
    expect(closing.text).toMatch(/number/);
    expect(closing.text).not.toMatch(/\d/);
  });

  it("records their yes and the number they give, then thanks them", async () => {
    const { record, engine, start, acceptAtAsking, agree, say } = await setup();
    const a = await start();
    const b = await start();
    const ra = await acceptAtAsking(a);
    await agree(a, ra.requestId);
    await engine.settled();
    const reply = await say(b, "Yes please, it's 98450 12345");
    expect(reply.reply!.text).toMatch(/noted/);
    expect(contactState(await record.context(b))).toBe("kept");
    const noted = (await record.read(b, { viewer: "operator" })).findLast((e) => e.type === "follow_up_noted")!.payload as { keepContact: boolean; phone: string };
    expect(noted).toMatchObject({ keepContact: true, phone: "9845012345" });
  });

  it("on a phone call, a yes keeps the caller's number; a no is respected", async () => {
    const { record, engine, start, acceptAtAsking, agree, say } = await setup({ contactFor: () => "919845012345" });
    const a = await start();
    const b = await start();
    const c = await start();
    await agree(a, (await acceptAtAsking(a)).requestId);
    await engine.settled();
    await say(b, "Sure, go ahead");
    expect(contactState(await record.context(b))).toBe("kept");
    await say(c, "No thanks");
    expect(contactState(await record.context(c))).toBe("declined");
  });

  it("a new start after the deal concluded is refused", async () => {
    const { engine, start, acceptAtAsking, agree, groups } = await setup();
    const a = await start();
    await agree(a, (await acceptAtAsking(a)).requestId);
    await engine.settled();
    expect(await groups.start({ mandate, mandateSource: { mandateId: "m_demo", revision: 1 }, entryId: null, via: "listing" })).toMatchObject({ ok: false, code: "concluded" });
  });
});

describe("a call Kritva places", () => {
  it("opens by saying who is calling and asking if now is a good time", async () => {
    const { engine, start } = await setup();
    const a = await start();
    const greeted = await engine.greet({ sessionId: a, channel: "voice", outbound: true });
    expect(greeted.ok && greeted.reply?.text).toMatch(/calling about .*good time to talk\?/);
  });
});
