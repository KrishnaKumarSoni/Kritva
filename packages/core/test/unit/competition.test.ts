/** Competition between counterparties for one deal: the moving limit and citing a real offer. */
import { describe, expect, it } from "vitest";
import type { StructuredLlm, StructuredRequest, StructuredResponse } from "../../src/llm/types.ts";
import { NegotiationEngine } from "../../src/negotiation/engine.ts";
import { readMandate } from "../../src/negotiation/mandate-view.ts";
import { checkReply } from "../../src/negotiation/reply-check.ts";
import type { Plan } from "../../src/negotiation/policy.ts";
import { validateConfirmedMandate } from "../../src/mandate/confirm.ts";
import { DealGroups } from "../../src/record/groups.ts";
import type { PayloadOf, RecordedEvent } from "../../src/record/events.ts";
import type { ConfirmedMandate } from "../../src/schema/records.ts";
import { demoTerms, loadDemoMandate, openRecord } from "../support/record.ts";

const base = loadDemoMandate();
const terms = demoTerms(base);
const n = readMandate(base).negotiable!;
const ALLOW = "If someone else has made a real offer, you may mention it.";

/** The demo mandate without any grant to mention other offers. */
function silentMandate(): ConfirmedMandate {
  const m = structuredClone(base) as ConfirmedMandate;
  m.permissions = m.permissions.filter((p) => p.action !== "mention_other_offers");
  const checked = validateConfirmedMandate(m);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.mandate;
}

/** A mandate with an explicit grant to mention other real offers. */
function citingMandate(): ConfirmedMandate {
  const m = silentMandate();
  const source = m.sources.find((s) => s.disclosure === "private")!;
  if (!source.text.includes(ALLOW)) source.text = `${source.text} ${ALLOW}`;
  m.permissions.push({ id: "permission_mention_offers", status: "stated", disclosure: "private", sourceRefs: [{ sourceId: source.id, quote: ALLOW }], partyId: m.parties.find((p) => p.isPrincipal)!.id, action: "mention_other_offers", mode: "autonomous", termIds: [], description: "The agent may mention another real offer.", conditionIds: [] });
  const checked = validateConfirmedMandate(m);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.mandate;
}

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

async function setup(mandate: ConfirmedMandate = base, withGroups = true) {
  const { record } = openRecord();
  const groups = new DealGroups(record, { maxOpen: 5 });
  const llm = new ScriptedLlm();
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", groups: withGroups ? groups : null });
  const start = async () => {
    const r = await groups.start({ mandate, mandateSource: { mandateId: "m_demo", revision: 1 }, entryId: null, via: "link" });
    if (!r.ok) throw new Error(r.message);
    return r.sessionId;
  };
  const offer = async (sessionId: string, amount: number) => {
    llm.interpretations.push(offerInterp(amount));
    const r = await engine.handleCounterpartyMessage({ sessionId, text: `I can offer ${amount}`, channel: "text" });
    if (!r.ok) throw new Error(r.message);
    if (r.reply) await engine.reportDelivery({ sessionId, messageId: r.reply.messageId, channel: "text", status: "delivered" });
    return r;
  };
  const lastDecision = async (sessionId: string) => (await record.read(sessionId, { viewer: "operator" })).findLast((e: RecordedEvent) => e.type === "decision")!.payload as PayloadOf<"decision">;
  const offersMade = async (sessionId: string) =>
    (await record.read(sessionId, { viewer: "operator" })).filter((e) => e.type === "offer_proposed").map((e) => ((e.payload as PayloadOf<"offer_proposed">).terms.find((t) => t.termId === terms.price)!.value as { amount: number }).amount);
  return { record, engine, start, offer, lastDecision, offersMade };
}

