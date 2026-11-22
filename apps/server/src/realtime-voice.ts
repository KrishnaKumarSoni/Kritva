/**
 * Realtime voice (docs/Kritva_Realtime_Voice.md).
 *
 * The browser talks to OpenAI's realtime model over WebRTC; this server creates the call (the API
 * key never reaches the browser) and joins it over a sideband WebSocket, where every tool call is
 * handled. The realtime model is Kritva's ears and voice only:
 * - conversation turns (greetings, small talk, repeats, questions the public facts answer) it
 *   answers itself, and code checks and records those words;
 * - deal turns go to the negotiation engine through the `negotiate` tool, and the engine's checked
 *   reply is spoken word for word.
 * The engine still decides every amount, offer and agreement. The same controller serves SIP
 * (phone) calls: only how the call starts and how delivery is observed differ (see src/phone/).
 */
import { readFileSync } from "node:fs";
import type { Hono } from "hono";
import type { NegotiationEngine, NegotiationRecord, PayloadOf, ReplyViolation } from "@kritva/core";
import { findAmounts } from "@kritva/core";

// ---------- Settings ----------

export interface RealtimeSettings {
  model: string;
  voice: string;
  transcribeModel: string;
  /** ISO 639-1 language hints for the written transcript. */
  languages: string[];
  eagerness: "low" | "medium" | "high" | "auto";
  /** The realtime model's reasoning effort; lower is faster. */
  reasoning: "minimal" | "low" | "medium";
}

export function realtimeSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): RealtimeSettings {
  const eagerness = env.KRITVA_REALTIME_EAGERNESS;
  return {
    model: env.KRITVA_REALTIME_MODEL ?? "gpt-realtime-2.1",
    voice: env.KRITVA_REALTIME_VOICE ?? "marin",
    transcribeModel: env.KRITVA_REALTIME_TRANSCRIBE_MODEL ?? "gpt-transcribe",
    languages: (env.KRITVA_VOICE_LANGUAGES ?? "en,hi,ta,kn,te,ml,mr,bn").split(",").map((l) => l.trim()).filter((l) => /^[a-z]{2,3}$/.test(l)),
    eagerness: eagerness === "low" || eagerness === "medium" || eagerness === "auto" ? eagerness : "high",
    reasoning: env.KRITVA_REALTIME_REASONING === "minimal" || env.KRITVA_REALTIME_REASONING === "medium" ? env.KRITVA_REALTIME_REASONING : "low",
  };
}

// ---------- Transport ----------

/** One server-side event from the realtime call. */
export type RealtimeEvent = { type: string } & Record<string, any>;

/** The server's connection to one realtime call (the sideband WebSocket). */
export interface RealtimeLink {
  send(event: Record<string, unknown>): void;
  close(): void;
  onEvent: ((event: RealtimeEvent) => void) | null;
  onClose: (() => void) | null;
}

export interface RealtimeConnector {
  /** Creates a browser (WebRTC) call from the browser's SDP offer. */
  createCall(sdpOffer: string, session: Record<string, unknown>): Promise<{ sdpAnswer: string; callId: string }>;
  /** Joins an existing call (browser or SIP) from the server. */
  attach(callId: string): Promise<RealtimeLink>;
}

/**
 * Control of a SIP (phone) call that OpenAI is ringing or has connected
 * (https://developers.openai.com/api/docs/guides/realtime-sip).
 */
export interface RealtimeCallControl {
  /** Answers the call with this session (the same flat body as a browser call's session). */
  accept(callId: string, session: Record<string, unknown>): Promise<void>;
  /** Declines the call with a SIP status code (for example 404, 480 or 486). */
  reject(callId: string, statusCode: number): Promise<void>;
  /** Ends a connected call (OpenAI sends the SIP BYE). */
  hangup(callId: string): Promise<void>;
}

/** A call-control request OpenAI refused. `gone` means the call no longer exists (the caller hung up while it rang). */
export class RealtimeCallError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Realtime call request failed (${status}): ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
  get gone(): boolean {
    return this.status === 404 || /call_id_not_found|not.?found/i.test(this.body);
  }
}

