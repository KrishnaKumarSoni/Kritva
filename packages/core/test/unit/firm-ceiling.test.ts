/** Convergence: a firm ceiling inside the mandate gets complete terms at it, never an endless hold. */
import { describe, expect, it } from "vitest";
import type { StructuredLlm, StructuredRequest, StructuredResponse } from "../../src/llm/types.ts";
import { NegotiationEngine } from "../../src/negotiation/engine.ts";
import { demoTerms, loadDemoMandate, openRecord } from "../support/record.ts";

const mandate = loadDemoMandate();
const terms = demoTerms(mandate);
const money = (amount: number) => ({ type: "money", amount, currency: null, unit: null, text: null, boolean: null });
const budget = (quote: string, amount: number, pressure = "none") => ({ intent: "other", offer_kind: "budget_ceiling", pressure, notes: [{ kind: "budget", quote, summary: "Stated ceiling.", term_id: terms.price, value: money(amount), condition: null, basis: "stated" }] });

class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Array<Record<string, unknown>> = [];
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
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN" });
  const say = async (text: string, interp: Record<string, unknown>) => {
    llm.interpretations.push(interp);
    const r = await engine.handleCounterpartyMessage({ sessionId: started.session.id, text, channel: "voice" });
    if (!r.ok) throw new Error(r.message);
    if (r.reply) await engine.reportDelivery({ sessionId: started.session.id, messageId: r.reply.messageId, channel: "voice", status: "delivered" });
    return { kind: (r.events.findLast((e) => e.type === "decision")?.payload as { kind: string }).kind, text: r.reply?.text ?? "" };
  };
  return { say };
}

describe("A firm ceiling inside the mandate converges", () => {
  it("said as final, it gets complete terms at it straight away", async () => {
    const t = await setup();
    expect((await t.say("मेरा budget तो 17,000 का है.", budget("मेरा budget तो 17,000 का है.", 17_000))).kind).toBe("counter");
    const firm = await t.say("मेरा बेस्ट 18000 है, उससे ऊपर नहीं जा सकता मैं।", budget("मेरा बेस्ट 18000 है, उससे ऊपर नहीं जा सकता मैं।", 18_000, "final_offer"));
    expect(firm.kind).toBe("state_final_terms");
    expect(firm.text).toContain("18,000");
  });

  it("said again, even without a final word, it converges instead of holding", async () => {
    const t = await setup();
    await t.say("मेरा budget तो 17,000 का है.", budget("मेरा budget तो 17,000 का है.", 17_000));
    const first = await t.say("मेरा बेस्ट 18000 है", budget("मेरा बेस्ट 18000 है", 18_000));
    expect(first.kind).toBe("counter");
    const again = await t.say("18,000 से ज्यादा नहीं दे पाऊँगा मैं", budget("18,000 से ज्यादा नहीं दे पाऊँगा मैं", 18_000));
    expect(again.kind).toBe("state_final_terms");
    expect(again.text).toContain("18,000");
  });
});
