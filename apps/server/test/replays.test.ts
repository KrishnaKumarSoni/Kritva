/**
 * Repeatable live chat regressions: each recorded live conversation in cases/<case>/replays is
 * replayed through the same routes and case configuration as the running app, with the recorded
 * model responses. Every turn must deliver the same reply and record the same decision and offer.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MandateRevisions, NegotiationEngine, NegotiationRecord, readMandate, SqliteRecordBackend } from "@kritva/core";
import { createApp } from "../src/app.ts";
import { checkTurn, playTurns, ReplayLlm, type ReplayFixture } from "../src/eval/replay.ts";
import { loadCaseRuntime } from "../src/main-helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const runtime = loadCaseRuntime(ROOT, null);
const fixtures: ReplayFixture[] = readdirSync(join(ROOT, "cases"), { withFileTypes: true })
  .filter((dir) => dir.isDirectory() && existsSync(join(ROOT, "cases", dir.name, "replays")))
  .flatMap((dir) => {
    const folder = join(ROOT, "cases", dir.name, "replays");
    return readdirSync(folder).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(folder, f), "utf8")) as ReplayFixture);
  });

async function replay(fixture: ReplayFixture) {
  const record = new NegotiationRecord(new SqliteRecordBackend(join(mkdtempSync(join(tmpdir(), "kritva-replay-")), "db.sqlite")));
  const llm = new ReplayLlm(fixture.calls);
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", guidance: runtime.defaultGuidance, guidanceByCase: runtime.guidanceByCase, subjectFacts: runtime.subjectFacts, listingDetails: runtime.listingDetails });
  const revisions = new MandateRevisions({ record, engine, mappingLlm: llm });
  const app = createApp({ record, engine, revisions, mandates: runtime.mandates, locale: "en-IN", listings: runtime.listings });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const created = await call("POST", "/api/operator/sessions", { mandateId: fixture.mandate });
  const sessionId = created.json.session.id as string;
  const entry = runtime.mandates.find((m) => m.id === fixture.mandate)!;
  const played = await playTurns(call, record, sessionId, fixture.turns, readMandate(entry.mandate).negotiable?.termId ?? null);
  return { ...played, llm, record, sessionId, call };
}

describe("Recorded live chat conversations replay turn by turn", () => {
  it("has the recorded conversations checked in", () => {
    expect(fixtures.map((f) => f.scenario)).toEqual(expect.arrayContaining(["budget-ceiling-pressure", "collect-myself-agreement", "transport-budget-final", "delivery-only", "cheaper-elsewhere", "availability-to-budget"]));
  });

  for (const fixture of fixtures) {
    it(`${fixture.scenario}: every turn delivers the recorded reply and records the same decision`, async () => {
      const { observed, error, llm } = await replay(fixture);
      expect(error).toBeNull();
      expect(observed).toHaveLength(fixture.observed.length);
      fixture.observed.forEach((recorded, i) => {
        const now = observed[i]!;
        expect({ turn: i + 1, reply: now.reply, offer: now.offerAmount, decision: now.decision }).toEqual({ turn: i + 1, reply: recorded.reply, offer: recorded.offerAmount, decision: recorded.decision });
        const turn = fixture.turns[i]!;
        // The scenario's own expectations still hold on the replayed turn.
        if ("buyer" in turn) expect(checkTurn(turn.expect, now)).toEqual([]);
      });
      expect(llm.unused()).toEqual({});
    });
  }

  it("the buyer's view of a replayed conversation carries no private events", async () => {
    const fixture = fixtures.find((f) => f.scenario === "collect-myself-agreement");
    if (!fixture) return;
    const { record, sessionId } = await replay(fixture);
    const buyer = await record.read(sessionId, { viewer: "counterparty" });
    expect(buyer.every((e) => e.visibility === "public")).toBe(true);
    expect(JSON.stringify(buyer)).not.toMatch(/allowance|₹18,000/);
  });

  it("the agreement replay ends with the seller's approval, payment and pickup still pending", async () => {
    const fixture = fixtures.find((f) => f.scenario === "collect-myself-agreement");
    if (!fixture) return;
    const { call, sessionId } = await replay(fixture);
    const commitments = (await call("GET", `/api/operator/sessions/${sessionId}`)).json.commitments;
    expect(commitments.outcome).toBe("agreement");
    expect(commitments.agreement).toMatchObject({ approved: true });
    expect(commitments.agreement.obligations.join(" ")).toMatch(/pay/i);
  });
});