export class OpenAIRealtimeConnector implements RealtimeConnector, RealtimeCallControl {
  readonly #apiKey: string;
  readonly #base: string;

  constructor(apiKey: string, base = "https://api.openai.com/v1") {
    this.#apiKey = apiKey;
    this.#base = base;
  }

  async createCall(sdpOffer: string, session: Record<string, unknown>) {
    const form = new FormData();
    form.set("sdp", sdpOffer);
    form.set("session", JSON.stringify(session));
    const res = await fetch(`${this.#base}/realtime/calls`, { method: "POST", headers: { Authorization: `Bearer ${this.#apiKey}` }, body: form, signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    if (!res.ok) throw new Error(`Realtime call was not created (${res.status}): ${body.slice(0, 300)}`);
    const callId = res.headers.get("location")?.split("/").filter(Boolean).at(-1);
    if (!callId) throw new Error("Realtime call has no call ID.");
    return { sdpAnswer: body, callId };
  }

  async accept(callId: string, session: Record<string, unknown>) {
    await this.#control(callId, "accept", session);
  }

  async reject(callId: string, statusCode: number) {
    await this.#control(callId, "reject", { status_code: statusCode });
  }

  async hangup(callId: string) {
    await this.#control(callId, "hangup", null);
  }

  async #control(callId: string, action: "accept" | "reject" | "hangup", body: Record<string, unknown> | null) {
    const res = await fetch(`${this.#base}/realtime/calls/${encodeURIComponent(callId)}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      // Short, so a retried accept still fits in the webhook's few seconds.
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) throw new RealtimeCallError(res.status, await res.text());
  }

  attach(callId: string): Promise<RealtimeLink> {
    const url = `${this.#base.replace(/^http/, "ws")}/realtime?call_id=${encodeURIComponent(callId)}`;
    // Node's WebSocket (undici) accepts headers as an extension of the standard constructor.
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.#apiKey}` } } as unknown as string[]);
    const link: RealtimeLink = {
      send: (event) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
      },
      close: () => ws.close(),
      onEvent: null,
      onClose: null,
    };
    ws.onmessage = (m) => {
      try {
        link.onEvent?.(JSON.parse(String(m.data)) as RealtimeEvent);
      } catch (error) {
        console.error("realtime event failed", error);
      }
    };
    ws.onclose = () => link.onClose?.();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Realtime sideband did not open.")), 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(link);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Realtime sideband failed."));
      };
    });
  }
}

// ---------- Session ----------

export type VoiceBriefing = NonNullable<Awaited<ReturnType<NegotiationEngine["voiceBriefing"]>>>;

export const NEGOTIATE_TOOL = {
  type: "function",
  name: "negotiate",
  description: "Hand a deal turn to Kritva's negotiation engine. It decides the move and returns the exact reply to say. Call it for anything about price, amounts, offers, discounts, budgets, payment, delivery or pickup arrangements, availability, agreeing, confirming or ending, and for anything not in the public facts.",
  parameters: {
    type: "object",
    properties: {
      their_words: { type: "string", description: "What they just said, word for word, in their own language and script, with every number written as digits." },
      language: { type: "string", description: "ISO 639-1 code of the language they spoke, such as en, hi or ta." },
    },
    required: ["their_words", "language"],
    additionalProperties: false,
  },
} as const;

