import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rms16, sentences, stripWav, wav16 } from "../src/phone/audio.ts";
import { StreamCall } from "../src/phone/stream-call.ts";
import { streamXml, vobizSettingsFromEnv, vobizSignatureValid, type VobizCalls, type VobizSettings } from "../src/phone/vobiz.ts";
import { VobizPhone } from "../src/phone/vobiz-phone.ts";
import type { PhoneSpeech } from "../src/phone/sarvam.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(10);
  }
}

/** 20 ms of 16-bit PCM at 8 kHz: loud (a square wave) or silent. */
function frame(loud: boolean): string {
  const pcm = new Int16Array(160);
  if (loud) for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 ? 3000 : -3000;
  return Buffer.from(pcm.buffer).toString("base64");
}

/** A record and engine that keep messages in memory, enough for one call. */
function fakes() {
  type Ev = { id: string; seq: number; type: string; channel: string | null; payload: Record<string, unknown> };
  const events: Ev[] = [];
  const put = (e: Omit<Ev, "seq">) => {
    const ev = { ...e, seq: events.length + 1 };
    events.push(ev);
    return ev;
  };
  const say = (text: string, id = `m${events.length + 1}`) => put({ id, type: "message", channel: "voice", payload: { direction: "outbound", text, offerIds: [] } });
  const deliveries: Array<{ messageId: string; status: string; deliveredText: string | null | undefined }> = [];
  const turns: Array<{ text: string; language: string | null | undefined }> = [];
  let endCall = false;
  const record = {
    context: async () => ({ events }),
    append: async (_s: string, e: Omit<Ev, "seq">) => ({ ok: true, event: put(e) }),
  };
  const engine = {
    greet: async () => ({ ok: true, reply: { messageId: say("नमस्ते, मैं Kritva हूँ।", "greet").id } }),
    handleCounterpartyMessage: async (input: { text: string; language?: string | null }) => {
      turns.push({ text: input.text, language: input.language });
      const reply = say("बीस हज़ार final है। आप ले लेंगे?", `r${turns.length}`);
      return { ok: true, reply: { messageId: reply.id, text: "x", offerIds: [], channel: "voice" }, endCall };
    },
    reportDelivery: async (input: { messageId: string; status: string; deliveredText?: string | null }) => {
      deliveries.push({ messageId: input.messageId, status: input.status, deliveredText: input.deliveredText });
      return { id: "d" };
    },
    recordVoiceLine: async (input: { text: string }) => ({ ok: true, replyId: say(input.text).id }),
    voiceBriefing: async () => ({ status: "active" }),
  };
  return { events, record, engine, deliveries, turns, setEndCall: (v: boolean) => (endCall = v) };
}

/** Speech that hears a fixed sentence and speaks 0.3 s of audio per sentence. */
const speech: PhoneSpeech = {
  transcribe: async () => ({ text: "बीस हज़ार में दे दो", language: "hi" }),
  speak: async () => new Uint8Array(8000 * 2 * 0.3),
};

function call(over: Partial<ConstructorParameters<typeof StreamCall>[0]> = {}) {
  const f = fakes();
  const sent: Array<Record<string, any>> = [];
  let closed = false;
  const ended: string[] = [];
  const c = new StreamCall({
    engine: f.engine as never,
    record: f.record as never,
    sessionId: "ses_1",
    speech,
    socket: { send: (t) => sent.push(JSON.parse(t)), close: () => (closed = true) },
    direction: "outbound",
    settings: { idleMs: 60_000, maxCallMs: 60_000 },
    pollMs: 20,
    onEnded: (reason) => ended.push(reason),
    ...over,
  });
  const start = () => c.message(JSON.stringify({ event: "start", start: { callId: "c1", streamId: "s1", mediaFormat: { encoding: "audio/x-l16", sampleRate: 8000 } } }));
  const speak = async (ms: number, loud = true) => {
    for (let t = 0; t < ms; t += 20) await c.message(JSON.stringify({ event: "media", media: { track: "inbound", payload: frame(loud) } }));
  };
  return { c, f, sent, ended, start, speak, isClosed: () => closed };
}

