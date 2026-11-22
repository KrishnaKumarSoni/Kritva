/** Several counterparties on one deal: routes (docs/Kritva_Multiple_Counterparties.md). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DealGroups,
  MandateLibrary,
  MandateRevisions,
  NegotiationEngine,
  NegotiationRecord,
  SqliteLibraryBackend,
  SqliteRecordBackend,
  type StructuredLlm,
  type StructuredRequest,
  type StructuredResponse,
} from "@kritva/core";
import { createApp } from "../src/app.ts";
import { hangUpPending, type CallView, type Dialer } from "../src/group-routes.ts";
import { loadConfirmedMandates, loadExamples, loadListings } from "../src/main-helpers.ts";

const CASES = resolve(import.meta.dirname, "../../../cases");

class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Array<Record<string, unknown>> = [];
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const reply = (json: unknown) => ({ json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 });
    if (request.purpose === "language_check") return reply({ concerns: [] });
    if (request.purpose === "interpret_counterparty") {
      return reply({ intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, offer_kind: "none", offer_conditions: [], ends_negotiation: false, corrects_previous: false, pressure: "none", notes: [], answers: [], new_terms: [], questions: [], ...this.interpretations.shift() });
    }
    throw new Error("template wording");
  }
}

/** Stands in for the telephony work's dialer: records each call and lets a test move its state. */
class FakeDialer implements Dialer {
  readonly calls: CallView[] = [];
  readonly numbers: string[] = [];
  readonly hungUp: string[] = [];
  async call(input: { sessionId: string; to: string; clientRequestId?: string }) {
    this.numbers.push(input.to);
    const call: CallView = { callId: `call_${this.calls.length + 1}`, sessionId: input.sessionId, to: "91******2345", state: "ringing", outcome: null, startedAt: new Date().toISOString() };
    this.calls.push(call);
    return { ok: true as const, call };
  }
  listForSession(sessionId: string) {
    return this.calls.filter((c) => c.sessionId === sessionId);
  }
  async hangup(callId: string) {
    this.hungUp.push(callId);
    const c = this.calls.find((x) => x.callId === callId);
    if (c) Object.assign(c, { state: "ended", outcome: "cancelled" });
  }
}

export function groupSetup(maxOpen = 3, dialer: Dialer | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "kritva-groups-"));
  const db = join(dir, "db.sqlite");
  const record = new NegotiationRecord(new SqliteRecordBackend(db));
  const llm = new ScriptedLlm();
  const mandates = loadConfirmedMandates(CASES);
  const examples = loadExamples(CASES);
  const library = new MandateLibrary({ backend: new SqliteLibraryBackend(db), mappingLlm: llm });
  const listings = loadListings(CASES, mandates, examples, library);
  const groups = new DealGroups(record, { maxOpen });
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", subjectFacts: new Map([["bed-sale", "fact_f_item"]]), listingDetails: new Map(listings.map((l) => [l.caseId, l])), groups });
  const revisions = new MandateRevisions({ record, engine, mappingLlm: llm });
  const app = createApp({ record, engine, revisions, mandates, locale: "en-IN", library, examples, listings, groups, dialer });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
  const mandateId = listings.find((l) => l.caseId === "bed-sale")!.libraryId;
  const priceTerm = library.active(mandateId)!.mandate.terms.find((t) => t.valueType === "money")!.id;
  const offer = (amount: number, extra: Record<string, unknown> = {}) => ({ intent: "offer", offer_kind: "offer", offer_terms: [{ term_id: priceTerm, value: { type: "money", amount, currency: null, unit: null, text: null, boolean: null } }], ...extra });
  let n = 0;
  const callSeller = () => call("POST", "/api/public/listings/bed-sale/call", { clientCallId: `call-${(n += 1)}-${Date.now()}` });
  const say = (sessionId: string, text: string, interp: Record<string, unknown> = {}) => {
    llm.interpretations.push(interp);
    return call("POST", `/api/buyer/sessions/${sessionId}/messages`, { text, clientMessageId: `m-${(n += 1)}-${Date.now()}` });
  };
  return { record, engine, llm, groups, library, call, callSeller, mandateId, offer, say };
}

