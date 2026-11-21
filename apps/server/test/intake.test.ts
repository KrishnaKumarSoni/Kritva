/** Intake agent chat and mandate lifecycle, through the operator routes, with a scripted agent and mapper. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHECKLIST_ITEMS,
  IntakeService,
  LlmError,
  MandateLibrary,
  MandateRevisions,
  MemoryIntakeStore,
  NegotiationEngine,
  NegotiationRecord,
  SqliteLibraryBackend,
  SqliteRecordBackend,
  type Checklist,
  type IntakeAgent,
  type IntakeTurnInput,
  type IntakeTurnOutput,
  type LibraryInput,
  type StructuredLlm,
  type StructuredRequest,
  type StructuredResponse,
} from "@kritva/core";
import { extraction, money } from "../../../packages/core/test/support/fake-llm.ts";
import { createApp } from "../src/app.ts";
import { loadConfirmedMandates, loadExamples } from "../src/main-helpers.ts";

const CASES = resolve(import.meta.dirname, "../../../cases");
const bed = loadExamples(CASES).find((e) => e.id === "bed-sale")!;

class ScriptedLlm implements StructuredLlm {
  readonly mappings: Array<unknown | LlmError> = [];
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const reply = (json: unknown) => ({ json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 });
    if (request.purpose.startsWith("mandate_mapping")) {
      const next = this.mappings.shift();
      if (next instanceof LlmError || next === undefined) throw next ?? new LlmError("provider_error", "no script");
      return reply(next);
    }
    if (request.purpose === "language_check") return reply({ concerns: [] });
    throw new Error("template wording");
  }
}

/** Queued turns; each sees the input the service gave it. */
class ScriptedAgent implements IntakeAgent {
  readonly turns: Array<((input: IntakeTurnInput) => IntakeTurnOutput) | Error> = [];
  readonly inputs: IntakeTurnInput[] = [];
  async run(input: IntakeTurnInput): Promise<IntakeTurnOutput> {
    this.inputs.push(structuredClone(input));
    const next = this.turns.shift();
    if (!next) throw new Error("no scripted turn");
    if (next instanceof Error) throw next;
    return next(input);
  }
}

const all = (status: "known" | "assumed" | "missing"): Checklist => Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i.id, status])) as Checklist;
const fullInput: LibraryInput = { title: bed.title, principalRole: bed.principalRole, counterpartyRole: bed.counterpartyRole, publicText: bed.publicText, privateText: bed.privateText };

const q = (source: "public-facts" | "private-instructions", quote: string) => [{ source_id: source, quote }];
const priceTerm = { ref: "price", name: "price", description: null, value_type: "money" as const, unit: null, currency: "INR", status: "stated" as const, quotes: q("public-facts", "Price: ₹20,000") };
const asking = { ref: "asking", party_id: "principal", term_ref: "price", value: money(20_000), condition_refs: [], status: "stated" as const, quotes: q("public-facts", "Price: ₹20,000") };
const minimum = (amount: number, quote: string, ref = "floor") => ({ ref, party_id: "principal", term_ref: "price", kind: "minimum" as const, value: money(amount), condition_refs: [], status: "stated" as const, quotes: q("private-instructions", quote) });
const negotiate = { ref: "negotiate", action: "propose_terms", mode: "autonomous" as const, term_refs: ["price"], description: "May negotiate the price", condition_refs: [], status: "stated" as const, quotes: q("private-instructions", "You can negotiate the price") };
const askFirst = { ref: "accept", action: "accept_agreement", mode: "requires_approval" as const, term_refs: [], description: "Ask before accepting any offer", condition_refs: [], status: "stated" as const, quotes: q("private-instructions", "Ask me before accepting any offer.") };
const bedMapping = (limits = [minimum(18_000, "don't go below ₹18,000")]) => extraction({ terms: [priceTerm], positions: [asking], limits, permissions: [negotiate, askFirst] });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kritva-intake-"));
  const dbPath = join(dir, "db.sqlite");
  const record = new NegotiationRecord(new SqliteRecordBackend(dbPath));
  const llm = new ScriptedLlm();
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN" });
  const revisions = new MandateRevisions({ record, engine, mappingLlm: llm });
  const library = new MandateLibrary({ backend: new SqliteLibraryBackend(dbPath), mappingLlm: llm });
  const agent = new ScriptedAgent();
  const intake = new IntakeService({ store: new MemoryIntakeStore(), agent, library, defaultCurrency: "Indian rupees" });
  const listings = [{ caseId: "bed-sale", title: "Bed", location: "Koramangala", libraryId: "man_protected" }];
  const app = createApp({ record, engine, revisions, mandates: loadConfirmedMandates(CASES), locale: "en-IN", library, intake, examples: [], listings });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  /** Chat until a live mandate exists; returns the conversation view after going live. */
  const makeLive = async () => {
    const started = (await call("POST", "/api/operator/intake")).json;
    agent.turns.push(() => ({ reply: "Lovely, putting it together.", fields: fullInput, checklist: all("known"), ready: true }));
    await call("POST", `/api/operator/intake/${started.id}/messages`, { text: "Selling my bed for 20k, lowest 18k", images: [] });
    llm.mappings.push(bedMapping());
    const prepared = (await call("POST", `/api/operator/intake/${started.id}/prepare`)).json;
    const card = prepared.messages.at(-1).card;
    return (await call("POST", `/api/operator/intake/${started.id}/live`, { versionId: card.versionId, draftHash: card.draftHash })).json;
  };
  return { record, engine, llm, agent, library, call, makeLive };
}