export function realtimeInstructions(b: VoiceBriefing): string {
  const principal = b.principalName ? `${b.principalName} (the ${b.principalRole || "person you represent"})` : `the ${b.principalRole || "person you represent"}`;
  const facts = [...(b.subject ? [`What is offered: ${b.subject}`] : []), ...b.facts, ...b.terms];
  return `You are Kritva, an assistant speaking on a live voice call for ${principal}, with a ${b.counterpartyRole || "counterparty"}. You are not ${principal} yourself.

Public facts you may state:
${facts.map((f) => `- ${f}`).join("\n") || "- (none)"}

Every turn is one of two kinds.
1. Conversation turns you answer yourself: greetings, small talk, checking they can hear you, repeating or explaining something you already said, and questions fully answered by the public facts above. Answer only what they asked, in one or two short, warm sentences. Do not list every fact.
2. Deal turns go to the negotiation engine: anything about price or any amount, offers, discounts, budgets, payment, delivery or pickup arrangements, availability or holding the item, agreeing, confirming or ending, anything not in the public facts, and anything you are unsure about. For a deal turn, first say a very short, natural acknowledgement in their language, two to five words with no number in it, the way a person says it while thinking (for example "Got it, one moment.", "Hmm, okay.", "ठीक है, एक सेकंड।" or "சரி, ஒரு நிமிஷம்."). It must not describe what happens next: never say you will pass, hand over, forward, check or see what comes back. Then call negotiate with their exact words as you heard them, never paraphrased or translated. Never answer a deal turn yourself.
When you are given a reply to say, say exactly that reply, word for word, and nothing else.

Rules for your own words: never say any amount or price; never agree, accept, approve, promise, hold, reserve or confirm anything; never invent a detail; never mention tools, checks, engines, rules or handing anything over.

Language: reply in the language they speak, in its own script: Hindi in Devanagari (never Urdu script), Tamil in Tamil script, English in English, and the same for other languages. If they mix Hindi and English, reply in the same natural mix. Do not switch language because of an accent, a name, a filler word or one borrowed word.

Voice: a friendly person on the phone. Warm, relaxed, clear and unhurried; never salesy or over-excited.`;
}

/** Each language in its own script, and every number as digits so amounts are read exactly. */
export const TRANSCRIPTION_PROMPT = "A buyer and a seller's assistant talk about an item and its price. Write each language in its own script: Hindi in Devanagari (never Urdu script), Tamil in Tamil script, English in English. Write every number and amount as digits, for example 18000 or 1.5 lakh.";

export interface SessionOptions {
  /**
   * Input noise reduction. Browser mics default to near_field. A phone call passes its own setting
   * (KRITVA_PHONE_NOISE_REDUCTION); null turns it off. Audio formats are never set: a browser call
   * uses OpenAI's defaults and a SIP call negotiates its codec in the SIP handshake.
   */
  noiseReduction?: "near_field" | "far_field" | null;
}

/** The realtime session: a browser call's `session`, and the flat body of a SIP call's accept. */
export function realtimeSession(settings: RealtimeSettings, briefing: VoiceBriefing, options: SessionOptions = {}): Record<string, unknown> {
  const noise = options.noiseReduction === undefined ? "near_field" : options.noiseReduction;
  return {
    type: "realtime",
    model: settings.model,
    instructions: realtimeInstructions(briefing),
    output_modalities: ["audio"],
    audio: {
      input: {
        noise_reduction: noise ? { type: noise } : null,
        transcription: { model: settings.transcribeModel, prompt: TRANSCRIPTION_PROMPT, ...(settings.languages.length ? { languages: settings.languages } : {}) },
        turn_detection: { type: "semantic_vad", eagerness: settings.eagerness, create_response: true, interrupt_response: true },
      },
      output: { voice: settings.voice },
    },
    tools: [NEGOTIATE_TOOL],
    tool_choice: "auto",
    reasoning: { effort: settings.reasoning },
  };
}

// ---------- Language ----------

/** "in Hindi (Devanagari script)" for a wait line, from the language the call is in. */
function languageLabel(code: string): string {
  const scripts: Record<string, string> = { hi: "Devanagari", ta: "Tamil", kn: "Kannada", te: "Telugu", ml: "Malayalam", bn: "Bengali", mr: "Devanagari" };
  let name = code;
  try {
    name = new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    /* keep the code */
  }
  return scripts[code] ? `in ${name} (${scripts[code]} script)` : `in ${name}`;
}

/** The language a text is written in, from its script; Latin script counts as English. */
export function scriptLanguage(text: string): string {
  if (/\p{Script=Devanagari}/u.test(text)) return "hi";
  if (/\p{Script=Tamil}/u.test(text)) return "ta";
  if (/\p{Script=Kannada}/u.test(text)) return "kn";
  if (/\p{Script=Telugu}/u.test(text)) return "te";
  if (/\p{Script=Malayalam}/u.test(text)) return "ml";
  if (/\p{Script=Bengali}/u.test(text)) return "bn";
  return "en";
}

