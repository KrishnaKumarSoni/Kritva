/** Deal groups: several counterparties under one saved mandate (docs/Kritva_Multiple_Counterparties.md). */
import { describe, expect, it } from "vitest";
import { DealGroups } from "../../src/record/groups.ts";
import { hashTerms } from "../../src/record/events.ts";
import { MandateLibrary, SqliteLibraryBackend } from "../../src/mandate/library.ts";
import type { StructuredLlm } from "../../src/llm/types.ts";
import { AGENT, demoTerms, loadDemoMandate, money, openRecord, tempDbPath } from "../support/record.ts";

const mandate = loadDemoMandate();
const terms = demoTerms(mandate);
const source = { mandateId: "m_demo", revision: 1 };
const priceTerms = (amount: number) => [{ termId: terms.price, value: money(amount) }];

function setup(maxOpen = 3) {
  const { record } = openRecord();
  const groups = new DealGroups(record, { maxOpen });
  const start = (entryId: string | null = null, previousSessionId: string | null = null) => groups.start({ mandate, mandateSource: source, entryId, via: "link", previousSessionId });
  return { record, groups, start };
}

async function sessionId(p: ReturnType<ReturnType<typeof setup>["start"]>): Promise<string> {
  const r = await p;
  if (!r.ok) throw new Error(r.message);
  return r.sessionId;
}