describe("Phone audio helpers", () => {
  it("measures loudness, wraps and unwraps WAV, and splits replies into sentences", () => {
    const loud = new Uint8Array(Buffer.from(frame(true), "base64"));
    expect(Math.round(rms16(loud))).toBe(3000);
    expect(rms16(new Uint8Array(320))).toBe(0);
    const wav = wav16(loud, 8000);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(stripWav(wav)).toEqual(loud);
    expect(stripWav(loud)).toBe(loud);
    expect(sentences("बीस हज़ार final है। आप ले लेंगे? Okay, let me know by tonight.")).toEqual(["बीस हज़ार final है। आप ले लेंगे?", "Okay, let me know by tonight."]);
  });
});

describe("Vobiz settings, answer XML and signatures", () => {
  const env = { VOBIZ_AUTH_ID: "MA_TEST", VOBIZ_AUTH_TOKEN: "secret-token", KRITVA_VOBIZ_NUMBER: "+91 80 6426 4194", KRITVA_PUBLIC_URL: "https://kritva.example/", KRITVA_PHONE_OUTBOUND_ALLOW: "+919876543210" };

  it("reads the line, the default incoming route and the allowlist", () => {
    const { settings, problems } = vobizSettingsFromEnv(env, "bed-sale");
    expect(problems).toEqual([]);
    expect(settings).toMatchObject({ number: "918064264194", publicUrl: "https://kritva.example", inbound: { kind: "listing", caseId: "bed-sale" }, allow: ["919876543210"], verify: true });
    expect(vobizSettingsFromEnv({ ...env, KRITVA_PUBLIC_URL: "http://x" }, null).settings).toBeNull();
  });

  it("streams both ways and keeps the call up while the stream lasts", () => {
    const xml = streamXml("wss://kritva.example/api/phone/vobiz/stream?t=a&b", 660);
    expect(xml).toContain('bidirectional="true"');
    expect(xml).toContain('keepCallAlive="true"');
    expect(xml).toContain('contentType="audio/x-l16;rate=8000"');
    expect(xml).toContain("stream?t=a&amp;b</Stream>");
  });

  it("accepts V3 and V2 signatures over the public base URL, and nothing else", () => {
    const base = "https://kritva.example/api/phone/vobiz/answer";
    const sign = (msg: string) => createHmac("sha256", "secret-token").update(msg).digest("base64");
    const headers = (h: Record<string, string>) => (name: string) => h[name];
    const check = (h: Record<string, string>) => vobizSignatureValid({ publicUrl: "https://kritva.example", requestUrl: "http://internal:8787/api/phone/vobiz/answer?t=x", authToken: "secret-token", header: headers(h) });
    expect(check({ "x-vobiz-signature-v3": sign(`${base}.123`), "x-vobiz-signature-v3-nonce": "123" })).toBe(true);
    expect(check({ "x-vobiz-signature-v2": sign(`${base}456`), "x-vobiz-signature-v2-nonce": "456" })).toBe(true);
    expect(check({ "x-vobiz-signature-v3": sign(`${base}.123`), "x-vobiz-signature-v3-nonce": "124" })).toBe(false);
    expect(check({})).toBe(false);
  });
});