describe("several counterparties: starting negotiations", () => {
  it("lists counterparties on the mandate, starts one negotiation each, and gives each a link", async () => {
    const { call, mandateId, groups } = groupSetup();
    expect((await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Ravi", phone: "98450 12345" })).status).toBe(201);
    expect((await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Asha" })).status).toBe(201);
    const started = await call("POST", `/api/operator/library/${mandateId}/start`);
    expect(started.status).toBe(201);
    expect(started.json.started).toHaveLength(2);
    expect(started.json.entries.every((e: { open: boolean; sessionId: string }) => e.open && e.sessionId)).toBe(true);
    // Starting again starts nobody twice.
    expect((await call("POST", `/api/operator/library/${mandateId}/start`)).json.started).toHaveLength(0);
    expect(groups.latestFor(mandateId)!.members).toHaveLength(2);
  });

  it("a listing call joins the same group, and the cap turns away one more", async () => {
    const { call, callSeller, mandateId, groups } = groupSetup(2);
    await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Ravi" });
    await call("POST", `/api/operator/library/${mandateId}/start`);
    const walkIn = await callSeller();
    expect(walkIn.status).toBe(201);
    const third = await callSeller();
    expect(third.status).toBe(409);
    expect(third.json.error).toBe("busy");
    expect(groups.latestFor(mandateId)!.members.map((m) => m.via)).toEqual(["link", "listing"]);
  });

  it("caps the list at the deployment's limit", async () => {
    const { call, mandateId } = groupSetup(1);
    await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Ravi" });
    const second = await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Asha" });
    expect(second.status).toBe(409);
    expect(second.json.message).toContain("up to 1");
  });
});

describe("several counterparties: the board", () => {
  it("shows one row per counterparty with the best offer starred and offers outside the limits flagged", async () => {
    const { call, mandateId, say, offer } = groupSetup();
    await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Ravi" });
    await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Asha" });
    await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Meera" });
    const started = (await call("POST", `/api/operator/library/${mandateId}/start`)).json.started as Array<{ sessionId: string }>;
    const [ravi, asha, meera] = started.map((s) => s.sessionId);
    await say(ravi!, "I can do 19,500", offer(19_500));
    await say(asha!, "18,500?", offer(18_500));
    await say(meera!, "15,000", offer(15_000));
    const board = await call("GET", `/api/operator/library/${mandateId}/board`);
    expect(board.status).toBe(200);
    const row = (name: string) => board.json.rows.find((r: { name: string }) => r.name === name);
    expect(row("Ravi").best).toBe(true);
    expect(row("Ravi").offer.amount).toBe("₹19,500");
    expect(row("Ravi").gap).toBe("₹1,500 above your floor");
    expect(row("Meera").flag).toBe("outside_limits");
    expect(row("Meera").gap).toBe("₹3,000 below your floor");
    expect(board.json.counters).toMatchObject({ negotiationsRun: 3, dealsOutsideLimits: 0 });
  });
});

describe("several counterparties: the lock", () => {
  it("approving one counterparty's accepted terms closes the deal for the others", async () => {
    const { call, mandateId, say, offer, engine, record } = groupSetup();
    await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Ravi" });
    await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Asha" });
    const [ravi, asha] = ((await call("POST", `/api/operator/library/${mandateId}/start`)).json.started as Array<{ sessionId: string }>).map((s) => s.sessionId);
    const acceptAtAsking = async (id: string) => {
      const stated = await say(id!, "I'll pay 20,000", offer(20_000));
      await call("POST", `/api/buyer/sessions/${id}/deliveries`, { messageId: stated.json.reply.messageId });
      const accepted = await say(id!, "Yes, I confirm.", { intent: "accept_stated_terms", accepts_stated_terms: true });
      await call("POST", `/api/buyer/sessions/${id}/deliveries`, { messageId: accepted.json.reply.messageId });
      return (await call("GET", `/api/operator/sessions/${id}`)).json.state.pendingApproval;
    };
    const pr = await acceptAtAsking(ravi!);
    const pa = await acceptAtAsking(asha!);
    expect((await call("POST", `/api/operator/sessions/${ravi}/approvals/${pr.requestId}`, { decision: "approved", offerId: pr.offerId, mandateRevision: pr.mandateRevision })).status).toBe(200);
    await engine.settled();
    const second = await call("POST", `/api/operator/sessions/${asha}/approvals/${pa.requestId}`, { decision: "approved", offerId: pa.offerId, mandateRevision: pa.mandateRevision });
    expect(second.status).toBe(409);
    expect(second.json.message).toMatch(/another counterparty/);
    expect((await record.context(asha!)).status).toBe("no_agreement");
    const board = (await call("GET", `/api/operator/library/${mandateId}/board`)).json;
    expect(board.concluded.name).toBe("Ravi");
    expect(board.rows.find((r: { name: string }) => r.name === "Asha").status).toBe("closed_elsewhere");
  });
});

describe("several counterparties: Kritva calls them", () => {
  it("starting negotiations calls everyone with a number, and the board shows each call", async () => {
    const dialer = new FakeDialer();
    const { call, mandateId } = groupSetup(3, dialer);
    await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Ravi", phone: "98450 12345" });
    await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Asha" });
    const started = await call("POST", `/api/operator/library/${mandateId}/start`);
    expect(started.json.calls).toEqual([expect.objectContaining({ ok: true })]);
    expect(dialer.numbers).toEqual(["9845012345"]);
    const board = (await call("GET", `/api/operator/library/${mandateId}/board`)).json;
    expect(board.canCall).toBe(true);
    const row = (name: string) => board.rows.find((r: { name: string }) => r.name === name);
    expect(row("Ravi").call).toMatchObject({ state: "ringing", to: "91******2345" });
    expect(row("Asha").call).toBeNull();
    // No number ever reaches the board unmasked.
    expect(JSON.stringify(board)).not.toContain("9845012345");
  });

  it("calls one counterparty again, and stops unanswered calls when the deal goes elsewhere", async () => {
    const dialer = new FakeDialer();
    const { call, mandateId } = groupSetup(3, dialer);
    const entry = (await call("POST", `/api/operator/library/${mandateId}/counterparties`, { name: "Ravi", phone: "98450 12345" })).json.entry;
    const again = await call("POST", `/api/operator/library/${mandateId}/counterparties/${entry.id}/call`, { clientRequestId: "again-1" });
    expect(again.status).toBe(202);
    await hangUpPending(dialer, again.json.call.sessionId);
    expect(dialer.hungUp).toEqual([again.json.call.callId]);
  });
});
