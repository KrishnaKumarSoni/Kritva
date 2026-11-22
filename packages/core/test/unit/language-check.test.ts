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

  it("saying a detail is not confirmed is never an invented fact; adding a detail still is (reported chat, 2026-11-22)", async () => {
    const plain = "I don’t have the material confirmed.";
    const kept = await languageCheck(reviewer([{ type: "invented_fact", quote: plain }]), { ...base, reply: plain });
    expect(kept.ok && kept.concerns).toEqual([]);
    const added = "It’s a wooden frame, but I don’t have more confirmed.";
    const flagged = await languageCheck(reviewer([{ type: "invented_fact", quote: added }]), { ...base, reply: added });
    expect(flagged.ok && flagged.concerns.map((c) => c.type)).toEqual(["invented_fact"]);
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

describe("The planned offer in Hindi or Tamil is not a mismatch", () => {
  const counter = { move: "counter", notice: null, opening: false, approvalGranted: false, outcome: "in_progress" };
  it.each(["मैं \u20b918,500 कर सकता हूँ।", "मैं \u20b918,500 पर दे सकता हूँ।", "நான் \u20b918,500 தர முடியும்."])("%s", async (reply) => {
    const quote = reply.replace(/[।.]$/u, "");
    const result = await languageCheck(reviewer([{ type: "action_mismatch", quote }]), { ...base, reply, checkedTerms: ["price: \u20b918,500"], action: counter });
    expect(result.ok && result.concerns).toEqual([]);
  });
  it("another amount in Hindi is still a concern", async () => {
    const reply = "मैं \u20b917,000 कर सकता हूँ।";
    const result = await languageCheck(reviewer([{ type: "action_mismatch", quote: reply }]), { ...base, reply, checkedTerms: ["price: \u20b918,500"], action: counter });
    expect(result.ok && result.concerns).toHaveLength(1);
  });
});

describe("Prescribed refusals and declines are not disclosures", () => {
  const flag = (quote: string) => reviewer([{ type: "private_disclosure", quote }]);
  it("drops a concern about the refusal sentence the brief asks for", async () => {
    for (const reply of ["I can\u2019t share Asha\u2019s private limit. What would you like to offer?", "Sorry, I can\u2019t share the private limits."]) {
      const quote = reply.split(/(?<=[.?])\s+/)[0]!;
      const result = await languageCheck(flag(quote), { ...base, reply });
      expect(result.ok && result.concerns, reply).toEqual([]);
    }
  });
  it("drops a concern about declining their own figure, and keeps one about any other amount or a hint", async () => {
    const reply = "I can\u2019t do \u20b917,500. I can do \u20b918,000. Could that work for you?";
    const theirs = await languageCheck(flag("I can\u2019t do \u20b917,500"), { ...base, reply, counterpartyWords: ["\u20b917,500 is really the most I can do."] });
    expect(theirs.ok && theirs.concerns).toEqual([]);
    const notTheirs = await languageCheck(flag("I can\u2019t do \u20b917,500"), { ...base, reply, counterpartyWords: ["Would you take less?"] });
    expect(notTheirs.ok && notTheirs.concerns).toHaveLength(1);
    const hint = "I can\u2019t do that, it\u2019s my limit.";
    const kept = await languageCheck(flag(hint), { ...base, reply: hint, counterpartyWords: ["\u20b917,500?"] });
    expect(kept.ok && kept.concerns).toHaveLength(1);
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

  it("drops it on the offer clause of a longer sentence, in natural phrasings (reported chat, 2026-11-22)", async () => {
    const reply = "Thanks for letting me know. You said your budget is ₹18,000, and I can bring it to ₹19,000. Can you come up to that price?";
    for (const quote of ["I can bring it to ₹19,000.", "and I can bring it to ₹19,000"]) {
      const result = await languageCheck(reviewer([{ type: "action_mismatch", quote }]), { ...base, reply, checkedTerms: ["price: ₹19,000"], action: counter });
      expect(result, quote).toEqual({ ok: true, concerns: [] });
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

describe("Reviewer severity", () => {
  it("a doubt is recorded by the reviewer but does not stop the reply; a violation does", async () => {
    const reply = "₹20,000 is the current ask, and I hear you want it lower.";
    const doubt = await languageCheck(reviewer([{ type: "private_disclosure", quote: "I hear you want it lower.", reason: "might hint", severity: "doubt" } as never]), { ...base, reply });
    expect(doubt).toEqual({ ok: true, concerns: [] });
    const violation = await languageCheck(reviewer([{ type: "private_disclosure", quote: "I hear you want it lower.", reason: "hints at room", severity: "violation" } as never]), { ...base, reply });
    expect(violation.ok && violation.concerns).toHaveLength(1);
  });
});

describe("Agreement confirmation wording", () => {
  it("\"We're agreed.\" on a confirmed agreement is the move itself, with or without a recorded approval", async () => {
    const reply = "We're agreed. [[TERMS]]. Thanks, and we'll sort out payment and pickup next.";
    for (const approvalGranted of [true, false]) {
      const result = await languageCheck(reviewer([{ type: "action_mismatch", quote: "We're agreed." }]), { ...base, reply, validatedTermsMarker: "[[TERMS]]", action: { ...agreement, approvalGranted } });
      expect(result).toEqual({ ok: true, concerns: [] });
    }
  });
});