describe("A Vobiz call (StreamCall)", () => {
  it("records the connection, speaks the greeting, and counts it heard when Vobiz confirms", async () => {
    const t = call();
    await t.start();
    expect(t.f.events.find((e) => e.type === "voice_connection")?.payload).toMatchObject({ status: "connected", transport: "phone", direction: "outbound" });
    await until(() => t.sent.some((e) => e.event === "checkpoint"));
    expect(t.sent.filter((e) => e.event === "playAudio").every((e) => e.streamId === "s1" && e.media.contentType === "audio/x-l16" && e.media.sampleRate === 8000)).toBe(true);
    expect(t.sent.find((e) => e.event === "checkpoint")).toMatchObject({ name: "greet" });
    await t.c.message(JSON.stringify({ event: "playedStream", name: "greet" }));
    await until(() => t.f.deliveries.length === 1);
    expect(t.f.deliveries[0]).toMatchObject({ messageId: "greet", status: "delivered" });
    await t.c.end("server");
  });

  it("hands an utterance to the engine with its language, and speaks only the engine's recorded reply", async () => {
    const t = call();
    await t.start();
    await until(() => t.sent.some((e) => e.event === "checkpoint"));
    await t.c.message(JSON.stringify({ event: "playedStream", name: "greet" }));
    await t.speak(400);
    await t.speak(800, false);
    await until(() => t.f.turns.length === 1);
    expect(t.f.turns[0]).toEqual({ text: "बीस हज़ार में दे दो", language: "hi" });
    await until(() => t.sent.some((e) => e.event === "checkpoint" && e.name === "r1"));
    await t.c.end("server");
  });

  it("stops when the caller talks over it and records the reply as interrupted", async () => {
    const t = call();
    await t.start();
    await until(() => t.sent.some((e) => e.event === "playAudio"));
    await t.speak(400);
    await until(() => t.sent.some((e) => e.event === "clearAudio"));
    await until(() => t.f.deliveries.length === 1);
    expect(t.f.deliveries[0]).toMatchObject({ messageId: "greet", status: "interrupted" });
    await t.c.end("server");
  });

  it("ignores short noise", async () => {
    const t = call();
    await t.start();
    await t.speak(100);
    await t.speak(800, false);
    await wait(50);
    expect(t.f.turns).toHaveLength(0);
    await t.c.end("server");
  });

  it("hangs up after a reply the engine marks as the end, once it is heard", async () => {
    const t = call();
    t.f.setEndCall(true);
    await t.start();
    await until(() => t.sent.some((e) => e.event === "checkpoint"));
    await t.c.message(JSON.stringify({ event: "playedStream", name: "greet" }));
    await t.speak(400);
    await t.speak(800, false);
    await until(() => t.sent.some((e) => e.event === "checkpoint" && e.name === "r1"));
    await t.c.message(JSON.stringify({ event: "playedStream", name: "r1" }));
    await until(() => t.sent.some((e) => e.event === "stop"), 3_000);
    expect(t.ended).toEqual(["server"]);
    expect(t.f.events.at(-1)?.payload).toMatchObject({ status: "ended", reason: "server", transport: "phone" });
  });

  it("ends without hanging up when the line closes", async () => {
    const t = call();
    await t.start();
    t.c.closedByLine();
    await until(() => t.ended.length === 1);
    expect(t.ended).toEqual(["hung_up"]);
    expect(t.sent.some((e) => e.event === "stop")).toBe(false);
  });
});

