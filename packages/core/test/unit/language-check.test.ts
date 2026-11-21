/** Code filters on the model reviewer: they drop only concerns about statements code already verified. Test values only. */
import { describe, expect, it } from "vitest";
import { languageCheck } from "../../src/governance/language-check.ts";
import type { StructuredLlm } from "../../src/llm/types.ts";

const reviewer = (concerns: Array<{ type: string; quote: string }>): StructuredLlm => ({
  async generate() {
    return { json: { concerns }, rawText: "", model: "scripted", latencyMs: 0 };
  },
});
const base = { checkedTerms: [], permittedFacts: [], counterpartyWords: [], principal: "Asha" };
const agreement = { move: "confirm_agreement", notice: null, opening: false, approvalGranted: true, outcome: "in_progress" };

describe("Reviewer filters", () => {
  it("keeps a recorded approval announced with the agreement on the inserted terms", async () => {
    const reply = "Asha has approved, and we have agreement on the full package [[TERMS]].";
    const result = await languageCheck(reviewer([{ type: "invented_fact", quote: "Asha has approved" }]), { ...base, reply, validatedTermsMarker: "[[TERMS]]", action: agreement });
    expect(result).toEqual({ ok: true, concerns: [] });
  });

  it("still flags an approval when none is recorded, or when the sentence adds a promise", async () => {
    const reply = "Asha has approved, and we have agreement on the full package [[TERMS]].";
    const pending = await languageCheck(reviewer([{ type: "invented_fact", quote: "Asha has approved" }]), { ...base, reply, validatedTermsMarker: "[[TERMS]]", action: { ...agreement, approvalGranted: false } });
    expect(pending.ok && pending.concerns).toHaveLength(1);
    const extra = "Asha has approved, and she will deliver it free.";
    const promise = await languageCheck(reviewer([{ type: "invented_fact", quote: extra }]), { ...base, reply: extra, action: agreement });
    expect(promise.ok && promise.concerns).toHaveLength(1);
  });

  it("keeps a declined term restated with the value they asked for", async () => {
    const reply = "Delivery to Indiranagar isn’t included, so that part stays as it is.";
    const result = await languageCheck(reviewer([{ type: "invented_fact", quote: "Delivery to Indiranagar isn’t included" }]), { ...base, reply, declinedTerms: ["delivery included"], currentMessage: "I’ll pay the full price if you deliver to Indiranagar." });
    expect(result).toEqual({ ok: true, concerns: [] });
  });

  it("still flags a decline that adds a place or reason they never mentioned", async () => {
    const reply = "Delivery to Whitefield isn’t included because the truck is broken.";
    const result = await languageCheck(reviewer([{ type: "invented_fact", quote: reply }]), { ...base, reply, declinedTerms: ["delivery included"], currentMessage: "Can you deliver?" });
    expect(result.ok && result.concerns).toHaveLength(1);
  });
});

describe("The planned offer is not a mismatch", () => {
  const counter = { move: "counter", notice: null, opening: false, approvalGranted: false, outcome: "in_progress" };
  it("drops a mismatch on a sentence that only puts the checked amount to them", async () => {
    for (const reply of ["I can do ₹19,800.", "How about ₹19,800?", "Hi, I'm Kritva, assisting Asha. I can do ₹19,800 for the bed."]) {
      const quote = reply.split(/(?<=[.!?])\s+/).at(-1)!;
      const result = await languageCheck(reviewer([{ type: "action_mismatch", quote }]), { ...base, reply, checkedTerms: ["price: ₹19,800"], action: counter });
      expect(result).toEqual({ ok: true, concerns: [] });
    }
  });

  it("keeps it for another amount, another move, or a sentence that adds anything", async () => {
    const other = await languageCheck(reviewer([{ type: "action_mismatch", quote: "I can do ₹19,500." }]), { ...base, reply: "I can do ₹19,500.", checkedTerms: ["price: ₹19,800"], action: counter });
    expect(other.ok && other.concerns).toHaveLength(1);
    const answer = await languageCheck(reviewer([{ type: "action_mismatch", quote: "I can do ₹19,800." }]), { ...base, reply: "I can do ₹19,800.", checkedTerms: ["price: ₹19,800"], action: { ...counter, move: "answer" } });
    expect(answer.ok && answer.concerns).toHaveLength(1);
    const extra = "I can do ₹19,800 and deliver it free.";
    const added = await languageCheck(reviewer([{ type: "promise_outside_terms", quote: extra }]), { ...base, reply: extra, checkedTerms: ["price: ₹19,800"], action: counter });
    expect(added.ok && added.concerns).toHaveLength(1);
  });
});
