/**
 * Phone calls (docs/Kritva_Phone_Calls.md): settings, SIP headers, webhook signatures, the
 * server-side delivery rule, and whole calls through the webhook with a fake OpenAI connection.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MandateLibrary,
  MandateRevisions,
  NegotiationEngine,
  NegotiationRecord,
  SqliteLibraryBackend,
  SqliteRecordBackend,
  type PayloadOf,
  type StructuredLlm,
  type StructuredRequest,
  type StructuredResponse,
} from "@kritva/core";
import { createApp } from "../src/app.ts";
import { loadConfirmedMandates, loadExamples, loadListings } from "../src/main-helpers.ts";
import { GLOBAL_SIP_HOST, normalizeNumber, outboundFromEnv, parseRoutes, phoneSettingsFromEnv, sipUri, type PhoneSettings } from "../src/phone/config.ts";
import { OutboundDialer, type OutboundSettings } from "../src/phone/outbound.ts";
import type { LiveCallRegistry } from "../src/phone/routes.ts";
import type { OutboundTelephony, PlaceCall } from "../src/phone/vobiz.ts";
import { heardPart, ServerPlayback, type Clock, type PlaybackReport } from "../src/phone/playback.ts";
import { callerNumber, dialledNumbers, maskNumber, routeFor } from "../src/phone/sip-headers.ts";
import { signWebhook, verifyWebhook, WebhookSignatureError } from "../src/phone/webhook-signature.ts";
import { RealtimeCallError, realtimeSettingsFromEnv, type RealtimeCall, type RealtimeCallControl, type RealtimeConnector, type RealtimeEvent, type RealtimeLink } from "../src/realtime-voice.ts";
import { FollowUpCalls, followUpSettingsFromEnv } from "../src/phone/follow-up.ts";

const CASES = resolve(import.meta.dirname, "../../../cases");
const SECRET = `whsec_${Buffer.from("kritva-phone-test-secret-0123456").toString("base64")}`;
const NUMBER = "+918071234567";

// ---------- Settings and headers ----------

describe("Phone: settings", () => {
  it("writes every number as digits with the country code", () => {
    expect(normalizeNumber("+91 80 7123 4567")).toBe("918071234567");
    expect(normalizeNumber("080-7123-4567")).toBe("918071234567");
    expect(normalizeNumber("8071234567")).toBe("918071234567");
    expect(normalizeNumber("00918071234567")).toBe("918071234567");
    expect(normalizeNumber("918071234567")).toBe("918071234567");
  });

  it("reads number=target routes: listings, saved mandates and a catch-all", () => {
    const { routes, problems } = parseRoutes("+918071234567=bed-sale, 08071234568=mandate:man_abc, *=listing:bed-sale, nonsense");
    expect(routes).toEqual([
      { number: "918071234567", target: { kind: "listing", caseId: "bed-sale" } },
      { number: "918071234568", target: { kind: "mandate", mandateId: "man_abc" } },
      { number: "*", target: { kind: "listing", caseId: "bed-sale" } },
    ]);
    expect(problems).toHaveLength(1);
  });

  it("is off without the webhook secret or routes, and defaults to the global SIP host", () => {
    expect(phoneSettingsFromEnv({}).settings).toBeNull();
    expect(phoneSettingsFromEnv({ OPENAI_WEBHOOK_SECRET: SECRET }).settings).toBeNull();
    const { settings } = phoneSettingsFromEnv({ OPENAI_WEBHOOK_SECRET: SECRET, KRITVA_PHONE_ROUTES: `${NUMBER}=bed-sale`, OPENAI_PROJECT_ID: "proj_abc" });
    expect(settings).toMatchObject({ sipHost: GLOBAL_SIP_HOST, noiseReduction: "near_field", idleMs: 30_000, maxCallMs: 15 * 60_000, maxCalls: 5 });
    expect(sipUri(settings!)).toBe("sip:proj_abc@sip.api.openai.com:5061");
  });
});

describe("Phone: SIP headers", () => {
  const headers = [
    { name: "From", value: '"Asha" <sip:+919876543210@203.0.113.5>;tag=abc' },
    { name: "To", value: "<sip:+918071234567@sip-in.api.openai.com>" },
    { name: "Call-ID", value: "a84b4c76e66710@pc33" },
  ];

  it("finds the dialled number in To, and a provider's own header first", () => {
    expect(dialledNumbers(headers)).toEqual(["918071234567"]);
    expect(dialledNumbers([{ name: "X-Vobiz-DID", value: "08071234599" }, ...headers])).toEqual(["918071234599", "918071234567"]);
    expect(dialledNumbers([{ name: "To", value: "<sip:proj_abc@sip-in.api.openai.com>" }])).toEqual([]);
  });

  it("finds the caller and masks it for logs", () => {
    expect(callerNumber(headers)).toBe("919876543210");
    expect(callerNumber([{ name: "P-Asserted-Identity", value: "<tel:+919000000001>" }, ...headers])).toBe("919000000001");
    expect(maskNumber("919876543210")).toBe("91******3210");
  });

  it("routes by the dialled number, else by the catch-all", () => {
    const { routes } = parseRoutes("+918071234567=bed-sale,*=other");
    expect(routeFor(headers, routes).route?.target).toEqual({ kind: "listing", caseId: "bed-sale" });
    expect(routeFor([{ name: "To", value: "<sip:proj_abc@x>" }], routes).route?.target).toEqual({ kind: "listing", caseId: "other" });
    expect(routeFor([{ name: "To", value: "<sip:proj_abc@x>" }], parseRoutes(`${NUMBER}=bed-sale`).routes).route).toBeNull();
  });
});

describe("Phone: webhook signatures", () => {
  const body = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: "rtc_1" } });
  const now = 1_800_000_000;
  const headers = (over: Partial<{ id: string; timestamp: string; signature: string }> = {}) => ({ id: "wh_1", timestamp: String(now), signature: signWebhook(body, "wh_1", now, SECRET), ...over });

  it("accepts OpenAI's signature, also among several", () => {
    expect(() => verifyWebhook(body, headers(), SECRET, now)).not.toThrow();
    expect(() => verifyWebhook(body, headers({ signature: `v1,AAAA ${signWebhook(body, "wh_1", now, SECRET)}` }), SECRET, now)).not.toThrow();
  });

  it("rejects a changed body, another secret, a replay after five minutes and missing headers", () => {
    expect(() => verifyWebhook(`${body} `, headers(), SECRET, now)).toThrow(WebhookSignatureError);
    expect(() => verifyWebhook(body, headers(), `whsec_${Buffer.from("another-secret").toString("base64")}`, now)).toThrow(WebhookSignatureError);
    expect(() => verifyWebhook(body, headers(), SECRET, now + 301)).toThrow(/five-minute/);
    expect(() => verifyWebhook(body, { id: undefined, timestamp: undefined, signature: undefined }, SECRET, now)).toThrow(/Missing/);
  });
});

// ---------- The delivery rule ----------

/** A clock the test moves by hand. */
class ManualClock implements Clock {
  t = 0;
  #timers: Array<{ at: number; fn: () => void; id: number }> = [];
  #next = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = (this.#next += 1);
    this.#timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.#timers = this.#timers.filter((x) => x.id !== handle);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.#timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

describe("Phone: server-side delivery", () => {
  // 56 characters: about 4 s of speech; the fallback window is 56 / 11 s + 1 s, about 6.1 s.
  const TEXT = "The price is 20000 rupees, and pickup is in Koramangala.";
  const setup = () => {
    const clock = new ManualClock();
    const reports: PlaybackReport[] = [];
    const p = new ServerPlayback({ textOf: (id) => (id === "msg_1" ? TEXT : undefined), report: (r) => reports.push(r), clock });
    const say = (responseId = "resp_1") => p.observe({ type: "response.created", response: { id: responseId, metadata: { kritva: "say", message_id: "msg_1" } } });
    const done = (status = "completed", responseId = "resp_1") => p.observe({ type: "response.done", response: { id: responseId, status, output: [{ id: "item_1", type: "message" }] } });
    return { clock, reports, p, say, done };
  };

  it("with playback events: heard to the end is delivered, with the time from their speech to the reply's audio", () => {
    const t = setup();
    t.p.observe({ type: "input_audio_buffer.speech_stopped" });
    t.clock.advance(900);
    t.say();
    t.p.observe({ type: "output_audio_buffer.started", response_id: "resp_1" });
    t.done();
    t.clock.advance(4_000);
    expect(t.reports).toHaveLength(0);
    t.p.observe({ type: "output_audio_buffer.stopped", response_id: "resp_1" });
    expect(t.reports).toEqual([{ messageId: "msg_1", status: "delivered", heardText: null, audioStartMs: 900, source: "playback_events", reason: "stopped" }]);
    expect(t.p.busy).toBe(false);
  });

  it("with playback events: a cut-off reply is interrupted, with the part OpenAI says played", () => {
    const t = setup();
    t.say();
    t.p.observe({ type: "output_audio_buffer.started", response_id: "resp_1" });
    t.done();
    t.clock.advance(1_000);
    t.p.observe({ type: "input_audio_buffer.speech_started" });
    t.p.observe({ type: "output_audio_buffer.cleared", response_id: "resp_1" });
    t.p.observe({ type: "conversation.item.truncated", item_id: "item_1", content_index: 0, audio_end_ms: 1_000 });
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]).toMatchObject({ status: "interrupted", source: "playback_events", reason: "cleared", heardText: "The price is" });
  });