/** Said when the voice model's own words failed a check. Promises nothing and states no amount. */
const CORRECTION: Record<string, string> = {
  en: "Sorry, please ignore what I just said. I'll confirm that properly.",
  hi: "माफ़ कीजिए, मैंने अभी जो कहा उसे छोड़ दीजिए। मैं ठीक से पक्का करके बताता हूँ।",
  ta: "மன்னிக்கவும், நான் இப்போது சொன்னதை விட்டுவிடுங்கள். சரியாக உறுதிசெய்து சொல்கிறேன்.",
};
/** Said when the engine could not take the turn. Nothing was decided or sent. */
const RETRY: Record<string, string> = {
  en: "Sorry, I didn't quite get that. Could you say it again?",
  hi: "माफ़ कीजिए, मैं ठीक से समझ नहीं पाया। क्या आप फिर से बता सकते हैं?",
  ta: "மன்னிக்கவும், எனக்கு சரியாகப் புரியவில்லை. மீண்டும் ஒருமுறை சொல்ல முடியுமா?",
};
const line = (table: Record<string, string>, language: string) => table[language] ?? table.en!;

/**
 * Waiting on a call. The model cannot hear silence or feel time passing, so code only reports the
 * facts: the line has been quiet this long while a reply is being worked out, or while the person
 * represented decides. The agent decides whether to speak and what to say, guided by the plain-text
 * waiting guide; it may call stay_quiet instead. Whatever it says is checked like its other words.
 */
export const WAIT_SENSOR = { quietMs: 3_000, sampleMs: 500 };
const WAITING_GUIDE = readFileSync(new URL("./voice-waiting-guide.md", import.meta.url), "utf8").trim();
export const STAY_QUIET_TOOL = {
  type: "function",
  name: "stay_quiet",
  description: "Say nothing this time: the pause is natural, or you spoke a moment ago.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
} as const;

const verbatim = (text: string) => `Say exactly the following to them, word for word, in the same language, with nothing before or after it:\n${text}`;

// ---------- The call ----------

export interface CallDeps {
  engine: NegotiationEngine;
  record: NegotiationRecord;
  sessionId: string;
  link: RealtimeLink;
  /** Only messages recorded after this sequence number are spoken by the call. */
  afterSeq: number;
  log?: (entry: Record<string, unknown>) => void;
  pollMs?: number;
  /** Overrides for the wait sensor (tests). */
  waitSensor?: Partial<typeof WAIT_SENSOR>;
}

/**
 * One realtime call. Serialises speaking (one response at a time), routes each finished response
 * (a deal turn's tool call, or the model's own answer), and speaks engine messages recorded during
 * the call, such as a reply after the seller's approval.
 */
export class RealtimeCall {
  readonly #d: CallDeps;
  #active = false;
  #queue: Array<{ messageId: string; text: string }> = [];
  #pendingSay: { messageId: string; text: string } | null = null;
  /** When the call last had sound (either side); the wait sensor reports quiet stretches from it. */
  #lastSoundAt = Date.now();
  /** Since when a reply is being worked out (null: not working), and since when approval is pending. */
  #workingSince: number | null = null;
  #approvalSince: number | null = null;
  #lastOwnWords = "";
  #lastReportAt = 0;
  #sensor: ReturnType<typeof setInterval> | null = null;
  readonly #wait: typeof WAIT_SENSOR;
  #spoken = new Set<string>();
  #transcripts = new Map<string, string>();
  #transcriptWaiters = new Map<string, Array<(text: string) => void>>();
  #lastUserItem: string | null = null;
  #language = "en";
  #busy = 0;
  #poll: ReturnType<typeof setInterval> | null = null;
  #status: string | null = null;
  #closed = false;
  /** What each spoken message says, to compare with what was actually spoken. */
  readonly #lastSaid = new Map<string, string>();
  readonly #resaid = new Set<string>();

  constructor(deps: CallDeps) {
    this.#d = deps;
    this.#wait = { ...WAIT_SENSOR, ...deps.waitSensor };
    this.#sensor = setInterval(() => this.#sense(), this.#wait.sampleMs);
    deps.link.onEvent = (e) => void this.#onEvent(e).catch((error) => this.#log({ kind: "error", error: String(error) }));
    deps.link.onClose = () => this.close();
  }

