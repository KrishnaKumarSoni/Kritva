/** Breaking into a live call when the deal goes to another counterparty (docs/Kritva_Multiple_Counterparties.md, section 12). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contactState, DealGroups, NegotiationEngine, NegotiationRecord, SqliteRecordBackend, type StructuredLlm, type StructuredRequest, type StructuredResponse } from "@kritva/core";
import { loadConfirmedMandates } from "../src/main-helpers.ts";
import { LiveCalls } from "../src/live-calls.ts";
import { RealtimeCall, type RealtimeEvent, type RealtimeLink } from "../src/realtime-voice.ts";

const CASES = resolve(import.meta.dirname, "../../../cases");

class ScriptedLlm implements StructuredLlm {
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const reply = (json: unknown) => ({ json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 });
    if (request.purpose === "language_check") return reply({ concerns: [] });
    if (request.purpose === "interpret_counterparty") return reply({ intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, questions: [] });
    throw new Error("template wording");
  }
}

class FakeLink implements RealtimeLink {
  readonly sent: Array<Record<string, any>> = [];
  onEvent: ((event: RealtimeEvent) => void) | null = null;
  onClose: (() => void) | null = null;
  send(event: Record<string, unknown>) {
    this.sent.push(event);
  }
  close() {}
  emit(event: RealtimeEvent) {
    this.onEvent?.(event);
  }
  types() {
    return this.sent.map((e) => e.type as string);
  }
  creates() {
    return this.sent.filter((e) => e.type === "response.create");
  }
}

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kritva-breakin-"));
  const record = new NegotiationRecord(new SqliteRecordBackend(join(dir, "db.sqlite")));
  const groups = new DealGroups(record, { maxOpen: 5 });
  const liveCalls = new LiveCalls();
  const engine = new NegotiationEngine({ record, llm: new ScriptedLlm(), locale: "en-IN", groups, onSessionClosedElsewhere: (id) => liveCalls.breakIn(id), contactFor: (id) => liveCalls.contactFor(id) });
  const mandate = loadConfirmedMandates(CASES).find((m) => m.id === "bed-sale/demo")!.mandate;
  const started = await groups.start({ mandate, mandateSource: { mandateId: "m_demo", revision: 1 }, entryId: null, via: "phone" });
  if (!started.ok) throw new Error(started.message);
  const sessionId = started.sessionId;
  const link = new FakeLink();
  let over = 0;
  const call = new RealtimeCall({ engine, record, sessionId, link, afterSeq: 0, pollMs: 50, breakInWaitMs: 2_000, onOver: () => void (over += 1) });
  liveCalls.register(sessionId, call, "919845012345");
  await call.start();
  // Let the greeting play out.
  await until(() => link.creates().length === 1);
  link.emit({ type: "response.created", response: { metadata: { kritva: "say" } } });
  link.emit({ type: "response.done", response: { metadata: { kritva: "say", message_id: link.creates()[0]!.response.metadata.message_id }, output: [] } });
  return { record, engine, sessionId, link, call, overCount: () => over };
}

describe("breaking into a live call", () => {
  it("finishes Kritva's sentence, says a filler, then the news", async () => {
    const { engine, sessionId, link, call } = await setup();
    // Kritva is in the middle of a reply.
    link.emit({ type: "response.created", response: {} });
    link.emit({ type: "response.output_audio_transcript.delta", delta: "It's a solid king-size bed and" });
    await engine.closeForDealElsewhere({ sessionId });
    await until(() => link.sent.some((e) => e.type === "session.update"));
    link.emit({ type: "response.output_audio_transcript.delta", delta: " in very good condition" });
    expect(link.types()).not.toContain("response.cancel");
    link.emit({ type: "response.output_audio_transcript.delta", delta: " shape. " });
    expect(link.types()).toContain("response.cancel");
    expect(link.types()).toContain("output_audio_buffer.clear");
    const before = link.creates().length;
    link.emit({ type: "response.done", response: { status: "cancelled", output: [] } });
    await until(() => link.creates().length === before + 1);
    expect(link.creates().at(-1)!.response.metadata).toMatchObject({ kritva: "filler", kind: "break_in" });
    link.emit({ type: "response.created", response: { metadata: { kritva: "filler" } } });
    link.emit({ type: "response.done", response: { metadata: { kritva: "filler" }, output: [] } });
    await until(() => link.creates().length === before + 2);
    expect(String(link.creates().at(-1)!.response.instructions)).toMatch(/agreed terms with someone else/);
    expect(call.closed).toBe(false);
  });

  it("waits for them to stop talking before saying anything", async () => {
    const { engine, sessionId, link } = await setup();
    link.emit({ type: "input_audio_buffer.speech_started" });
    const before = link.creates().length;
    await engine.closeForDealElsewhere({ sessionId });
    await new Promise((r) => setTimeout(r, 100));
    expect(link.creates().length).toBe(before);
    link.emit({ type: "input_audio_buffer.speech_stopped" });
    await until(() => link.creates().length === before + 1);
    expect(link.creates().at(-1)!.response.metadata).toMatchObject({ kritva: "filler" });
    // The model's own answer to what they said is cancelled.
    link.emit({ type: "response.created", response: {} });
    expect(link.types().filter((t) => t === "response.cancel").length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the caller's number on a yes, thanks them, and ends the call", async () => {
    const { engine, sessionId, link, record, overCount } = await setup();
    await engine.closeForDealElsewhere({ sessionId });
    // The filler, then the news: each plays to the end.
    for (const n of [2, 3]) {
      await until(() => link.creates().length === n);
      const metadata = link.creates().at(-1)!.response.metadata;
      link.emit({ type: "response.created", response: { metadata } });
      link.emit({ type: "response.done", response: { metadata, output: [] } });
    }
    // They answer; the voice model hands the turn to the engine.
    const before = link.creates().length;
    link.emit({ type: "response.created", response: {} });
    link.emit({ type: "response.done", response: { output: [{ type: "function_call", name: "negotiate", call_id: "call_yes", arguments: JSON.stringify({ their_words: "Yes, sure, keep it", language: "en" }) }] } });
    await until(() => link.creates().length === before + 1);
    expect(String(link.creates().at(-1)!.response.instructions)).toMatch(/keep your number/);
    expect(contactState(await record.context(sessionId))).toBe("kept");
    const thanks = link.creates().at(-1)!.response.metadata;
    link.emit({ type: "response.created", response: { metadata: thanks } });
    link.emit({ type: "response.done", response: { metadata: thanks, output: [] } });
    await until(() => overCount() === 1);
  });
});