  it("with playback events: without a truncation report, the heard part comes from playback time", () => {
    const t = setup();
    t.say();
    t.p.observe({ type: "output_audio_buffer.started", response_id: "resp_1" });
    t.clock.advance(2_000);
    t.p.observe({ type: "output_audio_buffer.cleared", response_id: "resp_1" });
    expect(t.reports).toHaveLength(0);
    t.clock.advance(300);
    expect(t.reports[0]).toMatchObject({ status: "interrupted", heardText: heardPart(TEXT, (2.3 * 14) / TEXT.length) });
  });

  it("a reply cancelled before any audio played was heard as nothing", () => {
    const t = setup();
    t.say();
    t.done("cancelled");
    expect(t.reports[0]).toMatchObject({ status: "interrupted", heardText: "", reason: "cancelled" });
  });

  it("a reply that starts but never reports an end is interrupted, never delivered", () => {
    const t = setup();
    t.say();
    t.p.observe({ type: "output_audio_buffer.started", response_id: "resp_1" });
    t.done();
    t.clock.advance(60_000);
    expect(t.reports[0]).toMatchObject({ status: "interrupted", reason: "no_end_event" });
  });

  it("fallback without playback events: delivered once the window passes with no speech, when the caller has been heard on the call", () => {
    const t = setup();
    t.p.observe({ type: "input_audio_buffer.speech_started" });
    t.say();
    t.p.observe({ type: "response.output_audio_transcript.delta", response_id: "resp_1", item_id: "item_1", delta: "The" });
    t.clock.advance(1_500);
    t.done();
    t.clock.advance(4_000);
    expect(t.reports).toHaveLength(0);
    t.clock.advance(1_000);
    expect(t.reports[0]).toMatchObject({ status: "delivered", source: "estimate", reason: "window_passed" });
    // Speech after the window is their reply, not an interruption.
    t.p.observe({ type: "input_audio_buffer.speech_started" });
    expect(t.reports).toHaveLength(1);
  });

  it("fallback: before the caller has been heard, a reply waits for proof that audio flows; their first words make it delivered", () => {
    const t = setup();
    t.say();
    t.p.observe({ type: "response.output_audio_transcript.delta", response_id: "resp_1", item_id: "item_1", delta: "The" });
    t.done();
    t.clock.advance(10_000);
    expect(t.reports).toHaveLength(0);
    expect(t.p.busy).toBe(false);
    t.p.observe({ type: "input_audio_buffer.speech_started" });
    expect(t.reports[0]).toMatchObject({ status: "delivered", source: "estimate", reason: "window_passed" });
  });

  it("fallback: on a call whose audio never connected, no reply counts as heard", () => {
    const t = setup();
    t.say();
    t.p.observe({ type: "response.output_audio_transcript.delta", response_id: "resp_1", item_id: "item_1", delta: "The" });
    t.done();
    t.clock.advance(10_000);
    t.p.end();
    expect(t.reports[0]).toMatchObject({ status: "interrupted", heardText: "", reason: "no_caller_audio" });
  });

  it("fallback without playback events: speech inside the window interrupts the reply", () => {
    const t = setup();
    t.say();
    t.p.observe({ type: "response.output_audio_transcript.delta", response_id: "resp_1", item_id: "item_1", delta: "The" });
    t.done();
    t.clock.advance(3_000);
    t.p.observe({ type: "input_audio_buffer.speech_started" });
    t.clock.advance(300);
    expect(t.reports[0]).toMatchObject({ status: "interrupted", source: "estimate", reason: "speech" });
    expect(TEXT.startsWith(t.reports[0]!.heardText!)).toBe(true);
    expect(t.reports[0]!.heardText!.length).toBeGreaterThan(20);
  });

  it("the call ending while a reply plays makes it interrupted", () => {
    const t = setup();
    t.say();
    t.p.observe({ type: "output_audio_buffer.started", response_id: "resp_1" });
    t.clock.advance(500);
    t.p.end();
    expect(t.reports[0]).toMatchObject({ status: "interrupted", reason: "call_ended" });
  });

  it("only Kritva's recorded replies are reported, not the voice model's own words", () => {
    const t = setup();
    t.p.observe({ type: "response.created", response: { id: "resp_own", metadata: null } });
    t.p.observe({ type: "output_audio_buffer.started", response_id: "resp_own" });
    t.p.observe({ type: "output_audio_buffer.stopped", response_id: "resp_own" });
    expect(t.reports).toHaveLength(0);
  });
});

// ---------- Whole calls ----------

