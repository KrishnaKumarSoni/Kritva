/**
 * One phone call over a Vobiz media stream, with Sarvam speech (docs/Kritva_Phone_Calls.md, section 17).
 *
 * Kritva runs the whole conversation through the negotiation engine, as a typed chat does:
 * - hearing: the caller's audio arrives as 20 ms PCM frames; a loudness detector finds each utterance,
 *   Sarvam transcribes it, and the text goes to engine.handleCounterpartyMessage (channel "voice");
 * - speaking: Kritva only ever speaks messages the engine recorded on the voice channel (its replies,
 *   the greeting, follow-ups after the principal decides, the call's own set lines), word for word,
 *   in Sarvam's voice. No model chooses words on the line, so nothing unchecked is ever said;
 * - delivery: a reply counts as heard once its audio has played (Vobiz's checkpoint, or the end of its
 *   playing time). If the caller talks over it, playback is cleared and the record gets the part heard;
 * - the end: silence, the time limit, the engine's "end the call", or the caller hanging up.
 *
 * Short waiting lines ("one moment") fill a slow turn. They say nothing about the deal and are not
 * recorded, like a breath on the line.
 */
import { randomUUID } from "node:crypto";
import { newEventId, type NegotiationEngine, type NegotiationRecord } from "@kritva/core";
import { fromBase64, pcmMs, rms16, sentences, toBase64, concat } from "./audio.ts";
import type { PhoneSpeech } from "./sarvam.ts";
import { scriptLanguage } from "../realtime-voice.ts";
import type { EndReason } from "./phone-call.ts";

/** The WebSocket Vobiz opened, as the call sees it. */
export interface CallSocket {
  send(text: string): void;
  close(): void;
}

export interface StreamCallDeps {
  engine: NegotiationEngine;
  record: NegotiationRecord;
  sessionId: string;
  speech: PhoneSpeech;
  socket: CallSocket;
  direction: "inbound" | "outbound";
  settings: { idleMs: number; maxCallMs: number };
  /** The counterparty's number, used only if they agree to be called back on it. */
  contactNumber?: string | null;
  log?: (entry: Record<string, unknown>) => void;
  onConnected?: () => void;
  onEnded?: (reason: EndReason) => void;
  /** Tuning, for tests and noisy lines. */
  vad?: Partial<VadSettings>;
  /** How often the record is checked for new messages to speak. */
  pollMs?: number;
}

interface VadSettings {
  /** Loudness that counts as speech. */
  threshold: number;
  /** Silence that ends an utterance. */
  endSilenceMs: number;
  /** Shorter sounds are noise. */
  minSpeechMs: number;
  /** Speech this long over Kritva's voice interrupts it. */
  bargeInMs: number;
  /** An utterance is cut here and handled, even if they keep talking. */
  maxUtteranceMs: number;
}

const VAD: VadSettings = { threshold: 450, endSilenceMs: 700, minSpeechMs: 250, bargeInMs: 350, maxUtteranceMs: 15_000 };
/** Kritva's playback rate: 16-bit PCM at 8 kHz, a phone line's own. */
const PLAY_RATE = 8000;
/** Audio is sent in 40 ms pieces, so a barge-in clears quickly. */
const CHUNK_BYTES = (PLAY_RATE * 2 * 40) / 1000;
/** A turn slower than this gets a waiting line. */
const FILLER_AFTER_MS = 2_200;

const FILLER: Record<string, string> = { en: "One moment, please.", hi: "एक second, देख रही हूँ।" };
const SORRY: Record<string, string> = { en: "Sorry, I didn't catch that. Could you say it again?", hi: "Sorry, मैं ठीक से सुन नहीं पाई। एक बार फिर से बोलिए?" };
const STILL_THERE: Record<string, string> = { en: "Hello? Are you still there?", hi: "Hello? आप line पर हैं?" };
const GOODBYE: Record<string, string> = { en: "I'll end the call for now. Call again whenever you like. Thank you!", hi: "अभी के लिए call रख रही हूँ। जब मन हो, फिर से call कर लीजिए। Thank you!" };
const TIME_UP: Record<string, string> = { en: "We've been talking for a while, so I'll end the call here. Call again any time. Thank you!", hi: "काफ़ी देर हो गई, तो call यहीं रखती हूँ। कभी भी दोबारा call कर लीजिए। Thank you!" };
const line = (lines: Record<string, string>, language: string) => lines[language] ?? lines.en!;

