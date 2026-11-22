/** The offer board: latest offers, scores, limits and the best, in both directions. */
import { describe, expect, it } from "vitest";
import type { StructuredLlm, StructuredRequest, StructuredResponse } from "../../src/llm/types.ts";
import { NegotiationEngine } from "../../src/negotiation/engine.ts";
import { readMandate } from "../../src/negotiation/mandate-view.ts";
import { projectState } from "../../src/negotiation/state.ts";
import { latestOffer, projectBoard, scoreOffer } from "../../src/negotiation/board.ts";
import { DealGroups } from "../../src/record/groups.ts";
import { demoTerms, loadDemoMandate, money, openRecord } from "../support/record.ts";

const mandate = loadDemoMandate();
const view = readMandate(mandate);
const terms = demoTerms(mandate);
const n = view.negotiable!;

class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Array<Record<string, unknown>> = [];
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const reply = (json: unknown) => ({ json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 });
    if (request.purpose === "interpret_counterparty") return reply({ intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, questions: [], ...this.interpretations.shift() });
    if (request.purpose === "language_check") return reply({ concerns: [] });
    throw new Error("template wording");
  }
}

const offerInterp = (amount: number) => ({ intent: "offer", offer_kind: "offer", offer_terms: [{ term_id: terms.price, value: { type: "money", amount, currency: null, unit: null, text: null, boolean: null } }] });

async function setup() {
  const { record } = openRecord();
  const groups = new DealGroups(record, { maxOpen: 5 });
  const llm = new ScriptedLlm();
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", groups });
  const start = async () => {
    const r = await groups.start({ mandate, mandateSource: { mandateId: "m_demo", revision: 1 }, entryId: null, via: "link" });
    if (!r.ok) throw new Error(r.message);
    return r.sessionId;
  };
  const offer = async (sessionId: string, amount: number) => {
    llm.interpretations.push(offerInterp(amount));
    const r = await engine.handleCounterpartyMessage({ sessionId, text: `I can offer ${amount}`, channel: "text" });
    if (!r.ok) throw new Error(r.message);
  };
  const board = async () => {
    const g = groups.latestFor("m_demo")!;
    const rows = await Promise.all(g.members.map(async (m) => {
      const ctx = await record.context(m.sessionId);
      return { sessionId: m.sessionId, state: projectState(ctx), ctx, entry: null, via: m.via };
    }));
    return projectBoard(rows, groups.latestFor("m_demo")!);
  };
  return { record, start, offer, board };
}

describe("offer board", () => {
  it("stars the best offer within limits, flags one outside them, and shows the gap to the limit", async () => {
    const { start, offer, board, record } = await setup();
    const a = await start();
    const b = await start();
    const c = await start();
    await offer(a, n.limit + 500);
    await offer(b, n.limit + 1_500);
    await offer(c, n.limit - 3_000);
    const result = await board();
    const row = (id: string) => result.rows.find((r) => r.sessionId === id)!;
    expect(result.bestSessionId).toBe(b);
    expect(row(b).best).toBe(true);
    expect(row(c).flag).toBe("outside_limits");
    expect(row(c).score).toBeNull();
    expect(row(a).gap).toBe(500);
    expect(row(c).gap).toBe(-3_000);
    expect(result.counters).toEqual({ negotiationsRun: 3, timeMs: 0, dealsOutsideLimits: 0 });
    const latest = latestOffer(projectState(await record.context(b)), await record.context(b))!;
    expect(latest.amount).toBe(n.limit + 1_500);
    expect(latest.terms.length).toBeGreaterThan(1);
  });

  it("a counterparty who has not written yet shows as not started", async () => {
    const { start, board } = await setup();
    const a = await start();
    expect((await board()).rows.find((r) => r.sessionId === a)!.status).toBe("not_started");
  });
});

describe("offer score", () => {
  const pkg = (amount: number) => [{ termId: terms.price, value: money(amount) }];

  it("rates a higher price better when the principal wants a higher value", () => {
    expect(scoreOffer(view, pkg(n.limit + 1_500)).score).toBeGreaterThan(scoreOffer(view, pkg(n.limit + 500)).score);
    expect(scoreOffer(view, pkg(n.opening)).score).toBe(1);
    expect(scoreOffer(view, pkg(n.limit)).score).toBe(0);
  });

  it("rates a lower price better when the principal wants a lower value", () => {
    const buying = { ...view, negotiable: { ...n, direction: "down" as const, opening: 10_000, limit: 15_000 } };
    expect(scoreOffer(buying, pkg(11_000)).score).toBeGreaterThan(scoreOffer(buying, pkg(14_000)).score);
    expect(scoreOffer(buying, pkg(10_000)).score).toBe(1);
  });
});