  get closed() {
    return this.#closed;
  }

  /** Nothing is being said, decided or queued. */
  get idle() {
    return !this.#active && this.#busy === 0 && this.#queue.length === 0;
  }

  /** The language they last spoke (ISO 639-1), for lines the call says itself. */
  get language() {
    return this.#language;
  }

  /** The text of a recorded message this call has spoken or queued, for estimating how much of it was heard. */
  textOf(messageId: string): string | undefined {
    return this.#lastSaid.get(messageId);
  }

  /** Greets (the engine writes the line) and starts watching for engine-initiated messages. */
  async start(): Promise<void> {
    this.#busy += 1;
    try {
      const greeted = await this.#d.engine.greet({ sessionId: this.#d.sessionId, channel: "voice" });
      if (greeted.ok && greeted.reply) this.#say(greeted.reply.messageId, greeted.reply.text);
    } finally {
      this.#busy -= 1;
    }
    this.#poll = setInterval(() => void this.#watch().catch(() => undefined), this.#d.pollMs ?? 1_200);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#poll) clearInterval(this.#poll);
    if (this.#sensor) clearInterval(this.#sensor);
    this.#d.link.close();
  }

  #log(entry: Record<string, unknown>) {
    this.#d.log?.({ sessionId: this.#d.sessionId, ...entry });
  }

  /** Speaks a recorded message word for word, after any response in progress. */
  #say(messageId: string, text: string) {
    if (this.#spoken.has(messageId)) return;
    this.#spoken.add(messageId);
    this.#lastSaid.set(messageId, text);
    this.#queue.push({ messageId, text });
    this.#drain();
  }

  #drain() {
    if (this.#active || this.#closed) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#active = true;
    this.#pendingSay = next;
    this.#d.link.send({ type: "response.create", response: { instructions: verbatim(next.text), tool_choice: "none", metadata: { kritva: "say", message_id: next.messageId } } });
  }