class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Array<Record<string, unknown>> = [];
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const reply = (json: unknown) => ({ json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 });
    if (request.purpose === "language_check") return reply({ concerns: [] });
    if (request.purpose === "interpret_counterparty") {
      return reply({ intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, offer_kind: "none", offer_conditions: [], ends_negotiation: false, corrects_previous: false, pressure: "none", notes: [], answers: [], new_terms: [], questions: [], ...this.interpretations.shift() });
    }
    throw new Error("template wording");
  }
}

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
  /** OpenAI closes the sideband when the caller hangs up. */
  hangUp() {
    this.onClose?.();
  }
  says() {
    return this.sent.filter((e) => e.type === "response.create").map((e) => ({ text: String(e.response.instructions).split("\n").slice(1).join("\n"), messageId: e.response.metadata?.message_id as string }));
  }
}

class FakeConnector implements RealtimeConnector, RealtimeCallControl {
  readonly link = new FakeLink();
  readonly accepted: Array<{ callId: string; session: Record<string, any> }> = [];
  readonly rejected: Array<{ callId: string; statusCode: number }> = [];
  readonly hungUp: string[] = [];
  attached = 0;
  acceptAttempts = 0;
  /** Errors for the next accept attempts, in order. */
  acceptErrors: Error[] = [];
  async createCall(): Promise<{ sdpAnswer: string; callId: string }> {
    throw new Error("not a browser call");
  }
  async attach() {
    this.attached += 1;
    return this.link;
  }
  async accept(callId: string, session: Record<string, unknown>) {
    this.acceptAttempts += 1;
    const error = this.acceptErrors.shift();
    if (error) throw error;
    this.accepted.push({ callId, session });
  }
  async reject(callId: string, statusCode: number) {
    this.rejected.push({ callId, statusCode });
  }
  async hangup(callId: string) {
    this.hungUp.push(callId);
  }
}