/** A message being played: its sentences, when each started, and whether it was heard. */
interface Playing {
  messageId: string | null;
  text: string;
  parts: Array<{ text: string; startAt: number; ms: number }>;
  /** When the last of its audio will have played. */
  endsAt: number;
  /** All of its audio has been sent (more sentences may still be synthesising before that). */
  sent: boolean;
  settled: boolean;
  cancelled: boolean;
}

export class StreamCall {
  readonly #d: StreamCallDeps;
  readonly #vad: VadSettings;
  #streamId: string | null = null;
  #inRate = PLAY_RATE;
  #ended = false;
  #language: string;
  /** Messages already spoken (or being spoken), so none is said twice. */
  readonly #spoken = new Set<string>();
  /** Messages after which the call hangs up, once heard. */
  readonly #endAfter = new Set<string>();
  #afterSeq = 0;
  #queue: Promise<void> = Promise.resolve();
  #playing: Playing | null = null;
  #playhead = 0;
  // Hearing
  #frames: Uint8Array[] = [];
  #speechMs = 0;
  #silenceMs = 0;
  #inSpeech = false;
  #bargeMs = 0;
  #turns: Promise<void> = Promise.resolve();
  #busy = 0;
  // Timers
  #poll: ReturnType<typeof setInterval> | null = null;
  #idle: ReturnType<typeof setTimeout> | null = null;
  #max: ReturnType<typeof setTimeout> | null = null;
  #idleStage: 0 | 1 = 0;
  readonly startedAt = new Date();

  constructor(deps: StreamCallDeps) {
    this.#d = deps;
    this.#vad = { ...VAD, ...deps.vad };
    this.#language = "hi";
  }

  get sessionId(): string {
    return this.#d.sessionId;
  }

  /** For the live-calls registry: whether the call is over. */
  get closed(): boolean {
    return this.#ended;
  }

  /** A deal closed elsewhere: stop talking now; the engine's news follows on the next check of the record. */
  async breakIn(): Promise<void> {
    this.#interrupt("break_in");
    await this.#check();
  }