describe("deal groups", () => {
  it("opens one group per saved mandate and joins each session to it", async () => {
    const { groups, start } = setup();
    const a = await sessionId(start("e1"));
    const b = await sessionId(start(null));
    const g = groups.groupOf(a)!;
    expect(g).not.toBeNull();
    expect(groups.groupOf(b)!.groupId).toBe(g.groupId);
    expect(g.members.map((m) => m.entryId)).toEqual(["e1", null]);
    expect(groups.groups()).toHaveLength(1);
  });

  it("refuses a start beyond the cap of open sessions", async () => {
    const { start } = setup(2);
    await sessionId(start());
    await sessionId(start());
    const third = await start();
    expect(third).toMatchObject({ ok: false, code: "full" });
  });

  it("counts two starts at the same moment against the cap", async () => {
    const { start } = setup(1);
    const results = await Promise.all([start(), start()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("a reset replaces the earlier session and does not count twice", async () => {
    const { groups, start } = setup(1);
    const a = await sessionId(start("e1"));
    const b = await sessionId(start("e1", a));
    const g = groups.groupOf(b)!;
    expect(g.members.map((m) => m.sessionId)).toEqual([b]);
  });

  it("lets only one session hold the deal; a release frees it", async () => {
    const { groups, start } = setup();
    const a = await sessionId(start());
    const b = await sessionId(start());
    expect(groups.reserve(a, { offerId: "o1", termsHash: hashTerms(priceTerms(19_000)), approvalId: null })).toEqual({ ok: true });
    expect(groups.reserve(b, { offerId: "o2", termsHash: hashTerms(priceTerms(19_500)), approvalId: null })).toMatchObject({ ok: false, code: "reserved_elsewhere", holderSessionId: a });
    groups.release(a, "They changed their mind.");
    expect(groups.reserve(b, { offerId: "o2", termsHash: hashTerms(priceTerms(19_500)), approvalId: null })).toEqual({ ok: true });
  });

  it("concludes in the same transaction as the agreement, or not at all", async () => {
    const { record, groups, start } = setup();
    const a = await sessionId(start());
    const b = await sessionId(start());
    groups.reserve(a, { offerId: "o1", termsHash: hashTerms(priceTerms(19_000)), approvalId: null });
    // B's write must fail the group check, and its event must not be saved either.
    const failing = await record.append(b, { id: "evt_fail", type: "decision", channel: null, payload: { kind: "answer", reason: "test", relatedEventIds: [] } }, AGENT, { alsoWrite: groups.concludeWrite(b, { offerId: "o2", termsHash: hashTerms(priceTerms(19_500)) }) });
    expect(failing).toMatchObject({ ok: false, error: { code: "group_conflict" } });
    expect((await record.context(b)).byId.has("evt_fail")).toBe(false);
    const ok = await record.append(a, { id: "evt_ok", type: "decision", channel: null, payload: { kind: "answer", reason: "test", relatedEventIds: [] } }, AGENT, { alsoWrite: groups.concludeWrite(a, { offerId: "o1", termsHash: hashTerms(priceTerms(19_000)) }) });
    expect(ok.ok).toBe(true);
    expect(groups.groupOf(a)!.concluded).toEqual({ sessionId: a, offerId: "o1" });
    expect(await start()).toMatchObject({ ok: false, code: "concluded" });
  });

  it("reopening after a concluded deal starts a fresh group", async () => {
    const { record, groups, start } = setup();
    const a = await sessionId(start());
    await record.append(a, { id: "evt_x", type: "decision", channel: null, payload: { kind: "answer", reason: "test", relatedEventIds: [] } }, AGENT, { alsoWrite: groups.concludeWrite(a, { offerId: "o1", termsHash: hashTerms(priceTerms(19_000)) }) });
    groups.reopen(source.mandateId, mandate.caseId);
    const c = await sessionId(start());
    expect(groups.groupOf(c)!.groupId).not.toBe(groups.groupOf(a)!.groupId);
  });

  it("adds up the principal's measured time", async () => {
    const { groups, start } = setup();
    const a = await sessionId(start());
    const g = groups.groupOf(a)!;
    groups.recordTime(g.groupId, { action: "approve", sessionId: a, ms: 4_200 });
    groups.recordTime(g.groupId, { action: "start", sessionId: null, ms: 800 });
    expect(groups.groupOf(a)!.timeMs).toBe(5_000);
  });
});

describe("the mandate's counterparty list", () => {
  const llm: StructuredLlm = { generate: async () => { throw new Error("not used"); } };
  const library = () => {
    const lib = new MandateLibrary({ backend: new SqliteLibraryBackend(tempDbPath()), mappingLlm: llm });
    lib.importConfirmed({ mandateId: "m_demo", title: "Demo", mandate, input: { title: "Demo", principalRole: "principal", counterpartyRole: "counterparty", publicText: "x", privateText: "" } });
    return lib;
  };

  it("keeps entries outside the confirmed mandate and caps them", () => {
    const lib = library();
    const before = lib.active("m_demo")!;
    expect(lib.addCounterparty("m_demo", { name: "Ravi", phone: "+91 98450 12345" }, 2)).toMatchObject({ ok: true, value: { name: "Ravi", phone: "+919845012345" } });
    expect(lib.addCounterparty("m_demo", { name: "Asha" }, 2).ok).toBe(true);
    expect(lib.addCounterparty("m_demo", { name: "Meera" }, 2)).toMatchObject({ ok: false, code: "full" });
    expect(lib.active("m_demo")).toEqual(before);
    expect(JSON.stringify(lib.active("m_demo")!.mandate)).not.toContain("Ravi");
  });

  it("edits and removes entries", () => {
    const lib = library();
    const added = lib.addCounterparty("m_demo", { name: "Ravi" }, 5);
    if (!added.ok) throw new Error("add failed");
    lib.updateCounterparty("m_demo", added.value.id, { name: "Ravi K", note: "Called on Monday" });
    expect(lib.counterparties("m_demo")[0]).toMatchObject({ name: "Ravi K", note: "Called on Monday" });
    lib.removeCounterparty("m_demo", added.value.id);
    expect(lib.counterparties("m_demo")).toEqual([]);
    expect(lib.addCounterparty("m_demo", { name: "  " }, 5)).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("a changed case file becomes the next revision of an imported mandate, until the principal edits it", () => {
    const lib = library();
    expect(lib.active("m_demo")!.revision).toBe(1);
    const changed = structuredClone(mandate);
    changed.goals[0]!.description = `${changed.goals[0]!.description} (updated)`;
    lib.importConfirmed({ mandateId: "m_demo", title: "Demo", mandate: changed, input: { title: "Demo", principalRole: "principal", counterpartyRole: "counterparty", publicText: "x", privateText: "" } });
    expect(lib.active("m_demo")!.revision).toBe(2);
    expect(lib.active("m_demo")!.mandate.goals[0]!.description).toContain("(updated)");
    // The same file again changes nothing.
    lib.importConfirmed({ mandateId: "m_demo", title: "Demo", mandate: changed, input: { title: "Demo", principalRole: "principal", counterpartyRole: "counterparty", publicText: "x", privateText: "" } });
    expect(lib.active("m_demo")!.revision).toBe(2);
  });
});