describe("a better live offer from another counterparty", () => {
  it("stops Kritva countering below it, and the decision records why", async () => {
    const { start, offer, offersMade, lastDecision } = await setup();
    const a = await start();
    const b = await start();
    const rival = n.opening - 100;
    await offer(b, rival);
    for (const amount of [n.limit + 500, n.limit + 600, n.limit + 700]) await offer(a, amount);
    const made = await offersMade(a);
    expect(made.every((amount) => amount >= rival)).toBe(true);
    expect((await lastDecision(a)).competition).toMatchObject({ limit: rival });
  });

  it("without the group, the same offers would be countered lower (control)", async () => {
    const { start, offer, offersMade } = await setup(base, false);
    const a = await start();
    const b = await start();
    await offer(b, n.opening - 100);
    for (const amount of [n.limit + 500, n.limit + 600, n.limit + 700]) await offer(a, amount);
    expect(Math.min(...(await offersMade(a)))).toBeLessThan(n.opening - 100);
  });

  it("never walks away from an offer within the mandate because another one is better", async () => {
    const { start, offer, record } = await setup();
    const a = await start();
    const b = await start();
    await offer(b, n.opening - 100);
    for (const amount of [n.limit + 500, n.limit + 500, n.limit + 500, n.limit + 500]) await offer(a, amount);
    expect((await record.context(a)).status).toBe("active");
  });

  it("is mentioned only when the mandate allows it", async () => {
    const plain = await setup(silentMandate());
    const a1 = await plain.start();
    const b1 = await plain.start();
    await plain.offer(b1, n.limit + 1_500);
    await plain.offer(a1, n.limit + 500);
    expect((await plain.lastDecision(a1)).competition?.cited ?? null).toBeNull();

    const citing = await setup(citingMandate());
    const a2 = await citing.start();
    const b2 = await citing.start();
    await citing.offer(b2, n.limit + 1_500);
    await citing.offer(a2, n.limit + 500);
    expect((await citing.lastDecision(a2)).competition?.cited).toBe(n.limit + 1_500);
  });
});

describe("the reply check on competing offers", () => {
  const view = readMandate(base);
  const plan = (move: Plan["move"], competingAmount?: number): Plan => ({ move, decision: { kind: "hold", reason: "test" }, offer: null, acceptanceOf: null, declined: [], refuseDisclosure: false, ignoreAuthorityClaim: false, questions: [], respondingTo: null, notice: null, clarify: [], unresolved: [], ask: null, ...(competingAmount === undefined ? {} : { competingAmount }) });
  const rules = (text: string, p: Plan) => checkReply(text, { view, plan: p, counterpartyAmounts: [] }).map((v) => v.rule);

  it("blocks a competing offer that does not exist", () => {
    expect(rules("I already have another offer, so I'll stay where I am.", plan("hold"))).toContain("invented_competition");
    expect(rules("Someone else is interested too.", plan("hold"))).toContain("invented_competition");
  });

  it("allows the real one, and blocks a higher figure for it", () => {
    const real = n.limit + 1_500;
    expect(rules(`I already have another offer of ₹${real.toLocaleString("en-IN")}.`, plan("hold", real))).not.toContain("invented_competition");
    expect(rules(`I already have another offer of ₹${n.opening.toLocaleString("en-IN")}.`, plan("hold", real))).toContain("invented_competition");
  });

  it("for a principal buying, blocks a lower figure than the real quote", () => {
    const buying = { ...view, negotiable: { ...view.negotiable!, direction: "down" as const } };
    const checked = (text: string) => checkReply(text, { view: buying, plan: plan("hold", 15_000), counterpartyAmounts: [] }).map((v) => v.rule);
    expect(checked("I have another quote of ₹15,000.")).not.toContain("invented_competition");
    expect(checked("I have another quote of ₹12,000.")).toContain("invented_competition");
  });

  it("lets Kritva answer the counterparty's own claim about an alternative", () => {
    expect(rules("Is the other offer for the same condition and pickup?", plan("compare_terms"))).not.toContain("invented_competition");
  });
});
