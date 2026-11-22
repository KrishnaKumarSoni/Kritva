/** Realtime voice (docs/Kritva_Realtime_Voice.md): the call controller with a fake realtime connection. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MandateRevisions,
  NegotiationEngine,
  NegotiationRecord,
  SqliteRecordBackend,
  type PayloadOf,
  type StructuredLlm,
  type StructuredRequest,
  type StructuredResponse,
} from "@kritva/core";
import { createApp } from "../src/app.ts";
import { loadConfirmedMandates, loadExamples, loadListings } from "../src/main-helpers.ts";
import { RealtimeCall, realtimeSettingsFromEnv, scriptLanguage, spokenAmounts, type RealtimeConnector, type RealtimeEvent, type RealtimeLink } from "../src/realtime-voice.ts";

const CASES = resolve(import.meta.dirname, "../../../cases");

class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Array<Record<string, unknown>> = [];
  readonly compositions: string[] = [];
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const reply = (json: unknown) => ({ json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 });
    if (request.purpose === "language_check") return reply({ concerns: [] });
    if (request.purpose === "interpret_counterparty") {
      return reply({ intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, offer_kind: "none", offer_conditions: [], ends_negotiation: false, corrects_previous: false, pressure: "none", notes: [], answers: [], new_terms: [], questions: [], ...this.interpretations.shift() });
    }
    const text = request.purpose === "compose_reply" ? this.compositions.shift() : undefined;
    if (text !== undefined) return reply({ text });
    throw new Error("template wording");
  }
}

/** Records what the server sends; the test plays the realtime model's events. */
class FakeLink implements RealtimeLink {
  readonly sent: Array<Record<string, any>> = [];
  onEvent: ((event: RealtimeEvent) => void) | null = null;
  onClose: (() => void) | null = null;
  closed = false;
  send(event: Record<string, unknown>) {
    this.sent.push(event);
  }
  close() {
    this.closed = true;
  }
  emit(event: RealtimeEvent) {
    this.onEvent?.(event);
  }
  says() {
    return this.sent.filter((e) => e.type === "response.create").map((e) => ({ text: String(e.response.instructions).split("\n").slice(1).join("\n"), messageId: e.response.metadata?.message_id as string }));
  }
}

class FakeConnector implements RealtimeConnector {
  readonly sessions: Array<Record<string, any>> = [];
  readonly link = new FakeLink();
  async createCall(_sdp: string, session: Record<string, unknown>) {
    this.sessions.push(session);
    return { sdpAnswer: "v=0 answer", callId: "rtc_test1" };
  }
  async attach() {
    return this.link;
  }
}

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function setup(withConnector = true) {
  const dir = mkdtempSync(join(tmpdir(), "kritva-rt-"));
  const record = new NegotiationRecord(new SqliteRecordBackend(join(dir, "db.sqlite")));
  const llm = new ScriptedLlm();
  const mandates = loadConfirmedMandates(CASES);
  const listings = loadListings(CASES, mandates, loadExamples(CASES), null);
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", subjectFacts: new Map([["bed-sale", "fact_f_item"]]), listingDetails: new Map(listings.map((l) => [l.caseId, l])) });
  const connector = new FakeConnector();
  const app = createApp({ record, engine, revisions: new MandateRevisions({ record, engine, mappingLlm: llm }), mandates, locale: "en-IN", realtime: withConnector ? { connector, settings: realtimeSettingsFromEnv({}) } : null });
  const mandate = mandates.find((m) => m.id === "bed-sale/demo")!.mandate;
  const started = await record.startSession({ mandate });
  if (!started.ok) throw new Error(started.error.message);
  const sessionId = started.session.id;
  const priceTerm = mandate.terms.find((t) => t.valueType === "money")!.id;
  const offer = (amount: number) => ({ intent: "offer", offer_kind: "offer", offer_terms: [{ term_id: priceTerm, value: { type: "money", amount, currency: null, unit: null, text: null, boolean: null } }] });
  const startCall = () => app.request(`/api/buyer/sessions/${sessionId}/voice/realtime`, { method: "POST", headers: { "content-type": "application/sdp" }, body: "v=0 offer" });
  const messages = async () =>
    (await record.context(sessionId)).events.filter((e) => e.type === "message").map((e) => ({ id: e.id, ...(e.payload as PayloadOf<"message">) }));
  const link = connector.link;
  /** One finished model response, as the realtime API reports it. */
  const done = (output: Array<Record<string, unknown>>, metadata: Record<string, string> | null = null, status = "completed") => {
    link.emit({ type: "response.created", response: { id: `resp_${Math.random()}`, metadata } });
    link.emit({ type: "response.done", response: { status, metadata, output } });
  };
  const spoken = (transcript: string) => ({ type: "message", role: "assistant", content: [{ type: "output_audio", transcript }] });
  return { record, engine, llm, connector, link, sessionId, startCall, messages, done, spoken, offer };
}

