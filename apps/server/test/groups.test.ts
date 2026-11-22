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

export function groupSetup(maxOpen = 3) {
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
  const app = createApp({ record, engine, revisions, mandates, locale: "en-IN", library, examples, listings, groups });
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