const until = async (check: () => boolean | Promise<boolean>, ms = 4_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Records what Kritva asks Vobiz to do. */
class FakeTelephony implements OutboundTelephony {
  readonly placed: PlaceCall[] = [];
  readonly hungUp: string[] = [];
  failNext: Error | null = null;
  async placeCall(call: PlaceCall) {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.placed.push(call);
    return { providerCallId: `vobiz_${this.placed.length}` };
  }
  async hangup(providerCallId: string) {
    this.hungUp.push(providerCallId);
  }
}

const COUNTERPARTY = "+919812345678";

/** Records what the phone routes tell the live-call registry. */
class FakeLiveCalls implements LiveCallRegistry {
  readonly events: Array<{ kind: "register" | "unregister"; sessionId: string; contact?: string | null }> = [];
  register(sessionId: string, _call: RealtimeCall, contact: string | null) {
    this.events.push({ kind: "register", sessionId, contact });
  }
  unregister(sessionId: string) {
    this.events.push({ kind: "unregister", sessionId });
  }
}

function setup(options: { library?: boolean; settings?: Partial<PhoneSettings>; outbound?: Partial<OutboundSettings>; injectDialer?: boolean; followUps?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kritva-phone-"));
  const db = join(dir, "db.sqlite");
  const record = new NegotiationRecord(new SqliteRecordBackend(db));
  const llm = new ScriptedLlm();
  const mandates = loadConfirmedMandates(CASES);
  const examples = loadExamples(CASES);
  const library = options.library === false ? null : new MandateLibrary({ backend: new SqliteLibraryBackend(db), mappingLlm: llm });
  const listings = loadListings(CASES, mandates, examples, library);
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", subjectFacts: new Map([["bed-sale", "fact_f_item"]]), listingDetails: new Map(listings.map((l) => [l.caseId, l])) });
  const connector = new FakeConnector();
  const telephony = new FakeTelephony();
  const liveCalls = new FakeLiveCalls();
  let injected: OutboundDialer | null = null;
  const outboundSettings: OutboundSettings = { callerId: "918064264194", publicUrl: "https://kritva.example.test", bridgeUri: "sip:proj_test@sip.api.openai.com:5061;transport=tls", allow: [normalizeNumber(COUNTERPARTY)], maxCalls: 5, timeLimitSeconds: 900, countryCode: "91", ...options.outbound };
  const settings: PhoneSettings = { webhookSecret: SECRET, projectId: "proj_test", sipHost: GLOBAL_SIP_HOST, routes: parseRoutes(`${NUMBER}=bed-sale`).routes, countryCode: "91", noiseReduction: "near_field", idleMs: 60_000, maxCallMs: 600_000, maxCalls: 5, acceptMode: "minimal", trace: false, ...options.settings };
  const logs: Array<Record<string, unknown>> = [];
  /** A fake Vobiz: each Make Call request is kept; retries run at once. */
  const followUpVobiz = { calls: [] as Array<{ url: string; body: Record<string, any> }>, fail: false };
  const followUps = options.followUps
    ? new FollowUpCalls({
        record,
        engine,
        settings: followUpSettingsFromEnv({ VOBIZ_AUTH_ID: "MA_TEST", VOBIZ_AUTH_TOKEN: "tok", KRITVA_FOLLOW_UP_FROM: "+91 80 7123 4567", KRITVA_PUBLIC_URL: "https://kritva.example" }, sipUri(settings)).settings!,
        fetch: (async (url: string, init: RequestInit) => {
          followUpVobiz.calls.push({ url, body: JSON.parse(String(init.body)) });
          return new Response(JSON.stringify(followUpVobiz.fail ? { message: "no" } : { request_uuid: `vb_${followUpVobiz.calls.length}` }), { status: followUpVobiz.fail ? 400 : 200 });
        }) as typeof fetch,
        later: (fn) => fn(),
        log: (e) => logs.push(e),
      })
    : null;
  const app = createApp({
    followUps,
    record,
    engine,
    revisions: new MandateRevisions({ record, engine, mappingLlm: llm }),
    mandates,
    locale: "en-IN",
    library: library ?? undefined,
    examples,
    listings,
    realtime: { connector, settings: realtimeSettingsFromEnv({}) },
    phone: { settings, connector, log: (e) => logs.push(e), pollMs: 40, acceptBackoffMs: [0, 0, 0], outbound: options.outbound && !options.injectDialer ? { telephony, settings: outboundSettings } : null },
    dialer: options.injectDialer ? (injected = new OutboundDialer({ engine, telephony, settings: outboundSettings })) : null,
    liveCalls,
  });
  let n = 0;
  /** OpenAI's webhook for an incoming call, signed with the project's secret. */
  const ring = async (callId: string, to = NUMBER, signature?: string, body?: string) => {
    const raw = body ?? JSON.stringify({ id: `evt_${callId}`, object: "event", type: "realtime.call.incoming", created_at: 1, data: { call_id: callId, sip_headers: [{ name: "From", value: "<sip:+919876543210@203.0.113.5>;tag=1" }, { name: "To", value: `<sip:${to}@${GLOBAL_SIP_HOST}>` }] } });
    const ts = Math.floor(Date.now() / 1000);
    const id = `wh_${(n += 1)}`;
    const res = await app.request("/api/webhooks/openai", { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signature ?? signWebhook(raw, id, ts, SECRET) }, body: raw });
    return { status: res.status, json: (await res.json()) as any };
  };
  const link = connector.link;
  const sessions = async () => record.listSessions();
  const events = async (sessionId: string) => (await record.context(sessionId)).events;
  const messages = async (sessionId: string) => (await events(sessionId)).filter((e) => e.type === "message").map((e) => ({ id: e.id, ...(e.payload as PayloadOf<"message">) }));
  const deliveries = async (sessionId: string) => (await events(sessionId)).filter((e) => e.type === "delivery_reported").map((e) => e.payload as PayloadOf<"delivery_reported">);
  const connections = async (sessionId: string) => (await events(sessionId)).filter((e) => e.type === "voice_connection").map((e) => e.payload as PayloadOf<"voice_connection">);
  let r = 0;
  /** Kritva's n-th spoken reply, played by OpenAI: to the end, or cut off after ms. */
  const play = (index: number, outcome: "full" | { cutAfterMs: number } = "full") => {
    const say = link.says()[index]!;
    const id = `resp_${(r += 1)}`;
    const metadata = { kritva: "say", message_id: say.messageId };
    link.emit({ type: "response.created", response: { id, metadata } });
    link.emit({ type: "output_audio_buffer.started", response_id: id });
    if (outcome === "full") {
      link.emit({ type: "response.done", response: { id, status: "completed", metadata, output: [{ id: `item_${id}`, type: "message", role: "assistant", content: [{ type: "output_audio", transcript: say.text }] }] } });
      link.emit({ type: "output_audio_buffer.stopped", response_id: id });
    } else {
      link.emit({ type: "input_audio_buffer.speech_started", item_id: `item_user_${id}` });
      link.emit({ type: "output_audio_buffer.cleared", response_id: id });
      link.emit({ type: "response.done", response: { id, status: "cancelled", metadata, output: [{ id: `item_${id}`, type: "message", role: "assistant", content: [{ type: "output_audio", transcript: say.text.slice(0, 10) }] }] } });
      link.emit({ type: "conversation.item.truncated", item_id: `item_${id}`, content_index: 0, audio_end_ms: outcome.cutAfterMs });
    }
  };
  const mandate = mandates.find((m) => m.id === "bed-sale/demo")!.mandate;
  const priceTerm = mandate.terms.find((t) => t.valueType === "money")!.id;
  const offer = (amount: number) => ({ intent: "offer", offer_kind: "offer", offer_terms: [{ term_id: priceTerm, value: { type: "money", amount, currency: null, unit: null, text: null, boolean: null } }] });
  /** OpenAI's webhook for the bridged leg of an outbound call, with the SIP headers Vobiz sent. */
  const bridge = (callId: string, headers: Array<{ name: string; value: string }>) =>
    ring(callId, NUMBER, undefined, JSON.stringify({ id: `evt_${callId}`, object: "event", type: "realtime.call.incoming", created_at: 1, data: { call_id: callId, sip_headers: [{ name: "From", value: "<sip:+918064264194@13.200.197.87>;tag=1" }, { name: "To", value: `<sip:proj_test@${GLOBAL_SIP_HOST}:5061>` }, ...headers] } }));
  /** Vobiz calling one of Kritva's callback URLs for an outbound call. */
  const vobiz = async (url: string, fields: Record<string, string> = {}) => {
    const res = await app.request(url.replace("https://kritva.example.test", ""), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    return { status: res.status, text: await res.text(), type: res.headers.get("content-type") };
  };
  const placeCall = async (sessionId: string, to = COUNTERPARTY, clientRequestId?: string) => {
    const res = await app.request(`/api/operator/sessions/${sessionId}/calls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to, clientRequestId }) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const getCall = async (callId: string) => (await (await app.request(`/api/operator/calls/${callId}`)).json()) as any;
  /** A negotiation session for the bed listing, as the multi-party flow would create one per counterparty. */
  const newSession = async () => {
    const started = await record.startSession({ mandate });
    if (!started.ok) throw new Error(started.error.message);
    return started.session.id;
  };
  return { app, record, engine, llm, library, connector, telephony, liveCalls, injected: () => injected, link, logs, ring, bridge, vobiz, placeCall, getCall, newSession, sessions, events, messages, deliveries, connections, play, offer, followUpVobiz };
}

describe("Phone: incoming calls", () => {
  it("an unsigned or altered webhook is refused and nothing is answered", async () => {
    const t = setup();
    expect((await t.ring("rtc_bad", NUMBER, "v1,AAAA")).status).toBe(400);
    expect(t.connector.accepted).toHaveLength(0);
    expect(t.connector.rejected).toHaveLength(0);
  });

  it("other events and the dashboard's test event are acknowledged and ignored", async () => {
    const t = setup();
    expect((await t.ring("x", NUMBER, undefined, JSON.stringify({ type: "response.completed", data: {} }))).json.ignored).toBe("response.completed");
    expect((await t.ring("x", NUMBER, undefined, JSON.stringify({ type: "realtime.call.incoming", data: {} }))).json.ignored).toBe("no_call_id");
    expect(await t.sessions()).toHaveLength(0);
  });

  it("a number with no route is declined (404) and starts nothing", async () => {
    const t = setup();
    expect((await t.ring("rtc_unknown", "+918000000000")).status).toBe(200);
    expect(t.connector.rejected).toEqual([{ callId: "rtc_unknown", statusCode: 404 }]);
    expect(await t.sessions()).toHaveLength(0);
  });

  it("a paused listing, or one without a confirmed mandate, is declined (480) and starts nothing", async () => {
    const paused = setup();
    paused.library!.setLifecycle("man_bed-sale-listing", "paused");
    await paused.ring("rtc_paused");
    expect(paused.connector.rejected).toEqual([{ callId: "rtc_paused", statusCode: 480 }]);
    const missing = setup({ library: false });
    await missing.ring("rtc_missing");
    expect(missing.connector.rejected).toEqual([{ callId: "rtc_missing", statusCode: 480 }]);
    expect([...(await paused.sessions()), ...(await missing.sessions())]).toHaveLength(0);
  });

  it("answers with the basics (model, instructions, voice), then applies the browser call's full session before the greeting", async () => {
    const t = setup();
    const res = await t.ring("rtc_ok1");
    expect(res.status).toBe(200);
    const accept = t.connector.accepted[0]!.session;
    expect(Object.keys(accept).sort()).toEqual(["audio", "instructions", "model", "type"]);
    expect(accept).toMatchObject({ type: "realtime", model: "gpt-realtime-2.1", audio: { output: { voice: "marin" } } });
    expect(accept.instructions).not.toMatch(/18,000|18000/);
    await until(() => t.link.says().length === 1);
    // The full session goes first on the sideband, before the greeting's response.create.
    const [update] = t.link.sent;
    expect(update!.type).toBe("session.update");
    const session = update!.session;
    expect(session.model).toBeUndefined();
    expect(session.tools[0].name).toBe("negotiate");
    expect(session.audio.input.noise_reduction).toEqual({ type: "near_field" });
    expect(session.audio.input.turn_detection.type).toBe("semantic_vad");
    expect(session.audio.input.transcription.languages).not.toContain("ur");
    expect(JSON.stringify([accept, session])).not.toMatch(/"format"/);
    expect(session.instructions).not.toMatch(/18,000|18000/);
    const sessionId = res.json.sessionId;
    const greeting = (await t.messages(sessionId)).find((m) => m.direction === "outbound")!;
    expect(t.link.says()[0]).toEqual({ text: greeting.text, messageId: greeting.id });
    expect(await t.connections(sessionId)).toEqual([{ status: "connected", transport: "phone", reason: null, direction: "inbound" }]);
    const op = await t.app.request(`/api/operator/sessions/${sessionId}`);
    expect(((await op.json()) as any).mandateSource).toEqual({ mandateId: "man_bed-sale-listing", revision: 1 });
    // The caller's number is never logged in full.
    expect(JSON.stringify(t.logs)).not.toContain("9876543210");
  });

  it("with KRITVA_PHONE_ACCEPT=full the whole session goes in the accept and no update follows", async () => {
    const t = setup({ settings: { acceptMode: "full" } });
    await t.ring("rtc_full");
    expect(t.connector.accepted[0]!.session.tools[0].name).toBe("negotiate");
    await until(() => t.link.says().length === 1);
    expect(t.link.sent.some((e) => e.type === "session.update")).toBe(false);
  });

  it("a retried webhook for the same call answers it once", async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.ring("rtc_twice"), t.ring("rtc_twice")]);
    await t.ring("rtc_twice");
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(t.connector.accepted).toHaveLength(1);
    expect(await t.sessions()).toHaveLength(1);
  });

  it("over the call limit a new call is declined as busy (486)", async () => {
    const t = setup({ settings: { maxCalls: 1 } });
    await t.ring("rtc_first");
    await until(() => t.connector.attached === 1 && t.link.says().length === 1);
    await t.ring("rtc_second");
    expect(t.connector.rejected).toEqual([{ callId: "rtc_second", statusCode: 486 }]);
  });

  it("a call that ended while it rang (404) is acknowledged, not retried and not joined", async () => {
    const t = setup();
    t.connector.acceptErrors.push(new RealtimeCallError(404, '{"error":{"code":"call_id_not_found"}}'));
    const res = await t.ring("rtc_gone");
    expect([res.status, res.json.error]).toEqual([200, "call_gone"]);
    expect(t.connector.acceptAttempts).toBe(1);
    expect(t.connector.attached).toBe(0);
  });

  it("an accept that keeps failing (OpenAI answers 503, also for a call that no longer exists) is tried three times, then hung up and acknowledged", async () => {
    const t = setup();
    t.connector.acceptErrors.push(new RealtimeCallError(503, ""), new RealtimeCallError(503, ""), new RealtimeCallError(503, ""));
    const res = await t.ring("rtc_503");
    expect([res.status, res.json.error]).toEqual([200, "accept_failed"]);
    expect(t.connector.acceptAttempts).toBe(3);
    expect(t.connector.hungUp).toEqual(["rtc_503"]);
    expect(t.connector.attached).toBe(0);
  });

  it("an accept that fails once is retried and the call goes ahead", async () => {
    const t = setup();
    t.connector.acceptErrors.push(new RealtimeCallError(503, ""));
    expect((await t.ring("rtc_retry")).json.ok).toBe(true);
    expect(t.connector.acceptAttempts).toBe(2);
    await until(() => t.connector.attached === 1 && t.link.says().length === 1);
  });

  it("shows the setup values and calls in progress to the principal", async () => {
    const t = setup();
    await t.ring("rtc_status");
    await until(() => t.connector.attached === 1);
    await until(async () => ((await (await t.app.request("/api/operator/phone")).json()) as any).calls.length === 1);
    const status = (await (await t.app.request("/api/operator/phone")).json()) as any;
    expect(status.sipUri).toBe("sip:proj_test@sip.api.openai.com:5061");
    expect(status.routes).toEqual([{ number: NUMBER, target: { kind: "listing", caseId: "bed-sale" } }]);
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });
});

describe("Phone: during a call", () => {
  const answered = async (settings: Partial<PhoneSettings> = {}) => {
    const t = setup({ settings });
    const sessionId = (await t.ring("rtc_live")).json.sessionId as string;
    await until(() => t.link.says().length === 1);
    return { ...t, sessionId };
  };

  it("a deal turn goes to the engine, its reply is spoken word for word, and hearing it in full records it delivered", async () => {
    const t = await answered();
    t.play(0);
    t.llm.interpretations.push(t.offer(15_000));
    t.link.emit({ type: "input_audio_buffer.committed", item_id: "item_u1" });
    t.link.emit({ type: "response.done", response: { id: "resp_tool", status: "completed", metadata: null, output: [{ type: "function_call", name: "negotiate", call_id: "call_1", arguments: JSON.stringify({ their_words: "I'll pay 15000", language: "en" }) }] } });
    await until(() => t.link.says().length === 2);
    const reply = (await t.messages(t.sessionId)).at(-1)!;
    expect(reply.direction).toBe("outbound");
    expect(t.link.says()[1]).toEqual({ text: reply.text, messageId: reply.id });
    t.play(1);
    await until(async () => (await t.deliveries(t.sessionId)).length === 2);
    expect((await t.deliveries(t.sessionId)).map((d) => [d.messageId, d.status])).toEqual([
      [t.link.says()[0]!.messageId, "delivered"],
      [reply.id, "delivered"],
    ]);
  });

  it("a reply the caller talks over is recorded interrupted, with the part they heard", async () => {
    const t = await answered();
    t.play(0, { cutAfterMs: 1_000 });
    await until(async () => (await t.deliveries(t.sessionId)).length === 1);
    const [d] = await t.deliveries(t.sessionId);
    expect(d!.status).toBe("interrupted");
    expect(t.link.says()[0]!.text.startsWith(d!.deliveredText!)).toBe(true);
    expect(d!.deliveredText!.length).toBeLessThan(t.link.says()[0]!.text.length);
  });

  it("hanging up mid-reply: the reply is interrupted, the call is hung up at OpenAI and its end is recorded", async () => {
    const t = await answered();
    const greeting = t.link.says()[0]!;
    t.link.emit({ type: "response.created", response: { id: "resp_g", metadata: { kritva: "say", message_id: greeting.messageId } } });
    t.link.emit({ type: "output_audio_buffer.started", response_id: "resp_g" });
    t.link.hangUp();
    await until(async () => (await t.connections(t.sessionId)).length === 2);
    expect((await t.deliveries(t.sessionId))[0]).toMatchObject({ messageId: greeting.messageId, status: "interrupted" });
    expect((await t.connections(t.sessionId))[1]).toEqual({ status: "ended", transport: "phone", reason: "hung_up", direction: "inbound" });
    expect(t.connector.hungUp).toEqual(["rtc_live"]);
    expect(t.link.closed).toBe(true);
    const op = (await (await t.app.request(`/api/operator/sessions/${t.sessionId}`)).json()) as any;
    expect(op.state.voiceInterrupted).toBe(true);
    expect(op.events.at(-1).title).toBe("Phone call ended");
    expect(((await (await t.app.request("/api/operator/phone")).json()) as any).calls).toHaveLength(0);
    // The end of a call logs how many of each event the sideband sent, to diagnose a call.
    expect(t.logs.find((l) => l.kind === "phone_ended")).toMatchObject({ reason: "hung_up", events: { "output_audio_buffer.started": 1 } });
  });

  it("after a silence Kritva checks they are still there, and after another it says goodbye and hangs up", async () => {
    const t = await answered({ idleMs: 250 });
    t.play(0);
    await until(() => t.link.says().length === 2, 3_000);
    expect(t.link.says()[1]!.text).toBe("Are you still there?");
    t.play(1);
    await until(() => t.link.says().length === 3, 3_000);
    expect(t.link.says()[2]!.text).toMatch(/end the call for now/);
    t.play(2);
    await until(async () => (await t.connections(t.sessionId)).length === 2, 3_000);
    expect((await t.connections(t.sessionId))[1]).toMatchObject({ status: "ended", reason: "idle" });
    expect(t.connector.hungUp).toEqual(["rtc_live"]);
    expect((await t.deliveries(t.sessionId)).every((d) => d.status === "delivered")).toBe(true);
  });

  it("speaking resets the silence timer", async () => {
    const t = await answered({ idleMs: 300 });
    t.play(0);
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      t.link.emit({ type: "input_audio_buffer.speech_started", item_id: `item_s${i}` });
    }
    expect(t.link.says()).toHaveLength(1);
  });

  it("at the time limit Kritva closes the call politely", async () => {
    const t = await answered({ maxCallMs: 200 });
    t.play(0);
    await until(() => t.link.says().length === 2, 3_000);
    expect(t.link.says()[1]!.text).toMatch(/end the call here/);
    t.play(1);
    await until(async () => (await t.connections(t.sessionId)).length === 2, 3_000);
    expect((await t.connections(t.sessionId))[1]).toMatchObject({ status: "ended", reason: "max_duration" });
  });
});

describe("Phone: outbound calls (Kritva dials the counterparty)", () => {
  it("is off without Vobiz settings, and the allowlist starts empty", () => {
    const { settings } = phoneSettingsFromEnv({ OPENAI_WEBHOOK_SECRET: SECRET, KRITVA_PHONE_ROUTES: "*=bed-sale", OPENAI_PROJECT_ID: "proj_abc" });
    expect(outboundFromEnv({}, settings!).config).toBeNull();
    const env = { VOBIZ_AUTH_ID: "MA_X", VOBIZ_AUTH_TOKEN: "t", KRITVA_PHONE_CALLER_ID: "08064264194", KRITVA_PUBLIC_URL: "https://x.example" };
    const on = outboundFromEnv(env, settings!).config!;
    expect(on).toMatchObject({ callerId: "918064264194", bridgeUri: "sip:proj_abc@sip.api.openai.com:5061;transport=tls", allow: [] });
    expect(outboundFromEnv({ ...env, KRITVA_PHONE_OUTBOUND_ALLOW: "+91 98123 45678,*" }, settings!).config!.allow).toEqual(["919812345678", "*"]);
    expect(outboundFromEnv({ ...env, KRITVA_PUBLIC_URL: "http://x.example" }, settings!).problems.join(" ")).toMatch(/https/);
  });

  it("places a call from Kritva's number to theirs, with callback URLs that carry an unguessable token", async () => {
    const t = setup({ outbound: {} });
    const sessionId = await t.newSession();
    const res = await t.placeCall(sessionId);
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ sessionId, state: "dialling", to: "91******5678", outcome: null });
    const [placed] = t.telephony.placed;
    expect(placed).toMatchObject({ from: "+918064264194", to: COUNTERPARTY, timeLimitSeconds: 900 });
    const token = /\/api\/phone\/vobiz\/([\w-]+)\/answer$/.exec(placed!.answerUrl)![1]!;
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(placed!.ringUrl).toBe(`https://kritva.example.test/api/phone/vobiz/${token}/ring`);
    expect(placed!.hangupUrl).toBe(`https://kritva.example.test/api/phone/vobiz/${token}/hangup`);
    // The number never enters the negotiation record.
    expect(JSON.stringify(await t.events(sessionId))).not.toContain("9812345678");
  });

  it("refuses numbers off the allowlist, malformed numbers and inactive sessions; a repeated request ID calls once", async () => {
    const t = setup({ outbound: {} });
    const sessionId = await t.newSession();
    expect((await t.placeCall(sessionId, "+919900000000")).json.error).toBe("not_allowed");
    expect((await t.placeCall(sessionId, "12")).json.error).toBe("invalid_number");
    expect((await t.placeCall("ses_missing")).json.error).toBe("session_not_active");
    const [a, b] = await Promise.all([t.placeCall(sessionId, COUNTERPARTY, "click-0001"), t.placeCall(sessionId, COUNTERPARTY, "click-0001")]);
    expect(a.json.callId).toBe(b.json.callId);
    expect(t.telephony.placed).toHaveLength(1);
    t.telephony.failNext = new Error("down");
    expect((await t.placeCall(sessionId, COUNTERPARTY, "click-0002")).status).toBe(502);
  });

  it("answered: the XML bridges to OpenAI over TLS with the token; the bridged call joins the same session, greets and is recorded as Kritva's call", async () => {
    const t = setup({ outbound: {} });
    const greetings: Array<Record<string, unknown>> = [];
    const greet = t.engine.greet.bind(t.engine);
    t.engine.greet = (input) => (greetings.push(input), greet(input));
    const sessionId = await t.newSession();
    const { callId } = (await t.placeCall(sessionId)).json;
    const base = t.telephony.placed[0]!.answerUrl.replace(/\/answer$/, "");
    const token = base.split("/").at(-1)!;
    await t.vobiz(`${base}/ring`, { CallStatus: "ringing" });
    expect((await t.getCall(callId)).state).toBe("ringing");
    const answer = await t.vobiz(`${base}/answer`, { CallStatus: "in-progress" });
    expect(answer.type).toMatch(/xml/);
    expect(answer.text).toContain(`<User sipHeaders="kritva_call=${token}">sip:proj_test@sip.api.openai.com:5061;transport=tls</User>`);
    expect(answer.text).toContain('callerId="+918064264194"');
    expect((await t.getCall(callId)).state).toBe("answered");
    const sessionsBefore = (await t.sessions()).length;
    const res = await t.bridge("rtc_out1", [{ name: "X-VH-kritva_call", value: token }]);
    expect(res.json).toMatchObject({ ok: true, sessionId });
    expect((await t.sessions()).length).toBe(sessionsBefore);
    await until(() => t.link.says().length === 1);
    expect((await t.getCall(callId)).state).toBe("connected");
    // The engine is asked for an outbound opener (who is calling, for whom and why).
    expect(greetings[0]).toMatchObject({ sessionId, channel: "voice", outbound: true });
    expect((await t.connections(sessionId))[0]).toEqual({ status: "connected", transport: "phone", reason: null, direction: "outbound" });
    // They hang up: the realtime side ends, Kritva makes sure Vobiz's leg ends too, and the call completed.
    t.link.hangUp();
    await until(async () => (await t.getCall(callId)).state === "ended");
    expect((await t.getCall(callId)).outcome).toBe("completed");
    expect(t.telephony.hungUp).toEqual(["vobiz_1"]);
    expect((await t.connections(sessionId))[1]).toMatchObject({ status: "ended", direction: "outbound" });
    const op = (await (await t.app.request(`/api/operator/sessions/${sessionId}`)).json()) as any;
    expect(op.events.map((e: any) => e.title)).toContain("Kritva's call connected");
  });

  it("not answered: a hang-up before the answer is no_answer, or busy when Vobiz says so", async () => {
    const t = setup({ outbound: {} });
    const sessionId = await t.newSession();
    const first = (await t.placeCall(sessionId)).json.callId;
    await t.vobiz(t.telephony.placed[0]!.hangupUrl, { HangupCauseName: "NO_ANSWER" });
    expect(await t.getCall(first)).toMatchObject({ state: "ended", outcome: "no_answer" });
    const second = (await t.placeCall(sessionId)).json.callId;
    await t.vobiz(t.telephony.placed[1]!.hangupUrl, { HangupCauseName: "USER_BUSY" });
    expect((await t.getCall(second)).outcome).toBe("busy");
    // A late answer callback for an ended call hangs up rather than bridging.
    expect((await t.vobiz(t.telephony.placed[1]!.answerUrl)).text).toContain("<Hangup/>");
  });

  it("without the tag, the one call waiting for its bridge is matched; with none waiting, a call routes as inbound", async () => {
    const t = setup({ outbound: {}, settings: { routes: parseRoutes("*=bed-sale").routes } });
    const sessionId = await t.newSession();
    const { callId } = (await t.placeCall(sessionId)).json;
    await t.vobiz(t.telephony.placed[0]!.answerUrl);
    expect((await t.bridge("rtc_out2", [])).json.sessionId).toBe(sessionId);
    await until(async () => (await t.getCall(callId)).state === "connected");
    const other = await t.ring("rtc_in9");
    expect(other.json.sessionId).not.toBe(sessionId);
  });

  it("the principal can cancel a call that is still ringing", async () => {
    const t = setup({ outbound: {} });
    const sessionId = await t.newSession();
    const { callId } = (await t.placeCall(sessionId)).json;
    const res = await t.app.request(`/api/operator/calls/${callId}/hangup`, { method: "POST" });
    expect(((await res.json()) as any).outcome).toBe("cancelled");
    expect(t.telephony.hungUp).toEqual(["vobiz_1"]);
    expect(((await (await t.app.request(`/api/operator/sessions/${sessionId}/calls`)).json()) as any[])).toHaveLength(1);
  });

  it("over the line limit, calls wait in a queue and go out in order as lines free up; a queued call can be cancelled", async () => {
    const t = setup({ outbound: { maxCalls: 1, allow: ["*"] } });
    const [s1, s2, s3] = [await t.newSession(), await t.newSession(), await t.newSession()];
    const first = (await t.placeCall(s1, "+919800000001")).json;
    const second = (await t.placeCall(s2, "+919800000002")).json;
    const third = (await t.placeCall(s3, "+919800000003")).json;
    expect([first.state, second.state, third.state]).toEqual(["dialling", "queued", "queued"]);
    expect(t.telephony.placed).toHaveLength(1);
    // The principal cancels the third before its turn: nothing is dialled for it.
    await t.app.request(`/api/operator/calls/${third.callId}/hangup`, { method: "POST" });
    expect(await t.getCall(third.callId)).toMatchObject({ state: "ended", outcome: "cancelled" });
    // The first goes unanswered: the second is dialled next.
    await t.vobiz(t.telephony.placed[0]!.hangupUrl, { HangupCauseName: "NO_ANSWER" });
    await until(() => t.telephony.placed.length === 2);
    expect(t.telephony.placed[1]!.to).toBe("+919800000002");
    expect((await t.getCall(second.callId)).state).toBe("dialling");
    expect(t.telephony.hungUp).toEqual([]);
  });

  it("the live-call registry gets each connected call with the counterparty's number: the caller's inbound, the dialled one outbound", async () => {
    const t = setup({ outbound: {}, settings: { routes: parseRoutes("*=bed-sale").routes } });
    const inbound = (await t.ring("rtc_reg_in")).json.sessionId;
    await until(() => t.liveCalls.events.length === 1);
    expect(t.liveCalls.events[0]).toEqual({ kind: "register", sessionId: inbound, contact: "919876543210" });
    t.link.hangUp();
    await until(() => t.liveCalls.events.length === 2);
    expect(t.liveCalls.events[1]).toEqual({ kind: "unregister", sessionId: inbound });
    const outbound = await t.newSession();
    const { callId } = (await t.placeCall(outbound)).json;
    const token = t.telephony.placed[0]!.answerUrl.split("/").at(-2)!;
    await t.vobiz(t.telephony.placed[0]!.answerUrl);
    await t.bridge("rtc_reg_out", [{ name: "X-VH-kritva_call", value: token }]);
    await until(() => t.liveCalls.events.length === 3);
    expect(t.liveCalls.events[2]).toEqual({ kind: "register", sessionId: outbound, contact: "919812345678" });
    expect((await t.getCall(callId)).state).toBe("connected");
  });

  it("a dialer built by the host (main.ts) is the one the phone routes use", async () => {
    const t = setup({ outbound: {}, injectDialer: true });
    const sessionId = await t.newSession();
    const viaRoute = (await t.placeCall(sessionId)).json;
    expect(t.injected()!.get(viaRoute.callId)).toMatchObject({ sessionId, state: "dialling" });
    await t.vobiz(t.telephony.placed[0]!.answerUrl);
    expect((await t.bridge("rtc_inj", [])).json.sessionId).toBe(sessionId);
  });

  it("the setup view shows Kritva's number and the masked allowlist", async () => {
    const t = setup({ outbound: {} });
    const status = (await (await t.app.request("/api/operator/phone")).json()) as any;
    expect(status.outbound).toEqual({ callerId: "+918064264194", allow: ["91******5678"] });
  });
});

// ---------- The approval wrap-up and the call-back ----------

describe("Phone: approval after the call, and a call-back", () => {
  /** A deal turn: the caller's words, read as given, through the negotiate tool. */
  const deal = async (t: ReturnType<typeof setup>, n: number, words: string, interp: Record<string, unknown>) => {
    const before = t.link.says().length;
    t.llm.interpretations.push(interp);
    t.link.emit({ type: "input_audio_buffer.committed", item_id: `item_u${n}` });
    t.link.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: `item_u${n}`, transcript: words });
    t.link.emit({ type: "response.done", response: { id: `resp_tool_${n}`, status: "completed", metadata: null, output: [{ type: "function_call", name: "negotiate", call_id: `call_${n}`, arguments: JSON.stringify({ their_words: words, language: "en" }) }] } });
    await until(() => t.link.says().length === before + 1);
    return t.link.says().at(-1)!;
  };
  const followUp = (f: Record<string, unknown>) => ({ follow_up: { valid_until: null, validity_quote: null, contact: null, phone_number: null, use_this_number: false, best_time_quote: null, keep_contact: null, declined: [], ...f } });
  const yes = { intent: "accept_stated_terms", accepts_stated_terms: true };

  /** A call up to the wrap-up's closing line: offer, read-back, yes, how long it stands, call me on this number. */
  const wrappedUp = async () => {
    const t = setup({ followUps: true });
    const sessionId = (await t.ring("rtc_first")).json.sessionId as string;
    await until(() => t.link.says().length === 1);
    t.play(0);
    await deal(t, 1, "I can pay 19500", t.offer(19_500));
    t.play(1);
    await until(async () => (await t.deliveries(sessionId)).length === 2);
    const asked = await deal(t, 2, "Yes, I confirm", yes);
    expect(asked.text).toMatch(/How long does your offer stand\?/);
    t.play(2);
    await deal(t, 3, "Good till tonight", { intent: "other", ...followUp({ valid_until: new Date(Date.now() + 3 * 3_600_000).toISOString(), validity_quote: "Good till tonight" }) });
    t.play(3);
    const close = await deal(t, 4, "Call me back on this number", { intent: "other", ...followUp({ contact: "call", use_this_number: true }) });
    return { ...t, sessionId, close };
  };

  it("after the closing line is heard, Kritva hangs up; the number is kept only because they agreed", async () => {
    const t = await wrappedUp();
    expect(t.close.text).toMatch(/not final until/i);
    expect(t.connector.hungUp).toEqual([]);
    t.play(4);
    await until(async () => (await t.connections(t.sessionId)).some((c) => c.status === "ended"));
    expect(t.connector.hungUp).toEqual(["rtc_first"]);
    expect((await t.connections(t.sessionId)).at(-1)).toMatchObject({ status: "ended", transport: "phone", reason: "server" });
    const op = (await (await t.app.request(`/api/operator/sessions/${t.sessionId}`)).json()) as any;
    expect(op.state.followUp).toMatchObject({ contact: "call", phone: "91******3210", validity: "Good till tonight" });
    expect(op.state.pendingApproval).not.toBeNull();
  });

  it("the seller approves later: Kritva calls back, the call joins the same negotiation, and the buyer's yes closes it", async () => {
    const t = await wrappedUp();
    t.play(4);
    await until(async () => (await t.connections(t.sessionId)).some((c) => c.status === "ended"));
    const pending = ((await (await t.app.request(`/api/operator/sessions/${t.sessionId}`)).json()) as any).state.pendingApproval;
    const res = await t.app.request(`/api/operator/sessions/${t.sessionId}/approvals/${pending.requestId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved", offerId: pending.offerId, mandateRevision: pending.mandateRevision }) });
    const decided = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(decided.followUp.via).toBe("call");
    expect(decided.reply).toBeNull();
    expect(decided.state.outcome.kind).toBe("in_progress");
    expect(t.followUpVobiz.calls).toHaveLength(1);
    expect(t.followUpVobiz.calls[0]!.url).toBe("https://api.vobiz.ai/api/v1/Account/MA_TEST/Call/");
    expect(t.followUpVobiz.calls[0]!.body).toMatchObject({ from: "+918071234567", to: "+919876543210" });
    const token = new URL(t.followUpVobiz.calls[0]!.body.answer_url).searchParams.get("t")!;

    // The buyer answers: Vobiz asks for the call's script.
    const answer = await t.app.request(`/api/webhooks/vobiz/answer?t=${token}`, { method: "POST" });
    const script = await answer.text();
    expect(script).toContain(`KritvaFollowUp=${token}`);
    expect(script).toMatch(/sip:proj_test@[\w.-]+:5061;transport=tls/);
    expect(script).toContain('recordSession="true"');

    // The bridged call reaches OpenAI: it joins the same negotiation, with no route needed.
    const sessionsBefore = (await t.sessions()).length;
    const said = t.link.says().length;
    const raw = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: "rtc_back", sip_headers: [{ name: "To", value: "<sip:proj_test@sip-in.api.openai.com>" }, { name: "X-VH-KritvaFollowUp", value: token }] } });
    const ts = Math.floor(Date.now() / 1000);
    const rung = await t.app.request("/api/webhooks/openai", { method: "POST", headers: { "content-type": "application/json", "webhook-id": "wh_back", "webhook-timestamp": String(ts), "webhook-signature": signWebhook(raw, "wh_back", ts, SECRET) }, body: raw });
    expect(((await rung.json()) as any).sessionId).toBe(t.sessionId);
    expect((await t.sessions()).length).toBe(sessionsBefore);
    await until(() => t.link.says().length === said + 1);
    const opening = t.link.says().at(-1)!;
    expect(opening.text).toMatch(/Kritva/);
    expect(opening.text).toContain("₹19,500");
    t.play(t.link.says().length - 1);
    await until(async () => (await t.deliveries(t.sessionId)).some((d) => d.messageId === opening.messageId));

    const agreed = await deal(t, 5, "Yes, still good", yes);
    expect((await t.engine.state(t.sessionId)).outcome.kind).toBe("agreement");
    t.play(t.link.says().length - 1);
    await until(() => t.connector.hungUp.includes("rtc_back"));
    expect(agreed.text).toContain("₹19,500");
  });

  it("no answer twice: one retry, then the follow-up lapses with no agreement", async () => {
    const t = await wrappedUp();
    t.play(4);
    await until(async () => (await t.connections(t.sessionId)).some((c) => c.status === "ended"));
    const pending = ((await (await t.app.request(`/api/operator/sessions/${t.sessionId}`)).json()) as any).state.pendingApproval;
    await t.app.request(`/api/operator/sessions/${t.sessionId}/approvals/${pending.requestId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved", offerId: pending.offerId, mandateRevision: pending.mandateRevision }) });
    const token = (i: number) => new URL(t.followUpVobiz.calls[i]!.body.hangup_url).searchParams.get("t")!;
    await t.app.request(`/api/webhooks/vobiz/hangup?t=${token(0)}`, { method: "POST" });
    await until(() => t.followUpVobiz.calls.length === 2);
    await t.app.request(`/api/webhooks/vobiz/hangup?t=${token(1)}`, { method: "POST" });
    await until(async () => (await t.engine.state(t.sessionId)).status === "no_agreement");
    const op = (await (await t.app.request(`/api/operator/sessions/${t.sessionId}`)).json()) as any;
    expect(op.state.followUp.status).toBe("lapsed");
    expect(op.state.followUp.attempts.map((a: any) => a.outcome)).toEqual(["calling", "no_answer", "calling", "no_answer"]);
  });

  it("an unknown token is refused politely, and webhooks with a used token do nothing", async () => {
    const t = setup({ followUps: true });
    const res = await t.app.request("/api/webhooks/vobiz/answer?t=nope", { method: "POST" });
    expect(await res.text()).toContain("<Hangup/>");
    expect((await t.app.request("/api/webhooks/vobiz/hangup?t=nope", { method: "POST" })).status).toBe(200);
  });
});