describe("Vobiz phone line (webhooks, dialling and the stream)", () => {
  const settings: VobizSettings = { authId: "MA_TEST", authToken: "secret-token", number: "918064264194", publicUrl: "https://kritva.example", inbound: null, allow: ["919876543210"], maxCalls: 2, idleMs: 60_000, maxCallMs: 600_000, countryCode: "91", verify: true };
  const signedHeaders = (path: string) => {
    const nonce = "98765";
    return { "x-vobiz-signature-v3": createHmac("sha256", "secret-token").update(`https://kritva.example${path}.${nonce}`).digest("base64"), "x-vobiz-signature-v3-nonce": nonce, "content-type": "application/x-www-form-urlencoded" };
  };

  function line() {
    const f = fakes();
    const placed: Array<Record<string, unknown>> = [];
    const api: VobizCalls = { placeCall: async (c) => (placed.push(c), { callUuid: "uuid-1" }), hangup: async () => undefined };
    const phone = new VobizPhone({ engine: f.engine as never, record: f.record as never, library: null, listings: [], groups: null, liveCalls: null, settings, speech, api });
    const app = new Hono();
    phone.register(app);
    return { f, placed, phone, app };
  }

  it("dials only allowed numbers, from Kritva's line, with this call's webhooks", async () => {
    const { phone, placed } = line();
    expect((await phone.call({ sessionId: "ses_1", to: "+91 99999 00000" })).ok).toBe(false);
    const r = await phone.call({ sessionId: "ses_1", to: "98765 43210" });
    expect(r.ok && r.call).toMatchObject({ state: "dialling", to: "91******3210" });
    expect(placed[0]).toMatchObject({ from: "+918064264194", to: "+919876543210" });
    expect(String(placed[0]!.answerUrl)).toMatch(/^https:\/\/kritva\.example\/api\/phone\/vobiz\/answer\?t=[\w-]+$/);
  });

  it("answers with a stream for the call, refuses unsigned webhooks and unknown streams", async () => {
    const { phone, placed, app } = line();
    await phone.call({ sessionId: "ses_1", to: "+919876543210" });
    const answerUrl = new URL(String(placed[0]!.answerUrl));
    const token = answerUrl.searchParams.get("t")!;
    const unsigned = await app.request(`/api/phone/vobiz/answer?t=${token}`, { method: "POST", body: "CallUUID=uuid-1", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(unsigned.status).toBe(403);
    const answered = await app.request(`/api/phone/vobiz/answer?t=${token}`, { method: "POST", body: "CallUUID=uuid-1&From=%2B918064264194", headers: signedHeaders("/api/phone/vobiz/answer") });
    expect(answered.status).toBe(200);
    expect(await answered.text()).toContain(`wss://kritva.example/api/phone/vobiz/stream?t=${token}</Stream>`);
    expect(phone.listForSession("ses_1")[0]!.state).toBe("answered");
    const socket = { send: () => undefined, close: () => undefined };
    expect(phone.acceptStream("nope", socket)).toBeNull();
    const handlers = phone.acceptStream(token, socket);
    expect(handlers).not.toBeNull();
    expect(phone.acceptStream(token, socket)).toBeNull();
    handlers!.message(JSON.stringify({ event: "start", start: { callId: "uuid-1", streamId: "s1", mediaFormat: { encoding: "audio/x-l16", sampleRate: 8000 } } }));
    await until(() => phone.listForSession("ses_1")[0]!.state === "connected");
    handlers!.closed();
    await until(() => phone.listForSession("ses_1")[0]!.state === "ended");
    expect(phone.listForSession("ses_1")[0]!.outcome).toBe("completed");
  });

  it("records an unanswered call's outcome from the hangup webhook", async () => {
    const { phone, placed, app } = line();
    await phone.call({ sessionId: "ses_1", to: "+919876543210" });
    const token = new URL(String(placed[0]!.answerUrl)).searchParams.get("t")!;
    await app.request(`/api/phone/vobiz/ring?t=${token}`, { method: "POST", body: "CallStatus=ringing", headers: signedHeaders("/api/phone/vobiz/ring") });
    expect(phone.listForSession("ses_1")[0]!.state).toBe("ringing");
    await app.request(`/api/phone/vobiz/hangup?t=${token}`, { method: "POST", body: "CallStatus=no-answer&HangupCause=NO_ANSWER", headers: signedHeaders("/api/phone/vobiz/hangup") });
    expect(phone.listForSession("ses_1")[0]).toMatchObject({ state: "ended", outcome: "no_answer" });
  });

  it("declines incoming calls when no listing takes them", async () => {
    const { app } = line();
    const res = await app.request("/api/phone/vobiz/answer", { method: "POST", body: "CallUUID=u2&From=%2B919876543210&To=%2B918064264194", headers: signedHeaders("/api/phone/vobiz/answer") });
    expect(await res.text()).toContain("<Hangup/>");
  });
});
