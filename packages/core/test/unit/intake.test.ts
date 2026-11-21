/** Intake: progress and the hand-off to mapping. */
import { describe, expect, it } from "vitest";
import { CHECKLIST_ITEMS, intakeProgress, readyAfter, type Checklist } from "../../src/intake/index.ts";

const all = (status: "known" | "assumed" | "missing"): Checklist => Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i.id, status])) as Checklist;
const fields = { title: "Selling my sofa", principalRole: "seller", counterpartyRole: "buyer", publicText: "Sofa, 15,000", privateText: "" };

describe("intake progress", () => {
  it("fills to 90% as required items are gathered, and to 100% only with a ready draft or a live mandate", () => {
    expect(intakeProgress(all("missing"), { draftReady: false, live: false })).toBe(0);
    expect(intakeProgress(all("assumed"), { draftReady: false, live: false })).toBe(0.9);
    expect(intakeProgress(all("missing"), { draftReady: true, live: false })).toBe(1);
    expect(intakeProgress(all("missing"), { draftReady: false, live: true })).toBe(1);
  });
});

describe("hand-off to mapping", () => {
  it("follows the agent's own ready", () => {
    expect(readyAfter({ ready: true, reply: "Putting it together.", fields, checklist: all("missing") })).toBe(true);
  });
  it("a complete brief with no question pending moves on even if the agent forgot to say ready", () => {
    expect(readyAfter({ ready: false, reply: "Got it, I'm putting it together now.", fields, checklist: all("known") })).toBe(true);
  });
  it("waits while the agent is asking something or an item is missing", () => {
    expect(readyAfter({ ready: false, reply: "Does it come with cushions?", fields, checklist: all("known") })).toBe(false);
    expect(readyAfter({ ready: false, reply: "Thanks.", fields, checklist: { ...all("known"), limit: "missing" } })).toBe(false);
    expect(readyAfter({ ready: false, reply: "Thanks.", fields: { ...fields, publicText: "" }, checklist: all("known") })).toBe(false);
  });
});
