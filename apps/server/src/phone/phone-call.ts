/**
 * One phone call (docs/Kritva_Phone_Calls.md). It wraps the same call controller the browser uses
 * (RealtimeCall: routing, verbatim speech, checks, engine messages) and adds what a browser page
 * would otherwise do:
 * - delivery: each spoken reply is reported as heard in full or interrupted (ServerPlayback);
 * - silence: after idleMs with nothing said either way, Kritva checks the caller is still there;
 *   after the same again, it says goodbye and hangs up;
 * - a time limit: at maxCallMs Kritva closes the call politely;
 * - the end: whoever ends it, the call is hung up at OpenAI, anything still playing counts as
 *   interrupted, and a `voice_connection` "ended" event records why.
 *
 * The wrapper sits between the sideband link and RealtimeCall: it sees every event first, then
 * passes it on unchanged. It never decides what Kritva says about the deal.
 */
import type { NegotiationEngine, NegotiationRecord } from "@kritva/core";
import { RealtimeCall, RealtimeCallError, type RealtimeCallControl, type RealtimeEvent, type RealtimeLink } from "../realtime-voice.ts";
import type { PhoneSettings } from "./config.ts";
import { realClock, ServerPlayback, type Clock, type PlaybackReport } from "./playback.ts";

export type EndReason = "hung_up" | "idle" | "max_duration" | "server" | "error";

export interface PhoneCallDeps {
  engine: NegotiationEngine;
  record: NegotiationRecord;
  sessionId: string;
  /** OpenAI's call ID (rtc_...). */
  callId: string;
  /** The sideband WebSocket to the call. */
  link: RealtimeLink;
  control: RealtimeCallControl;
  settings: Pick<PhoneSettings, "idleMs" | "maxCallMs">;
  /** Only messages recorded after this sequence number are spoken by the call. */
  afterSeq: number;
  log?: (entry: Record<string, unknown>) => void;
  /** Timers for delivery; tests pass a manual clock. Silence and the time limit use real timers. */
  clock?: Clock;
  pollMs?: number;
  onEnded?: (call: PhoneCall) => void;
}

/**
 * Lines the phone call says itself, by language (others fall back to English). They state no
 * amount and promise nothing, and they pass the same outgoing check as every voice line.
 * Placeholders for the interaction design.
 */
const STILL_THERE: Record<string, string> = {
  en: "Are you still there?",
  hi: "क्या आप अभी भी लाइन पर हैं?",
  ta: "நீங்கள் இன்னும் லைனில் இருக்கிறீர்களா?",
};
const GOODBYE: Record<string, string> = {
  en: "I'll end the call for now. Please call again whenever you like. Thank you!",
  hi: "मैं अभी कॉल रख रहा हूँ। जब चाहें फिर से कॉल कीजिए। धन्यवाद!",
  ta: "இப்போதைக்கு அழைப்பை முடிக்கிறேன். எப்போது வேண்டுமானாலும் மீண்டும் அழையுங்கள். நன்றி!",
};
const TIME_UP: Record<string, string> = {
  en: "We've been talking for a while, so I'll end the call here. Please call again any time. Thank you!",
  hi: "काफ़ी देर हो गई है, इसलिए मैं यह कॉल यहीं ख़त्म कर रहा हूँ। कभी भी फिर से कॉल कीजिए। धन्यवाद!",
  ta: "நீண்ட நேரம் பேசிவிட்டோம், அதனால் இந்த அழைப்பை இங்கே முடிக்கிறேன். எப்போது வேண்டுமானாலும் மீண்டும் அழையுங்கள். நன்றி!",
};
const line = (table: Record<string, string>, language: string) => table[language] ?? table.en!;

/** Events that mean the caller is there: they spoke, or were heard. */
const CALLER_ACTIVITY = new Set(["input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped", "conversation.item.input_audio_transcription.completed"]);
/** Events that mean Kritva is talking or about to. */
const KRITVA_ACTIVITY = new Set(["response.created", "response.done", "output_audio_buffer.started", "output_audio_buffer.stopped", "output_audio_buffer.cleared"]);

const eventId = (prefix: string, callId: string) => `${prefix}_${callId.replace(/[^\w-]/g, "")}`.slice(0, 128);

export class PhoneCall {
  readonly callId: string;
  readonly sessionId: string;
  readonly startedAt = new Date();
  readonly #d: PhoneCallDeps;
  readonly #call: RealtimeCall;
  readonly #playback: ServerPlayback;
  /** What RealtimeCall sees as its link: the same sends, with events passed on after this wrapper reads them. */
  readonly #tap: RealtimeLink;
  #writes: Promise<unknown> = Promise.resolve();
  #waiters = new Map<string, () => void>();
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #maxTimer: ReturnType<typeof setTimeout> | null = null;
  /** 0: no check yet; 1: asked whether they are still there. */
  #idleStage: 0 | 1 = 0;
  #closing = false;
  #ended: Promise<void> | null = null;

  constructor(deps: PhoneCallDeps) {
    this.#d = deps;
    this.callId = deps.callId;
    this.sessionId = deps.sessionId;
    this.#tap = { send: (e) => deps.link.send(e), close: () => deps.link.close(), onEvent: null, onClose: null };
    deps.link.onEvent = (e) => this.#observe(e);
    // The sideband lives as long as the SIP call, so its closing means the caller hung up or the line dropped.
    deps.link.onClose = () => void this.end("hung_up");
    this.#call = new RealtimeCall({ engine: deps.engine, record: deps.record, sessionId: deps.sessionId, link: this.#tap, afterSeq: deps.afterSeq, log: deps.log, pollMs: deps.pollMs });
    this.#playback = new ServerPlayback({ textOf: (id) => this.#call.textOf(id), report: (r) => this.#report(r), clock: deps.clock ?? realClock });
  }