describe("Realtime voice: starting a call", () => {
  it("without a realtime connection the route says so (501), so the browser uses turn-based voice", async () => {
    const t = await setup(false);
    expect((await t.startCall()).status).toBe(501);
  });

  it("creates the call with language hints, semantic turn-taking and the negotiate tool, and speaks the engine's greeting word for word", async () => {
    const t = await setup();
    const res = await t.startCall();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sdp: string }).sdp).toBe("v=0 answer");
    const session = t.connector.sessions[0]!;
    expect(session.audio.input.transcription.languages).toEqual(expect.arrayContaining(["hi", "ta", "en"]));
    expect(session.audio.input.transcription.languages).not.toContain("ur");
    expect(session.audio.input.turn_detection.type).toBe("semantic_vad");
    expect(session.tools[0].name).toBe("negotiate");
    // The voice model is never given the negotiated amount.
    expect(session.instructions).not.toMatch(/20,000|18,000/);
    expect(session.instructions).toMatch(/Devanagari/);
    await until(() => t.link.says().length === 1);
    const greeting = (await t.messages()).find((m) => m.direction === "outbound")!;
    expect(t.link.says()[0]).toEqual({ text: greeting.text, messageId: greeting.id });
  });
});

describe("Realtime voice: turns", () => {
  it("a deal turn: the acknowledgement is kept as a fragment, the engine decides, and its checked reply is spoken word for word", async () => {
    const t = await setup();
    await t.startCall();
    await until(() => t.link.says().length === 1);
    t.done([t.spoken("x")], { kritva: "say", message_id: t.link.says()[0]!.messageId });
    t.llm.interpretations.push(t.offer(15_000));
    t.link.emit({ type: "input_audio_buffer.committed", item_id: "item_a1" });
    t.done([t.spoken("ठीक है, एक सेकंड।"), { type: "function_call", name: "negotiate", call_id: "call_1", arguments: JSON.stringify({ their_words: "मैं 15000 दूँगा", language: "hi" }) }]);
    await until(() => t.link.says().length === 2);
    const msgs = await t.messages();
    expect(msgs.find((m) => m.direction === "inbound")!.text).toBe("मैं 15000 दूँगा");
    const reply = msgs.at(-1)!;
    expect(reply.direction).toBe("outbound");
    // Spoken as people say amounts ("19,000 rupees"); the recorded reply keeps the ₹ sign.
    expect(t.link.says()[1]).toEqual({ text: spokenAmounts(reply.text), messageId: reply.id });
    expect(t.link.says()[1]!.text).not.toContain("₹");
    const output = t.link.sent.find((e) => e.type === "conversation.item.create")!;
    expect(output.item).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    expect(JSON.parse(output.item.output).reply_to_say).toBe(reply.text);
    const fragments = (await t.record.context(t.sessionId)).events.filter((e) => e.type === "transcript_fragment");
    expect((fragments[0]!.payload as PayloadOf<"transcript_fragment">).text).toBe("ठीक है, एक सेकंड।");
  });

  it("a conversation turn the model answered itself is recorded with both sides and a passing check", async () => {
    const t = await setup();
    await t.startCall();
    await until(() => t.link.says().length === 1);
    t.done([t.spoken("x")], { kritva: "say", message_id: t.link.says()[0]!.messageId });
    t.link.emit({ type: "input_audio_buffer.committed", item_id: "item_b1" });
    t.link.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_b1", transcript: "Is it still available?" });
    t.done([t.spoken("Yes, it's still available for pickup.")]);
    let msgs = await t.messages();
    for (let i = 0; i < 100 && msgs.length < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      msgs = await t.messages();
    }
    expect(msgs.slice(-2).map((m) => [m.direction, m.text])).toEqual([
      ["inbound", "Is it still available?"],
      ["outbound", "Yes, it's still available for pickup."],
    ]);
    const check = (await t.record.context(t.sessionId)).events.filter((e) => e.type === "action_checked").at(-1)!;
    expect((check.payload as PayloadOf<"action_checked">).decision).toBe("allow");
    expect(t.link.says()).toHaveLength(1);
  });

  it("an amount the model said itself fails the check: the audio is cleared, a correction is spoken, and the block is recorded", async () => {
    const t = await setup();
    await t.startCall();
    await until(() => t.link.says().length === 1);
    t.done([t.spoken("x")], { kritva: "say", message_id: t.link.says()[0]!.messageId });
    t.link.emit({ type: "input_audio_buffer.committed", item_id: "item_c1" });
    t.link.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_c1", transcript: "Can you do it cheaper?" });
    t.done([t.spoken("Sure, I can do ₹17,500 for you.")]);
    await until(() => t.link.says().length === 2);
    expect(t.link.sent.some((e) => e.type === "output_audio_buffer.clear")).toBe(true);
    expect(t.link.says()[1]!.text).toMatch(/You just said something you should not have/);
    const blocked = (await t.record.context(t.sessionId)).events.filter((e) => e.type === "action_checked").map((e) => e.payload as PayloadOf<"action_checked">);
    expect(blocked.some((c) => c.decision === "block" && c.reasons.some((r) => r.rule === "unplanned_amount"))).toBe(true);
  });

  it("an acknowledgement that claims agreement is corrected before the engine's reply", async () => {
    const t = await setup();
    await t.startCall();
    await until(() => t.link.says().length === 1);
    t.done([t.spoken("x")], { kritva: "say", message_id: t.link.says()[0]!.messageId });
    t.llm.interpretations.push(t.offer(19_000));
    t.link.emit({ type: "input_audio_buffer.committed", item_id: "item_d1" });
    t.done([t.spoken("Great, we have a deal!"), { type: "function_call", name: "negotiate", call_id: "call_2", arguments: JSON.stringify({ their_words: "I'll pay 19000", language: "en" }) }]);
    await until(() => t.link.says().length === 2);
    expect(t.link.says()[1]!.text).toMatch(/You just said something you should not have/);
  });

  it("the engine's reply spoken with a different amount is said again, once", async () => {
    const t = await setup();
    await t.startCall();
    await until(() => t.link.says().length === 1);
    const greeting = t.link.says()[0]!;
    t.done([t.spoken("Hi, the price is ₹21,000.")], { kritva: "say", message_id: greeting.messageId });
    await until(() => t.link.says().length === 2);
    expect(t.link.says()[1]).toEqual(greeting);
    t.done([t.spoken("Hi, the price is ₹21,000.")], { kritva: "say", message_id: greeting.messageId });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.link.says()).toHaveLength(2);
  });

  it("a message the engine records during the call (for example after an approval) is spoken once", async () => {
    const t = await setup();
    await t.startCall();
    await until(() => t.link.says().length === 1);
    t.done([t.spoken("x")], { kritva: "say", message_id: t.link.says()[0]!.messageId });
    const line = await t.engine.recordVoiceLine({ sessionId: t.sessionId, text: "Thanks for waiting.", reason: "test" });
    expect(line.ok).toBe(true);
    await until(() => t.link.says().length === 2, 4_000);
    expect(t.link.says()[1]!.text).toBe("Thanks for waiting.");
    await new Promise((r) => setTimeout(r, 1_500));
    expect(t.link.says()).toHaveLength(2);
  });
});