  /** One message from Vobiz over the socket. */
  async message(raw: string): Promise<void> {
    if (this.#ended) return;
    let event: { event?: string; start?: { streamId?: string; callId?: string; mediaFormat?: { encoding?: string; sampleRate?: number } }; media?: { payload?: string; track?: string }; name?: string };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (event.event === "start") return this.#start(event.start ?? {});
    if (event.event === "media" && event.media?.payload && (event.media.track ?? "inbound") === "inbound") return this.#hear(fromBase64(event.media.payload));
    if (event.event === "playedStream" && event.name) return this.#played(event.name);
  }

  /** The socket closed: the caller hung up, or the line dropped. */
  closedByLine(): void {
    void this.end("hung_up", { hangUp: false });
  }

  async #start(start: { streamId?: string; callId?: string; mediaFormat?: { encoding?: string; sampleRate?: number } }) {
    if (this.#streamId) return;
    this.#streamId = start.streamId ?? null;
    this.#inRate = start.mediaFormat?.sampleRate ?? PLAY_RATE;
    if (start.mediaFormat?.encoding && start.mediaFormat.encoding !== "audio/x-l16") this.#log({ kind: "vobiz_unexpected_format", encoding: start.mediaFormat.encoding });
    this.#log({ kind: "vobiz_stream_started", callId: start.callId ?? null, sampleRate: this.#inRate });
    this.#afterSeq = (await this.#d.record.context(this.#d.sessionId)).events.at(-1)?.seq ?? 0;
    await this.#d.record.append(this.#d.sessionId, { id: newEventId(), type: "voice_connection", channel: "voice", payload: { status: "connected", transport: "phone", reason: null, direction: this.#d.direction } }, { kind: "system", partyId: null });
    this.#d.onConnected?.();
    this.#max = setTimeout(() => void this.#closing(TIME_UP, "max_duration"), this.#d.settings.maxCallMs);
    this.#poll = setInterval(() => void this.#check(), this.#d.pollMs ?? 1_000);
    const greeted = await this.#d.engine.greet({ sessionId: this.#d.sessionId, channel: "voice", outbound: this.#d.direction === "outbound" });
    if (!greeted.ok) this.#log({ kind: "vobiz_greet_failed", code: greeted.code });
    await this.#check();
    this.#armIdle();
  }

  // ---------- Hearing ----------

  #hear(pcm: Uint8Array) {
    const ms = pcmMs(pcm.byteLength, this.#inRate);
    const loud = rms16(pcm) >= this.#vad.threshold;
    if (loud) {
      this.#frames.push(pcm);
      this.#speechMs += ms;
      this.#silenceMs = 0;
      this.#inSpeech = true;
      this.#bargeMs += ms;
      // Talking over Kritva for long enough stops it; what they say is the start of their next turn.
      if (this.#playing && !this.#playing.settled && this.#bargeMs >= this.#vad.bargeInMs) this.#interrupt("barge_in");
      this.#armIdle();
    } else {
      this.#bargeMs = 0;
      if (this.#inSpeech) {
        this.#frames.push(pcm);
        this.#silenceMs += ms;
      }
    }
    const tooLong = this.#speechMs + this.#silenceMs >= this.#vad.maxUtteranceMs;
    if (this.#inSpeech && (this.#silenceMs >= this.#vad.endSilenceMs || tooLong)) {
      const utterance = concat(this.#frames);
      const speech = this.#speechMs;
      this.#frames = [];
      this.#speechMs = 0;
      this.#silenceMs = 0;
      this.#inSpeech = false;
      if (speech >= this.#vad.minSpeechMs) this.#turns = this.#turns.then(() => this.#turn(utterance)).catch((error) => this.#log({ kind: "vobiz_turn_failed", error: String(error).slice(0, 300) }));
    }
  }

  async #turn(pcm: Uint8Array) {
    if (this.#ended) return;
    this.#busy += 1;
    const started = Date.now();
    const filler = setTimeout(() => {
      if (!this.#ended && !this.#playing) void this.#say(null, line(FILLER, this.#language));
    }, FILLER_AFTER_MS);
    try {
      let heard: { text: string; language: string | null };
      try {
        heard = await this.#d.speech.transcribe(pcm, this.#inRate);
      } catch (error) {
        this.#log({ kind: "vobiz_transcribe_failed", error: String(error).slice(0, 200) });
        return;
      }
      if (heard.text.replace(/[\s.,!?।]/g, "").length < 2) return;
      if (heard.language) this.#language = heard.language === "hi" ? "hi" : heard.language === "en" ? "en" : this.#language;
      const utteranceId = randomUUID();
      const result = await this.#d.engine.handleCounterpartyMessage({ sessionId: this.#d.sessionId, text: heard.text.slice(0, 2_000), channel: "voice", messageId: `msg_${utteranceId}`, utteranceId, language: heard.language, contactNumber: this.#d.contactNumber ?? null });
      this.#log({ kind: "vobiz_turn", ms: Date.now() - started, language: heard.language, ok: result.ok, ...(result.ok ? { replied: Boolean(result.reply), endCall: Boolean(result.endCall) } : { code: result.code }) });
      if (!result.ok) {
        if (result.code === "model_unavailable") await this.#line(SORRY, "The turn could not be handled; asking them to repeat.");
        return;
      }
      if (result.reply && result.endCall) this.#endAfter.add(result.reply.messageId);
    } finally {
      clearTimeout(filler);
      this.#busy -= 1;
      await this.#check();
      this.#armIdle();
    }
  }

  // ---------- Speaking ----------

  /** Speaks every new outbound voice message in the record, in order. */
  async #check(): Promise<void> {
    if (this.#ended) return;
    const ctx = await this.#d.record.context(this.#d.sessionId).catch(() => null);
    if (!ctx) return;
    for (const event of ctx.events) {
      if (event.seq <= this.#afterSeq || event.type !== "message" || event.channel !== "voice" || this.#spoken.has(event.id)) continue;
      const payload = event.payload as { direction?: string; text?: string };
      if (payload.direction !== "outbound" || !payload.text) continue;
      this.#spoken.add(event.id);
      void this.#say(event.id, payload.text);
    }
  }

  /** Records one of the call's own lines (amount-free, checked by the engine), then it is spoken like any message. */
  async #line(lines: Record<string, string>, reason: string): Promise<string | null> {
    const recorded = await this.#d.engine.recordVoiceLine({ sessionId: this.#d.sessionId, text: line(lines, this.#language), reason });
    if (!recorded.ok) {
      this.#log({ kind: "vobiz_line_refused", reason, code: recorded.code });
      return null;
    }
    await this.#check();
    return recorded.replyId;
  }

  /** Queues text to be spoken (a recorded message, or an unrecorded waiting line); one message plays at a time. */
  #say(messageId: string | null, text: string): Promise<void> {
    const job = this.#queue.then(() => this.#play(messageId, text));
    this.#queue = job.catch((error) => this.#log({ kind: "vobiz_play_failed", error: String(error).slice(0, 300) }));
    return this.#queue;
  }

  /** Plays one message: its sentences are synthesised together and sent in order; it returns once heard or cut off. */
  async #play(messageId: string | null, text: string) {
    if (this.#ended || !this.#streamId) return;
    // The voice follows the reply's script: Devanagari (with English words mixed in) is spoken as Hindi.
    const language = scriptLanguage(text);
    const pieces = sentences(text);
    const audio = pieces.map((piece) => this.#d.speech.speak(piece, language, PLAY_RATE));
    const playing: Playing = { messageId, text, parts: [], endsAt: Math.max(Date.now(), this.#playhead), sent: false, settled: false, cancelled: false };
    this.#playing = playing;
    for (const [i, piece] of pieces.entries()) {
      let pcm: Uint8Array;
      try {
        pcm = await audio[i]!;
      } catch (error) {
        this.#log({ kind: "vobiz_speak_failed", error: String(error).slice(0, 200) });
        if (messageId) void this.#report(messageId, "failed", null);
        playing.settled = true;
        if (this.#playing === playing) this.#playing = null;
        return;
      }
      if (playing.cancelled || this.#ended) return;
      const ms = pcmMs(pcm.byteLength, PLAY_RATE);
      const startAt = Math.max(Date.now(), this.#playhead);
      for (let at = 0; at < pcm.byteLength; at += CHUNK_BYTES) {
        this.#send({ event: "playAudio", streamId: this.#streamId, media: { contentType: "audio/x-l16", sampleRate: PLAY_RATE, payload: toBase64(pcm.subarray(at, at + CHUNK_BYTES)) } });
      }
      this.#playhead = startAt + ms;
      playing.parts.push({ text: piece, startAt, ms });
      playing.endsAt = this.#playhead;
    }
    playing.sent = true;
    this.#send({ event: "checkpoint", streamId: this.#streamId, name: messageId ?? `line-${randomUUID()}` });
    // Vobiz's playedStream usually confirms first; this is the fallback when it does not arrive.
    const wait = Math.max(0, playing.endsAt - Date.now()) + 1_500;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#settle(playing, "delivered");
        resolve();
      }, wait);
      const done = setInterval(() => {
        if (playing.settled || this.#ended) {
          clearTimeout(timer);
          clearInterval(done);
          resolve();
        }
      }, 100);
    });
  }

  #played(name: string) {
    const playing = this.#playing;
    if (playing && playing.sent && (playing.messageId ?? "") === name) this.#settle(playing, "delivered");
  }

  #settle(playing: Playing, status: "delivered" | "interrupted", heard: string | null = null) {
    if (playing.settled) return;
    playing.settled = true;
    if (this.#playing === playing) this.#playing = null;
    if (playing.messageId) void this.#report(playing.messageId, status, heard);
    if (status === "delivered" && playing.messageId && this.#endAfter.has(playing.messageId)) setTimeout(() => void this.end("server"), 600);
    this.#armIdle();
  }

  /** Stops Kritva mid-sentence: Vobiz drops the queued audio, and the record gets the part they heard. */
  #interrupt(why: "barge_in" | "break_in") {
    const playing = this.#playing;
    if (!playing || playing.settled) return;
    playing.cancelled = true;
    if (this.#streamId) this.#send({ event: "clearAudio", streamId: this.#streamId });
    const now = Date.now();
    const heard = playing.parts
      .map((p) => (now >= p.startAt + p.ms ? p.text : now <= p.startAt ? "" : p.text.slice(0, Math.floor((p.text.length * (now - p.startAt)) / p.ms))))
      .join(" ")
      .trim();
    this.#playhead = now;
    this.#log({ kind: "vobiz_interrupted", why, heardChars: heard.length, ofChars: playing.text.length });
    this.#settle(playing, "interrupted", heard);
  }

  async #report(messageId: string, status: "delivered" | "interrupted" | "failed", heard: string | null) {
    const result = await this.#d.engine.reportDelivery({ sessionId: this.#d.sessionId, messageId, channel: "voice", status, deliveredText: status === "interrupted" ? heard : null });
    if ("ok" in result && result.ok === false) this.#log({ kind: "vobiz_delivery_refused", messageId, status, code: result.code });
  }

  // ---------- Silence, time limit and the end ----------

  #armIdle() {
    if (this.#idle) clearTimeout(this.#idle);
    if (this.#ended) return;
    this.#idleStage = 0;
    this.#idle = setTimeout(() => void this.#onIdle(), this.#d.settings.idleMs);
  }

  async #onIdle() {
    if (this.#ended) return;
    // Not silence: Kritva is speaking, thinking, or they are mid-sentence.
    if (this.#playing || this.#busy || this.#inSpeech) return this.#armIdle();
    if (this.#idleStage === 0) {
      await this.#line(STILL_THERE, "Silence on the call: checking they are still there.");
      if (this.#idle) clearTimeout(this.#idle);
      this.#idleStage = 1;
      this.#idle = setTimeout(() => void this.#onIdle(), this.#d.settings.idleMs);
      return;
    }
    await this.#closing(GOODBYE, "idle");
  }

  /** Says a closing line, waits for it to play, then hangs up. */
  async #closing(lines: Record<string, string>, reason: EndReason) {
    if (this.#ended) return;
    const id = await this.#line(lines, reason === "idle" ? "Long silence: ending the call." : "The call reached its time limit.");
    if (id) this.#endAfter.add(id);
    else await this.end(reason);
    // The line hangs up once heard; if it never plays, the call still ends.
    setTimeout(() => void this.end(reason), 20_000);
  }

  /** Ends the call: hang up (unless the line already closed), settle what was playing, record why. */
  async end(reason: EndReason, opts: { hangUp?: boolean } = {}): Promise<void> {
    if (this.#ended) return;
    if (this.#playing && !this.#playing.settled) this.#interrupt("barge_in");
    this.#ended = true;
    if (this.#poll) clearInterval(this.#poll);
    if (this.#idle) clearTimeout(this.#idle);
    if (this.#max) clearTimeout(this.#max);
    if (opts.hangUp !== false && this.#streamId) {
      // "stop" with nothing after the <Stream> element: Vobiz hangs the call up.
      this.#send({ event: "stop", streamId: this.#streamId });
    }
    try {
      this.#d.socket.close();
    } catch {
      // Already closed.
    }
    await this.#d.record.append(this.#d.sessionId, { id: newEventId(), type: "voice_connection", channel: "voice", payload: { status: "ended", transport: "phone", reason, direction: this.#d.direction } }, { kind: "system", partyId: null }).catch(() => undefined);
    this.#log({ kind: "vobiz_call_ended", reason, seconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000) });
    this.#d.onEnded?.(reason);
  }

  #send(event: Record<string, unknown>) {
    try {
      this.#d.socket.send(JSON.stringify(event));
    } catch {
      // The line closed; the close handler ends the call.
    }
  }

  #log(entry: Record<string, unknown>) {
    this.#d.log?.({ sessionId: this.#d.sessionId, ...entry });
  }
}