  get ended(): boolean {
    return this.#ended !== null;
  }

  /** Records the connection, starts the silence and time-limit timers, and greets. */
  async start(): Promise<void> {
    await this.#d.record.append(this.sessionId, { id: eventId("voice", this.callId), type: "voice_connection", channel: "voice", payload: { status: "connected", transport: "phone" } }, { kind: "system", partyId: null });
    this.#maxTimer = setTimeout(() => void this.#wrapUp("max_duration"), this.#d.settings.maxCallMs);
    this.#armIdle();
    await this.#call.start();
  }

  /**
   * Ends the call once, for any reason: hangs up at OpenAI (also when the line already closed, so a
   * call can never stay connected to a voice nobody supervises), reports anything still playing as
   * interrupted, and records why the call ended.
   */
  end(reason: EndReason): Promise<void> {
    this.#ended ??= this.#finish(reason);
    return this.#ended;
  }

  async #finish(reason: EndReason): Promise<void> {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#maxTimer) clearTimeout(this.#maxTimer);
    this.#playback.end();
    for (const resolve of this.#waiters.values()) resolve();
    this.#waiters.clear();
    await this.#d.control.hangup(this.callId).catch((error) => {
      if (!(error instanceof RealtimeCallError && error.gone)) this.#log({ kind: "phone_hangup_failed", error: String(error) });
    });
    this.#call.close();
    await this.#writes;
    const recorded = await this.#d.record.append(this.sessionId, { id: eventId("voice_end", this.callId), type: "voice_connection", channel: "voice", payload: { status: "ended", transport: "phone", reason } }, { kind: "system", partyId: null });
    if (!recorded.ok) this.#log({ kind: "phone_end_not_recorded", error: recorded.error.message });
    this.#log({ kind: "phone_ended", reason, durationMs: Date.now() - this.startedAt.getTime(), deliveryFrom: this.#playback.usesPlaybackEvents ? "playback_events" : "estimate" });
    this.#d.onEnded?.(this);
  }

  #log(entry: Record<string, unknown>) {
    this.#d.log?.({ sessionId: this.sessionId, callId: this.callId, ...entry });
  }

  #observe(e: RealtimeEvent) {
    if (this.#ended) return;
    this.#playback.observe(e);
    if (CALLER_ACTIVITY.has(e.type)) {
      this.#idleStage = 0;
      this.#armIdle();
    } else if (KRITVA_ACTIVITY.has(e.type)) {
      this.#armIdle();
    }
    this.#tap.onEvent?.(e);
  }

  /** A delivery decided by ServerPlayback goes to the record exactly as a browser's report would. */
  #report(r: PlaybackReport) {
    this.#log({ kind: "phone_delivery", messageId: r.messageId, status: r.status, source: r.source, reason: r.reason, heardChars: r.heardText?.length ?? null, audioStartMs: r.audioStartMs });
    this.#writes = this.#writes
      .then(() => this.#d.engine.reportDelivery({ sessionId: this.sessionId, messageId: r.messageId, channel: "voice", status: r.status, deliveredText: r.status === "interrupted" ? (r.heardText ?? "") : null, audioStartMs: r.audioStartMs }))
      .then((result) => {
        if ("ok" in result && result.ok === false) this.#log({ kind: "phone_delivery_not_recorded", messageId: r.messageId, error: result.message });
      })
      .catch((error) => this.#log({ kind: "phone_delivery_not_recorded", messageId: r.messageId, error: String(error) }));
    this.#waiters.get(r.messageId)?.();
    this.#waiters.delete(r.messageId);
  }

  #armIdle() {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#ended || this.#closing) return;
    this.#idleTimer = setTimeout(() => void this.#onIdle(), this.#d.settings.idleMs);
  }

  async #onIdle() {
    if (this.#ended || this.#closing) return;
    // Silence only counts while nothing is being said, decided or played.
    if (!this.#call.idle || this.#playback.busy) return this.#armIdle();
    if (this.#idleStage === 0) {
      this.#idleStage = 1;
      await this.#sayLine(STILL_THERE, "Checked the caller is still there after a silence.");
      return this.#armIdle();
    }
    await this.#wrapUp("idle");
  }

  /** Says a closing line, waits for it to be heard (or cut off), then ends the call. */
  async #wrapUp(reason: "idle" | "max_duration") {
    if (this.#ended || this.#closing) return;
    this.#closing = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    // A deal turn in progress finishes first, so its reply is not lost.
    for (let waited = 0; !this.#call.idle && waited < 20_000 && !this.#ended; waited += 200) await new Promise((r) => setTimeout(r, 200));
    const messageId = await this.#sayLine(reason === "idle" ? GOODBYE : TIME_UP, reason === "idle" ? "Ended the call after a long silence." : "Ended the call at its time limit.");
    if (messageId) await this.#heard(messageId, 15_000);
    await this.end(reason);
  }

  /** Records a line; the call controller speaks it like any recorded engine message. */
  async #sayLine(table: Record<string, string>, reason: string): Promise<string | null> {
    if (this.#ended) return null;
    const recorded = await this.#d.engine.recordVoiceLine({ sessionId: this.sessionId, text: line(table, this.#call.language), reason });
    if (!recorded.ok) this.#log({ kind: "phone_line_not_recorded", code: recorded.code });
    return recorded.ok ? recorded.replyId : null;
  }

  /** Resolves when a message's delivery is decided, or after maxMs. */
  #heard(messageId: string, maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, maxMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.#waiters.set(messageId, done);
    });
  }
}