describe("Realtime voice: what the engine reads", () => {
  const dealTurn = async (transcript: string, modelWords: string) => {
    const t = await setup();
    await t.startCall();
    await until(() => t.link.says().length === 1);
    t.done([t.spoken("x")], { kritva: "say", message_id: t.link.says()[0]!.messageId });
    t.link.emit({ type: "input_audio_buffer.committed", item_id: "item_e1" });
    t.link.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_e1", transcript });
    t.done([t.spoken("Got it."), { type: "function_call", name: "negotiate", call_id: "call_e", arguments: JSON.stringify({ their_words: modelWords, language: "ta" }) }]);
    await until(() => t.link.says().length === 2);
    return (await t.messages()).find((m) => m.direction === "inbound")!.text;
  };

  it("reads the dedicated transcript when it carries the same amounts as the voice model heard", async () => {
    expect(await dealTurn("இதன் விலை எவ்வளவு?", "டெலிவரி விலை எவ்வளவு?")).toBe("இதன் விலை எவ்வளவு?");
  });

  it("reads the voice model's words when it heard an amount the transcript wrote in words", async () => {
    expect(await dealTurn("मैं अठारह हज़ार दूँगा", "मैं 18000 दूँगा")).toBe("मैं 18000 दूँगा");
  });
});