  #transcript(itemId: string | null, waitMs = 2_500): Promise<string> {
    if (!itemId) return Promise.resolve("");
    const known = this.#transcripts.get(itemId);
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => {
      const list = this.#transcriptWaiters.get(itemId) ?? [];
      const timer = setTimeout(() => resolve(""), waitMs);
      list.push((text) => {
        clearTimeout(timer);
        resolve(text);
      });
      this.#transcriptWaiters.set(itemId, list);
    });
  }

  async #onEvent(e: RealtimeEvent): Promise<void> {
    switch (e.type) {
      case "input_audio_buffer.committed":
        this.#lastUserItem = typeof e.item_id === "string" ? e.item_id : this.#lastUserItem;
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(e.transcript ?? "").trim();
        this.#transcripts.set(e.item_id, text);
        for (const w of this.#transcriptWaiters.get(e.item_id) ?? []) w(text);
        this.#transcriptWaiters.delete(e.item_id);
        return;
      }
      case "response.created":
        this.#active = true;
        return;
      case "input_audio_buffer.speech_started":
      case "input_audio_buffer.speech_stopped":
        this.#lastSoundAt = Date.now();
        return;
      case "error": {
        this.#log({ kind: "realtime_error", error: e.error });
        // Our response collided with one the model started: speak ours after it.
        if (this.#pendingSay && /active.?response/i.test(String(e.error?.code ?? e.error?.message ?? ""))) {
          this.#queue.unshift(this.#pendingSay);
          this.#pendingSay = null;
        }
        return;
      }
      case "response.done": {
        this.#active = false;
        this.#pendingSay = null;
        // Only a response that said something counts as sound; staying quiet leaves the silence running.
        const output: Array<Record<string, any>> = Array.isArray(e.response?.output) ? e.response.output : [];
        if (output.some((o) => Array.isArray(o.content) && o.content.length > 0)) this.#lastSoundAt = Date.now();
        await this.#finished(e.response ?? {});
        this.#drain();
        return;
      }
      default:
        return;
    }
  }

  async #finished(response: Record<string, any>): Promise<void> {
    const output: Array<Record<string, any>> = Array.isArray(response.output) ? response.output : [];
    const spoken = output
      .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
      .map((c: Record<string, any>) => c.transcript ?? c.text ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
    if (response.metadata?.kritva === "wait") return this.#waited(output, spoken);
    const ours = response.metadata?.kritva === "say";
    if (ours) {
      if (spoken) this.#lastOwnWords = spoken;
      this.#checkFidelity(String(response.metadata?.message_id ?? ""), spoken);
      return;
    }
    const call = output.find((o) => o.type === "function_call" && o.name === NEGOTIATE_TOOL.name);
    if (call) return this.#dealTurn(call, spoken);
    if (spoken) return this.#conversationTurn(spoken, response.status === "cancelled");
  }

  /** A deal turn: check and keep the acknowledgement, run the engine, speak its checked reply. */
  async #dealTurn(call: Record<string, any>, acknowledgement: string): Promise<void> {
    this.#busy += 1;
    const started = performance.now();
    try {
      let args: { their_words?: string; language?: string } = {};
      try {
        args = JSON.parse(String(call.arguments ?? "{}"));
      } catch {
        args = {};
      }
      const itemId = this.#lastUserItem;
      // The dedicated transcript is the more faithful record of their words; the voice model's copy is
      // used when it heard an amount the transcript did not write as digits (spoken number words).
      const modelWords = (args.their_words ?? "").trim();
      const transcript = await this.#transcript(itemId, 1_500);
      const amounts = (text: string) => findAmounts(text).sort((a, b) => a - b).join(",");
      const heard = transcript && (!modelWords || amounts(transcript) === amounts(modelWords)) ? transcript : modelWords || transcript;
      this.#log({ kind: "heard", source: heard === transcript ? "transcript" : "voice_model", transcript, modelWords });
      this.#language = /^[a-z]{2,3}$/.test(args.language ?? "") ? args.language! : scriptLanguage(heard);
      if (acknowledgement) {
        this.#lastOwnWords = acknowledgement;
        const problems = await this.#d.engine.checkVoiceWords(this.#d.sessionId, acknowledgement, heard);
        await this.#d.engine.recordVoiceFragment({ sessionId: this.#d.sessionId, text: acknowledgement, utteranceId: String(call.call_id ?? itemId ?? "ack") });
        if (problems.length) await this.#correct(problems, acknowledgement);
      }
      if (!heard) {
        this.#output(call, { reply_to_say: null, note: "Nothing was heard." });
        return this.#sayLine(line(RETRY, this.#language), "Asked them to repeat: nothing was heard.");
      }
      const messageId = `msg_${(itemId ?? String(call.call_id ?? "")).replace(/[^\w-]/g, "").slice(0, 90) || crypto.randomUUID()}`;
      this.#workingSince = Date.now();
      const result = await this.#d.engine
        .handleCounterpartyMessage({ sessionId: this.#d.sessionId, text: heard.slice(0, 2_000), channel: "voice", messageId, utteranceId: itemId, language: this.#language })
        .finally(() => (this.#workingSince = null));
      this.#log({ kind: "deal_turn", ms: Math.round(performance.now() - started), engine: result.ok ? result.timings : null, ok: result.ok, language: this.#language });
      if (!result.ok) {
        this.#output(call, { reply_to_say: null, note: "The turn could not be taken." });
        return this.#sayLine(line(RETRY, this.#language), "Asked them to repeat: the turn could not be read.");
      }
      if (!result.reply) {
        this.#output(call, { reply_to_say: null, note: "Nothing to say right now." });
        return;
      }
      this.#output(call, { reply_to_say: result.reply.text });
      this.#say(result.reply.messageId, result.reply.text);
    } finally {
      this.#busy -= 1;
    }
  }

  #output(call: Record<string, any>, output: Record<string, unknown>) {
    this.#d.link.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) } });
  }

  /** A conversation turn the model answered itself: record both sides, and correct a failed check. */
  async #conversationTurn(spoken: string, cut: boolean): Promise<void> {
    this.#busy += 1;
    try {
      const itemId = this.#lastUserItem;
      const theirs = (await this.#transcript(itemId)) || "(not transcribed)";
      this.#language = scriptLanguage(theirs === "(not transcribed)" ? spoken : theirs);
      const recorded = await this.#d.engine.recordVoiceAnswer({
        sessionId: this.#d.sessionId,
        buyerText: theirs,
        replyText: spoken,
        messageId: `msg_${(itemId ?? crypto.randomUUID()).replace(/[^\w-]/g, "").slice(0, 90)}`,
        utteranceId: itemId,
      });
      if (!recorded.ok) return this.#log({ kind: "record_failed", code: recorded.code });
      this.#lastOwnWords = spoken;
      this.#spoken.add(recorded.replyId);
      this.#log({ kind: "conversation_turn", cut, violations: recorded.violations.map((v) => v.rule) });
      if (recorded.violations.length) await this.#correct(recorded.violations, spoken);
    } finally {
      this.#busy -= 1;
    }
  }

  /** The model's own words failed a check: stop the audio and say a correction. */
  async #correct(problems: ReplyViolation[], said: string) {
    this.#log({ kind: "corrected", rules: problems.map((p) => p.rule), said: said.slice(0, 200) });
    this.#d.link.send({ type: "output_audio_buffer.clear" });
    await this.#sayLine(line(CORRECTION, this.#language), "Corrected words the voice model said itself that failed a check.");
  }

  async #sayLine(text: string, reason: string) {
    const recorded = await this.#d.engine.recordVoiceLine({ sessionId: this.#d.sessionId, text, reason });
    if (recorded.ok) this.#say(recorded.replyId, text);
  }

  /** The engine's reply must be spoken as recorded; a different amount is repeated correctly. */
  #checkFidelity(messageId: string, spoken: string) {
    const expected = this.#lastSaid.get(messageId);
    if (expected === undefined) return;
    const want = findAmounts(expected).sort().join(",");
    const got = findAmounts(spoken).sort().join(",");
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const exact = norm(expected) === norm(spoken);
    this.#log({ kind: "spoken", messageId, exact, amountsMatch: want === got });
    if (spoken && want !== got && !this.#resaid.has(messageId)) {
      this.#resaid.add(messageId);
      this.#spoken.delete(messageId);
      this.#say(messageId, expected);
    }
  }

  /** Engine messages recorded during the call (for example after the seller's approval) are spoken once. */
  async #watch(): Promise<void> {
    if (this.#closed || this.#busy > 0) return;
    const ctx = await this.#d.record.context(this.#d.sessionId);
    const status = ctx.status;
    if (status !== this.#status) {
      // While the negotiation is not active, every turn goes to the engine, which says why.
      if (this.#status !== null) this.#d.link.send({ type: "session.update", session: { type: "realtime", tool_choice: status === "active" ? "auto" : "required" } });
      this.#status = status;
    }
    for (const e of ctx.events) {
      if (e.seq <= this.#d.afterSeq || e.type !== "message" || e.channel !== "voice" || this.#spoken.has(e.id)) continue;
      const p = e.payload as PayloadOf<"message">;
      if (p.direction === "outbound") this.#say(e.id, p.text);
    }
    // Waiting for the decision of the person represented: the sensor reports how long.
    if (status === "awaiting_approval") this.#approvalSince ??= Date.now();
    else this.#approvalSince = null;
  }

  /** Reports a quiet stretch during a wait to the agent, which decides whether and what to say. */
  #sense() {
    if (this.#closed || this.#active || this.#queue.length > 0) return;
    const waitingSince = this.#workingSince ?? this.#approvalSince;
    if (waitingSince === null) return;
    const now = Date.now();
    const quietMs = now - this.#lastSoundAt;
    if (quietMs < this.#wait.quietMs || now - this.#lastReportAt < this.#wait.quietMs) return;
    const quiet = Math.round(quietMs / 1000);
    const waited = Math.round((now - waitingSince) / 1000);
    const situation = this.#workingSince !== null
      ? `You are still working out your reply to their last message (${waited} seconds so far). The line has been quiet for ${quiet} seconds.`
      : `You are waiting for the decision of the person you represent (${waited} seconds so far). The line has been quiet for ${quiet} seconds.`;
    const last = this.#lastOwnWords ? ` Your last words were: "${this.#lastOwnWords.slice(0, 200)}"` : "";
    const language = languageLabel(this.#language);
    this.#active = true;
    this.#lastReportAt = now;
    // Out of band and without the conversation: a pause is filled, never used to answer the open question.
    this.#d.link.send({
      type: "response.create",
      response: {
        conversation: "none",
        input: [],
        instructions: `${WAITING_GUIDE}\n\nSpeak ${language}. Never use dashes.\n\nNow: ${situation}${last}`,
        tools: [STAY_QUIET_TOOL],
        tool_choice: "auto",
        metadata: { kritva: "wait", situation: this.#workingSince !== null ? "working" : "approval" },
      },
    });
    this.#log({ kind: "wait_reported", situation: this.#workingSince !== null ? "working" : "approval", quiet, waited });
  }

  /** What the agent did with a wait report: stayed quiet, or spoke (checked and kept as a fragment). */
  async #waited(output: Array<Record<string, any>>, spoken: string): Promise<void> {
    // An out-of-band stay_quiet call is not in the conversation, so it needs no output.
    this.#log({ kind: "wait_answered", spoke: Boolean(spoken), text: spoken.slice(0, 160) });
    if (!spoken) return;
    this.#lastOwnWords = spoken;
    await this.#d.engine.recordVoiceFragment({ sessionId: this.#d.sessionId, text: spoken, utteranceId: `wait_${Date.now()}` }).catch(() => undefined);
    const problems = await this.#d.engine.checkVoiceWords(this.#d.sessionId, spoken);
    if (problems.length) await this.#correct(problems, spoken);
  }
}

// ---------- Routes ----------

export interface RealtimeDeps {
  record: NegotiationRecord;
  engine: NegotiationEngine;
  connector: RealtimeConnector | null;
  settings: RealtimeSettings;
  log?: (entry: Record<string, unknown>) => void;
}

export function registerRealtimeRoutes(app: Hono, deps: RealtimeDeps): void {
  const calls = new Map<string, RealtimeCall>();

  /** Starts a realtime call: the browser's SDP offer in, the SDP answer out. */
  app.post("/api/buyer/sessions/:id/voice/realtime", async (c) => {
    if (!deps.connector) return c.json({ error: "realtime_unavailable", message: "Live voice isn't available right now." }, 501);
    const id = c.req.param("id");
    const briefing = await deps.engine.voiceBriefing(id);
    if (!briefing) return c.json({ error: "session_not_found" }, 404);
    if (briefing.status !== "active") return c.json({ error: "not_pending", message: "This negotiation isn't active, so there's nothing to say yet." }, 409);
    const offer = await c.req.text();
    if (!offer.startsWith("v=")) return c.json({ error: "invalid_offer", message: "The call couldn't start." }, 400);
    let created: { sdpAnswer: string; callId: string };
    let link: RealtimeLink;
    try {
      created = await deps.connector.createCall(offer, realtimeSession(deps.settings, briefing));
      link = await deps.connector.attach(created.callId);
    } catch (error) {
      deps.log?.({ kind: "call_failed", sessionId: id, error: String(error) });
      return c.json({ error: "voice_unavailable", message: "Voice couldn't connect. You can keep typing." }, 503);
    }
    calls.get(id)?.close();
    const afterSeq = (await deps.record.context(id)).events.at(-1)?.seq ?? 0;
    const call = new RealtimeCall({ engine: deps.engine, record: deps.record, sessionId: id, link, afterSeq, log: deps.log });
    calls.set(id, call);
    await deps.record.append(id, { id: `voice_${created.callId}`.slice(0, 128), type: "voice_connection", channel: "voice", payload: { status: "connected" } }, { kind: "system", partyId: null });
    void call.start().catch((error) => deps.log?.({ kind: "start_failed", sessionId: id, error: String(error) }));
    return c.json({ sdp: created.sdpAnswer, afterSeq });
  });

  app.post("/api/buyer/sessions/:id/voice/realtime/end", (c) => {
    const id = c.req.param("id");
    calls.get(id)?.close();
    calls.delete(id);
    return c.json({ ok: true });
  });
}
