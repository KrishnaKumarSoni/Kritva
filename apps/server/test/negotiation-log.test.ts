/** The principal's negotiation log (GET /api/operator/negotiations). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MandateRevisions, NegotiationEngine, NegotiationRecord, SqliteRecordBackend, type StructuredLlm, type StructuredRequest, type StructuredResponse } from "@kritva/core";
import { createApp } from "../src/app.ts";
import { loadConfirmedMandates } from "../src/main-helpers.ts";

const CASES = resolve(import.meta.dirname, "../../../cases");

class NoLlm implements StructuredLlm {
  async generate(_request: StructuredRequest): Promise<StructuredResponse> {
    throw new Error("not used");
  }
}

function setup() {
  const record = new NegotiationRecord(new SqliteRecordBackend(join(mkdtempSync(join(tmpdir(), "kritva-log-")), "db.sqlite")));
  const llm = new NoLlm();
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN" });
  const mandates = loadConfirmedMandates(CASES);
  const app = createApp({ record, engine, revisions: new MandateRevisions({ record, engine, mappingLlm: llm }), mandates, locale: "en-IN" });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { record, call, mandates };
}

describe("Negotiation log", () => {
  it("lists a console test, and a phone call in with its length, most recent activity first", async () => {
    const { record, call, mandates } = setup();
    const test = (await call("POST", "/api/operator/sessions", { mandateId: "bed-sale/demo" })).json.session.id as string;
    const phone = (await call("POST", "/api/operator/sessions", { mandateId: "bed-sale/demo" })).json.session.id as string;
    const actor = { kind: "system" as const, partyId: null };
    await record.append(phone, { id: "voice_a", type: "voice_connection", channel: "voice", payload: { status: "connected", transport: "phone", direction: "inbound" } }, actor);
    await record.append(phone, { id: "voice_b", type: "voice_connection", channel: "voice", payload: { status: "ended", transport: "phone", reason: "hung_up", direction: "inbound" } }, actor);

    const rows = (await call("GET", "/api/operator/negotiations")).json as any[];
    expect(rows.map((r) => r.sessionId)).toEqual([phone, test]);
    const title = mandates.find((m) => m.id === "bed-sale/demo")!.title;
    expect(rows[1]).toMatchObject({ origin: "test", counterparty: null, status: "active", messages: 0, calls: { count: 0, seconds: 0 }, live: false, mandate: { title } });
    expect(rows[0]).toMatchObject({ origin: "phone_in", channels: ["phone"], calls: { count: 1 } });
    // Nothing about a phone number reaches the log.
    expect(JSON.stringify(rows)).not.toMatch(/\+?\d{10,}/);
  });
});