describe("Realtime voice: language", () => {
  it("reads the language from the script", () => {
    expect(scriptLanguage("मैं 18000 दूँगा")).toBe("hi");
    expect(scriptLanguage("இதன் விலை எவ்வளவு?")).toBe("ta");
    expect(scriptLanguage("How much is it?")).toBe("en");
  });

  it("the engine is told the language they spoke on a live call", async () => {
    const t = await setup();
    const briefs: string[] = [];
    const generate = t.llm.generate.bind(t.llm);
    t.llm.generate = async (request) => {
      if (request.purpose === "compose_reply") briefs.push(JSON.stringify(request.messages));
      return generate(request);
    };
    await t.engine.handleCounterpartyMessage({ sessionId: t.sessionId, text: "இதன் விலை எவ்வளவு?", channel: "voice", messageId: "msg_lang1", language: "ta" });
    expect(briefs.join(" ")).toMatch(/Tamil/);
  });
});

describe("Realtime voice: no silence during a wait (the agent decides)", () => {
  const reports = (link: FakeLink) => link.sent.filter((e) => e.type === "response.create" && e.response.metadata?.kritva === "wait");

  it("while the engine works, a quiet stretch is reported to the agent with stay_quiet; what it says is checked and kept as a fragment, never a message", async () => {
    const t = await setup();
    const slow = t.engine.handleCounterpartyMessage.bind(t.engine);
    t.engine.handleCounterpartyMessage = async (input) => {
      await new Promise((r) => setTimeout(r, 500));
      return slow(input);
    };
    const call = new RealtimeCall({ engine: t.engine, record: t.record, sessionId: t.sessionId, link: t.link, afterSeq: 0, waitSensor: { quietMs: 80, sampleMs: 20 } });
    t.llm.interpretations.push(t.offer(15_000));
    t.link.emit({ type: "input_audio_buffer.committed", item_id: "item_w1" });
    t.link.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_w1", transcript: "I'll pay 15000" });
    t.done([t.spoken("Hmm, okay."), { type: "function_call", name: "negotiate", call_id: "call_w", arguments: JSON.stringify({ their_words: "I'll pay 15000", language: "en" }) }]);
    await until(() => reports(t.link).length >= 1, 2_000);
    const report = reports(t.link)[0]!;
    expect(report.response.tools.map((x: { name: string }) => x.name)).toEqual(["stay_quiet"]);
    expect(String(report.response.instructions)).toMatch(/still working out your reply/);
    expect(String(report.response.instructions)).toMatch(/Hmm, okay\./);
    // The agent speaks once, then stays quiet; the realtime API finishes each response.
    let answered = 0;
    const end = Date.now() + 4_000;
    while (!t.link.says().some((x) => x.messageId) && Date.now() < end) {
      while (answered < reports(t.link).length) {
        answered += 1;
        if (answered === 1) t.done([t.spoken("Mm, still here.")], { kritva: "wait" });
        else t.done([{ type: "function_call", name: "stay_quiet", call_id: `quiet_${answered}`, arguments: "{}" }], { kritva: "wait" });
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(t.link.says().some((x) => x.messageId)).toBe(true);
    const fragments = (await t.record.context(t.sessionId)).events.filter((e) => e.type === "transcript_fragment").map((e) => (e.payload as PayloadOf<"transcript_fragment">).text);
    expect(fragments).toContain("Mm, still here.");
    expect((await t.messages()).some((m) => m.text === "Mm, still here.")).toBe(false);
    call.close();
  });

  it("while the decision is pending, nothing fills the line: the caller is answering the wrap-up, and the decision comes after the call", async () => {
    const t = await setup();
    let status = "active";
    const record = new Proxy(t.record, {
      get(target, prop, receiver) {
        if (prop === "context") return async (id: string) => ({ ...(await target.context(id)), status });
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const call = new RealtimeCall({ engine: t.engine, record, sessionId: t.sessionId, link: t.link, afterSeq: 0, pollMs: 25, waitSensor: { quietMs: 80, sampleMs: 20 } });
    await call.start();
    t.done([t.spoken("x")], { kritva: "say", message_id: t.link.says()[0]?.messageId ?? "none" });
    await new Promise((r) => setTimeout(r, 250));
    expect(reports(t.link)).toHaveLength(0);
    status = "awaiting_approval";
    await new Promise((r) => setTimeout(r, 400));
    expect(reports(t.link)).toHaveLength(0);
    call.close();
  });

  it("words the agent says in a pause that break a limit are corrected", async () => {
    const t = await setup();
    let status = "agreed";
    const record = new Proxy(t.record, {
      get(target, prop, receiver) {
        if (prop === "context") return async (id: string) => ({ ...(await target.context(id)), status });
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const call = new RealtimeCall({ engine: t.engine, record, sessionId: t.sessionId, link: t.link, afterSeq: 0, pollMs: 25, waitSensor: { quietMs: 60, sampleMs: 20, overQuietMs: 60 }, hangup: async () => undefined });
    await call.start();
    t.done([t.spoken("x")], { kritva: "say", message_id: t.link.says()[0]?.messageId ?? "none" });
    await until(() => reports(t.link).length >= 1, 2_000);
    t.done([t.spoken("Good news, it's a deal at ₹17,000!")], { kritva: "wait", situation: "over" });
    await until(() => t.link.says().some((x) => /You just said something you should not have/.test(x.text)), 2_000);
    status = "active";
    call.close();
  });
});

describe("Realtime voice: the agent knows when the call is over, and ends it gracefully", () => {
  const endCall = (call_id = "call_end", reason = "They said goodbye.") => ({ type: "function_call", name: "end_call", call_id, arguments: JSON.stringify({ reason }) });
  /** A finished response with an id, so its playback can be reported. */
  const finish = (t: Awaited<ReturnType<typeof setup>>, id: string, output: Array<Record<string, unknown>>, metadata: Record<string, string> | null = null, status = "completed") => {
    t.link.emit({ type: "response.created", response: { id, metadata } });
    t.link.emit({ type: "response.done", response: { id, status, metadata, output } });
  };
  const outputs = (link: FakeLink) =>
    link.sent.filter((e) => e.type === "conversation.item.create" && e.item?.type === "function_call_output").map((e) => ({ callId: e.item.call_id as string, ...JSON.parse(e.item.output) }));
  const waitFor = async (check: () => Promise<boolean> | boolean, ms = 3_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  async function live(t: Awaited<ReturnType<typeof setup>>, status: (() => string) | null = null, waitSensor: Partial<{ quietMs: number; sampleMs: number; overQuietMs: number }> = {}) {
    let hangups = 0;
    const logs: Array<Record<string, unknown>> = [];
    const record = status
      ? new Proxy(t.record, {
          get(target, prop, receiver) {
            if (prop === "context") return async (id: string) => ({ ...(await target.context(id)), status: status() });
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : t.record;
    const call = new RealtimeCall({ engine: t.engine, record, sessionId: t.sessionId, link: t.link, afterSeq: 0, pollMs: 25, waitSensor, log: (e) => logs.push(e), hangup: async () => void (hangups += 1) });
    await call.start();
    t.done([t.spoken("x")], { kritva: "say", message_id: t.link.says()[0]?.messageId ?? "none" });
    return { call, logs, hangups: () => hangups };
  }
  const theySay = (t: Awaited<ReturnType<typeof setup>>, item: string, words: string) => {
    t.link.emit({ type: "input_audio_buffer.committed", item_id: item });
    t.link.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: item, transcript: words });
  };

  it("every call gets end_call and the plain-text guide on when a call is over", async () => {
    const t = await setup();
    await t.startCall();
    const session = t.connector.sessions[0]!;
    expect(session.tools.map((x: { name: string }) => x.name)).toEqual(["negotiate", "end_call"]);
    expect(session.instructions).toMatch(/Ending the call/);
    expect(session.instructions).toMatch(/Say the goodbye first, then call end_call/);
    // An engine reply may close the call too: the agent decides after saying it.
    await until(() => t.link.says().length === 1);
    const say = t.link.sent.find((e) => e.type === "response.create" && e.response.metadata?.kritva === "say")!;
    expect(say.response.tools.map((x: { name: string }) => x.name)).toEqual(["end_call"]);
  });

  it("they say goodbye: the agent's goodbye is kept and checked, and the call hangs up only once it has played", async () => {
    const t = await setup();
    const { call, hangups, logs } = await live(t);
    theySay(t, "item_bye", "Okay, thanks, bye!");
    finish(t, "resp_bye", [t.spoken("Thanks so much for your time. Take care, bye!"), endCall()]);
    await waitFor(() => logs.some((l) => l.kind === "ending"));
    await new Promise((r) => setTimeout(r, 200));
    expect(hangups()).toBe(0);
    t.link.emit({ type: "output_audio_buffer.stopped", response_id: "resp_bye" });
    await waitFor(() => hangups() === 1);
    expect(call.closed).toBe(true);
    expect(logs.find((l) => l.kind === "call_ended_by_agent")?.reason).toBe("They said goodbye.");
    expect((await t.messages()).some((m) => m.direction === "outbound" && /Take care, bye!/.test(m.text))).toBe(true);
  });

  it("they start talking before the goodbye has played: nothing hangs up, and the agent hears the call goes on", async () => {
    const t = await setup();
    const { call, hangups, logs } = await live(t);
    theySay(t, "item_bye2", "Okay, bye then.");
    finish(t, "resp_bye2", [t.spoken("Bye, take care!"), endCall("call_end2")]);
    await waitFor(() => logs.some((l) => l.kind === "ending"));
    t.link.emit({ type: "input_audio_buffer.speech_started" });
    t.link.emit({ type: "output_audio_buffer.stopped", response_id: "resp_bye2" });
    await new Promise((r) => setTimeout(r, 700));
    expect(hangups()).toBe(0);
    expect(call.closed).toBe(false);
    expect(outputs(t.link).find((o) => o.callId === "call_end2")).toMatchObject({ ended: false });
    call.close();
  });

  it("end_call with no goodbye: the agent is asked for its goodbye first, and nothing hangs up on silence", async () => {
    const t = await setup();
    const { call, hangups } = await live(t);
    theySay(t, "item_bye3", "That's all, thanks.");
    finish(t, "resp_silent", [endCall("call_end3")]);
    await waitFor(() => outputs(t.link).some((o) => o.callId === "call_end3"));
    expect(outputs(t.link).find((o) => o.callId === "call_end3")!.note).toMatch(/goodbye/);
    const asked = t.link.sent.filter((e) => e.type === "response.create" && !e.response.metadata && e.response.tools?.[0]?.name === "end_call");
    expect(asked).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(hangups()).toBe(0);
    call.close();
  });

  it("a goodbye that breaks a rule is corrected, and the call goes on", async () => {
    const t = await setup();
    const { call, hangups } = await live(t);
    theySay(t, "item_bye4", "Fine, bye.");
    finish(t, "resp_bad", [t.spoken("Great, ₹17,500 it is then. Bye!"), endCall("call_end4")]);
    await waitFor(() => t.link.says().some((x) => /You just said something you should not have/.test(x.text)));
    await waitFor(() => outputs(t.link).some((o) => o.callId === "call_end4"));
    expect(outputs(t.link).find((o) => o.callId === "call_end4")).toMatchObject({ ended: false });
    t.link.emit({ type: "output_audio_buffer.stopped", response_id: "resp_bad" });
    await new Promise((r) => setTimeout(r, 600));
    expect(hangups()).toBe(0);
    call.close();
  });

  it("an engine reply closes the call when they had already said goodbye: it hangs up once the reply has played", async () => {
    const t = await setup();
    const { call, hangups } = await live(t);
    t.llm.interpretations.push({ intent: "other", ends_negotiation: true });
    theySay(t, "item_walk", "I'm not interested anymore, bye.");
    t.done([t.spoken("Okay."), { type: "function_call", name: "negotiate", call_id: "call_walk", arguments: JSON.stringify({ their_words: "I'm not interested anymore, bye.", language: "en" }) }]);
    await waitFor(() => t.link.says().length === 2);
    const reply = t.link.says()[1]!;
    finish(t, "resp_close", [t.spoken(reply.text), endCall("call_end5", "They walked away and said goodbye.")], { kritva: "say", message_id: reply.messageId });
    t.link.emit({ type: "output_audio_buffer.stopped", response_id: "resp_close" });
    await waitFor(() => hangups() === 1);
    expect(call.closed).toBe(true);
  });

  it("after the negotiation has finished, a quiet line is reported to the agent, which may say goodbye and end the call", async () => {
    const t = await setup();
    let status = "active";
    const { call, hangups } = await live(t, () => status, { sampleMs: 20, overQuietMs: 80 });
    const reports = () => t.link.sent.filter((e) => e.type === "response.create" && e.response.metadata?.situation === "over");
    await new Promise((r) => setTimeout(r, 250));
    expect(reports()).toHaveLength(0);
    status = "agreed";
    await waitFor(() => reports().length >= 1);
    const report = reports()[0]!;
    expect(report.response.tools.map((x: { name: string }) => x.name)).toEqual(["end_call", "stay_quiet"]);
    expect(String(report.response.instructions)).toMatch(/the negotiation has agreed/);
    finish(t, "resp_over", [t.spoken("Thanks again, looking forward to it. Bye!"), endCall("call_end6", "The deal is done and the line went quiet.")], { kritva: "wait", situation: "over" });
    t.link.emit({ type: "output_audio_buffer.stopped", response_id: "resp_over" });
    await waitFor(() => hangups() === 1);
    // Out of band, the end_call is not in the conversation, so it gets no output.
    expect(outputs(t.link).some((o) => o.callId === "call_end6")).toBe(false);
    expect(call.closed).toBe(true);
  });
});

describe("Realtime voice: short lines from the voice-lines guide", () => {
  it("a correction is worded by the agent from the guide; an empty one falls back to the guide's fixed line once", async () => {
    const t = await setup();
    await t.startCall();
    await until(() => t.link.says().length === 1);
    t.done([t.spoken("x")], { kritva: "say", message_id: t.link.says()[0]!.messageId });
    t.link.emit({ type: "input_audio_buffer.committed", item_id: "item_l1" });
    t.link.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_l1", transcript: "Can you do it cheaper?" });
    t.done([t.spoken("Sure, I can do ₹17,500 for you.")]);
    await until(() => t.link.says().length === 2);
    const line = t.link.sent.filter((e) => e.type === "response.create").at(-1)!.response;
    expect(line.metadata).toMatchObject({ kritva: "line", kind: "correction" });
    expect(line.tool_choice).toBe("none");
    // The agent said nothing: the guide's fallback is said word for word, once.
    t.done([], { kritva: "line", kind: "correction" });
    await until(() => t.link.says().length === 3);
    expect(t.link.says()[2]!.text).toMatch(/ignore that/i);
    t.done([t.spoken("Sorry, please ignore that. Let me get it right.")], { kritva: "say", message_id: t.link.says()[2]!.messageId });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.link.says()).toHaveLength(3);
  });
});

describe("Realtime voice: one greeting", () => {
  it("while the opening line is being written, the model's own answer to their Hello is cancelled, so the call greets once", async () => {
    const t = await setup();
    const call = new RealtimeCall({ engine: t.engine, record: t.record, sessionId: t.sessionId, link: t.link, afterSeq: 0, waitSensor: { quietMs: 80, sampleMs: 20 } });
    const started = call.start();
    // They said "Hello" and the model started answering on its own before the engine's opening line was ready.
    t.link.emit({ type: "response.created", response: { id: "resp_auto" } });
    // The cancelled response reports done, as the realtime API does after response.cancel.
    t.link.emit({ type: "response.done", response: { id: "resp_auto", status: "cancelled", output: [] } });
    await started;
    await until(() => t.link.says().length === 1);
    call.close();
    expect(t.link.sent.some((e) => e.type === "response.cancel")).toBe(true);
    expect(t.link.says()).toHaveLength(1);
  });

  it("a bare Hello, Hi or Haan says nothing about their language", async () => {
    const { isGreetingOnly } = await import("../src/realtime-voice.ts");
    for (const hello of ["Hello.", "Hi", "Haan ji", "हेलो", "Hello? Hello?"]) expect(isGreetingOnly(hello), hello).toBe(true);
    for (const sentence of ["Hello, what's the price?", "Okay, tell me in English", "हेलो, कितने का है?"]) expect(isGreetingOnly(sentence), sentence).toBe(false);
  });
});