describe("Intake agent: a mandate from a conversation", () => {
  it("two prepare requests at once map the input only once", async () => {
    const { call, agent, llm, library } = setup();
    const started = (await call("POST", "/api/operator/intake")).json;
    agent.turns.push(() => ({ reply: "Putting it together.", fields: fullInput, checklist: all("known"), ready: true }));
    await call("POST", `/api/operator/intake/${started.id}/messages`, { text: "Selling my bed", images: [] });
    llm.mappings.push(bedMapping());
    const [a, b] = await Promise.all([call("POST", `/api/operator/intake/${started.id}/prepare`), call("POST", `/api/operator/intake/${started.id}/prepare`)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(library.list()).toHaveLength(1);
  });

  it("starts with a greeting and no progress, and a reply fills the checklist and the bar", async () => {
    const { call, agent } = setup();
    const started = await call("POST", "/api/operator/intake");
    expect(started.status).toBe(201);
    expect(started.json.messages).toHaveLength(1);
    expect(started.json.messages[0].role).toBe("assistant");
    expect(started.json.progress).toBe(0);
    expect(started.json.state).toBe("new");

    const partial = { ...all("missing"), subject: "known", roles: "known", opening: "known" } as Checklist;
    agent.turns.push(() => ({ reply: "Nice! What's the lowest you'd be happy to go?", fields: { ...fullInput, privateText: "" }, checklist: partial, ready: false }));
    const image = "data:image/png;base64,iVBORw0KGgo=";
    const sent = await call("POST", `/api/operator/intake/${started.json.id}/messages`, { text: "", images: [image] });
    expect(sent.status).toBe(200);
    expect(sent.json.messages.map((m: any) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(sent.json.messages[1].images).toEqual([image]);
    expect(sent.json.progress).toBeGreaterThan(0);
    expect(sent.json.progress).toBeLessThan(0.9);
    expect(sent.json.next).toBeNull();
    // The agent saw the image on the latest message, and the configured default currency.
    expect(agent.inputs[0]!.conversation.at(-1)!.images).toEqual([image]);
    expect(JSON.stringify(agent.inputs[0]!.context)).toContain("Indian rupees");
    // Not yet a saved mandate, so it shows as a draft conversation.
    expect((await call("GET", "/api/operator/intake")).json).toHaveLength(1);
  });

  it("a failed agent turn saves nothing, so the same message can be sent again", async () => {
    const { call, agent } = setup();
    const started = (await call("POST", "/api/operator/intake")).json;
    agent.turns.push(new Error("model down"));
    const failed = await call("POST", `/api/operator/intake/${started.id}/messages`, { text: "Selling my bed", images: [] });
    expect(failed.status).toBe(502);
    expect((await call("GET", `/api/operator/intake/${started.id}`)).json.messages).toHaveLength(1);
  });

  it("rejects anything that is not an image data URL", async () => {
    const { call } = setup();
    const started = (await call("POST", "/api/operator/intake")).json;
    const bad = await call("POST", `/api/operator/intake/${started.id}/messages`, { text: "hi", images: ["https://example.com/x.png"] });
    expect(bad.status).toBe(400);
  });

  it("when complete, the input is mapped into a draft card; making it live confirms that exact draft", async () => {
    const { call, agent, llm } = setup();
    const started = (await call("POST", "/api/operator/intake")).json;
    agent.turns.push(() => ({ reply: "Lovely, putting it together.", fields: fullInput, checklist: all("known"), ready: true }));
    const sent = (await call("POST", `/api/operator/intake/${started.id}/messages`, { text: "Selling my bed for 20k, lowest 18k", images: [] })).json;
    expect(sent.next).toBe("prepare");
    expect(sent.progress).toBe(0.9);

    llm.mappings.push(bedMapping());
    const turnsBefore = agent.inputs.length;
    const prepared = (await call("POST", `/api/operator/intake/${started.id}/prepare`)).json;
    // A ready draft replies at once, without another model turn.
    expect(agent.inputs.length).toBe(turnsBefore);
    expect(prepared.messages.at(-1).text).toMatch(/Make it live/);
    const card = prepared.messages.at(-1).card;
    expect(card).toMatchObject({ kind: "ready", mode: "new", actionable: true });
    expect(card.review.sections.find((s: any) => s.id === "limits").items[0].private).toBe(true);
    expect(prepared.progress).toBe(1);
    expect(prepared.state).toBe("draft");
    // A draft has no authority: nothing new to negotiate with yet.
    expect((await call("GET", "/api/operator/mandates")).json.some((m: any) => m.id === `library:${prepared.mandateId}`)).toBe(false);

    const stale = await call("POST", `/api/operator/intake/${started.id}/live`, { versionId: card.versionId, draftHash: "wrong" });
    expect(stale.status).toBe(409);

    const live = await call("POST", `/api/operator/intake/${started.id}/live`, { versionId: card.versionId, draftHash: card.draftHash });
    expect(live.status).toBe(200);
    expect(live.json.state).toBe("live");
    expect(live.json.messages.at(-1).card).toEqual({ kind: "live", revision: 1 });
    expect(live.json.messages.find((m: any) => m.card?.kind === "ready").card.actionable).toBe(false);
    expect((await call("GET", "/api/operator/mandates")).json.some((m: any) => m.id === `library:${live.json.mandateId}`)).toBe(true);
    expect((await call("GET", "/api/operator/intake")).json).toHaveLength(0);
  });

  it("a blocking problem goes back to the agent as a question, with no card", async () => {
    const { call, agent, llm } = setup();
    const started = (await call("POST", "/api/operator/intake")).json;
    const text = `${bed.privateText} Don't accept anything below ₹17,500.`;
    agent.turns.push(() => ({ reply: "Putting it together.", fields: { ...fullInput, privateText: text }, checklist: all("known"), ready: true }));
    await call("POST", `/api/operator/intake/${started.id}/messages`, { text: "lowest 18k, actually 17.5k", images: [] });
    llm.mappings.push(bedMapping([minimum(18_000, "don't go below ₹18,000"), minimum(17_500, "Don't accept anything below ₹17,500.", "floor2")]));
    agent.turns.push(() => ({ reply: "Quick check: is your lowest ₹18,000 or ₹17,500?", fields: { ...fullInput, privateText: text }, checklist: all("known"), ready: false }));
    const prepared = (await call("POST", `/api/operator/intake/${started.id}/prepare`)).json;
    expect(agent.inputs.at(-1)!.event).toMatch(/can't go live/);
    expect(prepared.messages.at(-1).card).toBeNull();
    expect(prepared.progress).toBeLessThan(1);
  });

  it("changing a live mandate by chat makes the next revision and applies it to open negotiations", async () => {
    const { call, agent, llm, makeLive, record } = setup();
    const live = await makeLive();
    const session = (await call("POST", "/api/operator/sessions", { mandateId: `library:${live.mandateId}` })).json.session;

    const opened = (await call("GET", `/api/operator/intake/mandate/${live.mandateId}`)).json;
    expect(opened.id).toBe(live.id);
    expect(opened.progress).toBe(1);

    const changed = { ...fullInput, privateText: bed.privateText.replace("₹18,000", "₹17,000") };
    agent.turns.push((input) => {
      expect(input.context.mandate).toMatchObject({ changing_a_live_mandate: true, live_revision: 1 });
      return { reply: "Got it, updating.", fields: changed, checklist: all("known"), ready: true };
    });
    await call("POST", `/api/operator/intake/${live.id}/messages`, { text: "I can go to 17k now", images: [] });
    llm.mappings.push(bedMapping([minimum(17_000, "don't go below ₹17,000")]));
    const prepared = (await call("POST", `/api/operator/intake/${live.id}/prepare`)).json;
    const card = prepared.messages.at(-1).card;
    expect(card.mode).toBe("update");
    expect(prepared.messages.at(-1).text).toMatch(/Apply them/);
    const applied = (await call("POST", `/api/operator/intake/${live.id}/live`, { versionId: card.versionId, draftHash: card.draftHash })).json;
    expect(applied.messages.at(-1).card.revision).toBe(2);
    expect(applied.appliedToSessions).toEqual([session.id]);
    expect((await record.context(session.id)).mandateRevision).toBe(2);
  });

  it("a saved mandate made before intake opens with a seeded conversation", async () => {
    const { call, llm } = setup();
    llm.mappings.push(bedMapping());
    const created = (await call("POST", "/api/operator/library", fullInput)).json;
    const opened = (await call("GET", `/api/operator/intake/mandate/${created.mandateId}`)).json;
    expect(opened.state).toBe("draft");
    expect(opened.messages).toHaveLength(1);
    expect(opened.messages[0].card).toMatchObject({ kind: "ready", actionable: true });
  });
});

describe("Mandate lifecycle: live, paused, closed and deleted", () => {
  it("pausing hides it from new negotiations and pauses open ones; resuming brings both back", async () => {
    const { call, makeLive, engine } = setup();
    const live = await makeLive();
    const id = live.mandateId;
    const session = (await call("POST", "/api/operator/sessions", { mandateId: `library:${id}` })).json.session;

    const paused = await call("POST", `/api/operator/library/${id}/lifecycle`, { action: "pause" });
    expect(paused.status).toBe(200);
    expect(paused.json.state).toBe("paused");
    expect(paused.json.sessionsChanged).toEqual([session.id]);
    expect((await engine.state(session.id)).status).toBe("paused");
    expect((await call("GET", "/api/operator/library")).json[0].state).toBe("paused");
    expect((await call("GET", "/api/operator/mandates")).json.some((m: any) => m.id === `library:${id}`)).toBe(false);
    const refused = await call("POST", "/api/operator/sessions", { mandateId: `library:${id}` });
    expect(refused.status).toBe(409);
    expect(refused.json.message).toMatch(/paused/);

    const again = await call("POST", `/api/operator/library/${id}/lifecycle`, { action: "pause" });
    expect(again.status).toBe(409);

    const resumed = (await call("POST", `/api/operator/library/${id}/lifecycle`, { action: "resume" })).json;
    expect(resumed.state).toBe("live");
    expect((await engine.state(session.id)).status).not.toBe("paused");
  });

  it("closing and reopening", async () => {
    const { call, makeLive } = setup();
    const { mandateId } = await makeLive();
    expect((await call("POST", `/api/operator/library/${mandateId}/lifecycle`, { action: "close" })).json.state).toBe("closed");
    expect((await call("POST", "/api/operator/sessions", { mandateId: `library:${mandateId}` })).status).toBe(409);
    expect((await call("POST", `/api/operator/library/${mandateId}/lifecycle`, { action: "reopen" })).json.state).toBe("live");
  });

  it("a draft cannot be paused, only deleted", async () => {
    const { call, llm } = setup();
    llm.mappings.push(bedMapping());
    const created = (await call("POST", "/api/operator/library", fullInput)).json;
    expect((await call("POST", `/api/operator/library/${created.mandateId}/lifecycle`, { action: "pause" })).status).toBe(409);
    expect((await call("DELETE", `/api/operator/library/${created.mandateId}`)).status).toBe(200);
  });

  it("deleting removes it from the list and from new negotiations; the demo listing's mandate is protected", async () => {
    const { call, makeLive } = setup();
    const { mandateId } = await makeLive();
    const deleted = await call("DELETE", `/api/operator/library/${mandateId}`);
    expect(deleted.status).toBe(200);
    expect((await call("GET", "/api/operator/library")).json).toEqual([]);
    expect((await call("GET", `/api/operator/library/${mandateId}`)).status).toBe(404);
    expect((await call("GET", `/api/operator/intake/mandate/${mandateId}`)).status).toBe(404);
    expect((await call("POST", "/api/operator/sessions", { mandateId: `library:${mandateId}` })).status).toBe(409);
    expect((await call("DELETE", `/api/operator/library/${mandateId}`)).status).toBe(404);
    expect((await call("DELETE", "/api/operator/library/man_protected")).status).toBe(409);
  });

  it("an unmapped intake conversation can be discarded", async () => {
    const { call } = setup();
    const started = (await call("POST", "/api/operator/intake")).json;
    expect((await call("DELETE", `/api/operator/intake/${started.id}`)).status).toBe(200);
    expect((await call("GET", `/api/operator/intake/${started.id}`)).status).toBe(404);
  });
});
