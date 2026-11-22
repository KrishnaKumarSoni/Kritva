/**
 * Server-side delivery for phone calls (docs/Kritva_Phone_Calls.md, "Delivery").
 *
 * In a browser call the page hears its own audio and reports each reply as finished or cut off.
 * A phone call has no page: OpenAI plays the audio into the SIP call, and the server sees only the
 * call's events on the sideband WebSocket. This class turns those events into the same delivery
 * reports, one per recorded message Kritva speaks (each `response.create` the call controller
 * sends with metadata `{ kritva: "say", message_id }`).
 *
 * THE RULE. An offer counts as communicated only when its reply was heard in full, so whenever
 * the evidence is unclear the reply is reported as interrupted, never as delivered.
 *
 * 1. Playback events decide when OpenAI sends them. They are documented for WebRTC and SIP calls:
 *    - `output_audio_buffer.started`: the reply's audio began playing to the caller;
 *    - `output_audio_buffer.stopped`: it played to the end: DELIVERED;
 *    - `output_audio_buffer.cleared`, or `response.done` with a status other than "completed"
 *      (the caller talked over it, or the audio was cleared): INTERRUPTED.
 *    After a start, a reply with no end event within twice its expected length plus 10 s is
 *    reported as interrupted ("no_end_event").
 * 2. Timing decides only while a call has shown no playback events at all (a fallback, in case
 *    the sideband does not carry them). Audio starts with the reply's first audio or transcript
 *    event and is expected to last its length at 11 characters a second plus 1 s. That is slower
 *    than speech (about 14 a second), so the window outlasts the real audio:
 *    - the caller starts speaking (`input_audio_buffer.speech_started`) inside the window:
 *      INTERRUPTED;
 *    - the window passes with no speech and the response completed: DELIVERED, but only once the
 *      caller has been heard at least once on the call, which proves the audio path works. Until
 *      then the reply waits: the caller's first speech makes it DELIVERED, and the call ending
 *      first makes it INTERRUPTED with nothing heard ("no_caller_audio"). A call whose audio
 *      never connected therefore never counts a reply as heard.
 * 3. The call ending (hang-up, silence, time limit) while a reply is playing or queued: INTERRUPTED.
 *
 * HEARD TEXT for an interruption: OpenAI trims unplayed audio itself on WebRTC and SIP calls and
 * reports how much played (`conversation.item.truncated`, `audio_end_ms`); without that, the time
 * since the audio started. Either is turned into characters at 14 a second and cut back to a word
 * boundary, as the browser does. A reply cut before any audio played was heard as "".
 *
 * audioStartMs is the time from the end of their speech to the start of the reply's audio, as the
 * browser reports it.
 */
import type { RealtimeEvent } from "../realtime-voice.ts";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PlaybackReport {
  messageId: string;
  status: "delivered" | "interrupted";
  /** For an interruption, the approximate part heard ("" when nothing played); null when delivered. */
  heardText: string | null;
  audioStartMs: number | null;
  /** What decided it: OpenAI's playback events, or the timing fallback. */
  source: "playback_events" | "estimate";
  /** The signal: stopped, cleared, truncated, cancelled, speech, window_passed, no_end_event or call_ended. */
  reason: string;
}

/** Characters spoken per second, for the heard part of a cut reply (the browser uses the same). */
export const SPEAKING_RATE = 14;
/** The fallback's slower rate, so its window outlasts the real audio. */
const WINDOW_RATE = 11;
const WINDOW_GRACE_MS = 1_000;
/** After a cut, how long to wait for OpenAI's report of how much audio played. */
const SETTLE_MS = 300;

/** The start of a text up to the fraction heard, cut back to a whole word (as the browser's heardPart). */
export function heardPart(text: string, fraction: number): string {
  if (fraction <= 0) return "";
  if (fraction >= 0.98) return text;
  const cut = Math.floor(text.length * fraction);
  const space = text.lastIndexOf(" ", cut);
  return text.slice(0, space > 0 ? space : cut).trim();
}

interface Playback {
  responseId: string;
  messageId: string;
  createdAt: number;
  /** First sign of this reply's audio: an audio or transcript event, or the playback start. */
  audioAt: number | null;
  /** output_audio_buffer.started. */
  startedAt: number | null;
  audioStartMs: number | null;
  truncatedMs: number | null;
  /** A cut is waiting a moment for the truncation report. */
  cut: { source: PlaybackReport["source"]; reason: string } | null;
  /** Fallback: its window passed, but the caller has not been heard yet, so the audio path is unproven. */
  awaitingProof: boolean;
  timer: unknown;
  settled: boolean;
}

export interface PlaybackDeps {
  /** The text of a recorded message, for the heard part and the fallback's window. */
  textOf: (messageId: string) => string | undefined;
  report: (report: PlaybackReport) => void;
  clock?: Clock;
}

export class ServerPlayback {
  readonly #d: PlaybackDeps;
  readonly #clock: Clock;
  readonly #playing = new Map<string, Playback>();
  /** Conversation item ID → the response it belongs to, to match truncation reports. */
  readonly #items = new Map<string, string>();
  /** This call has sent at least one output_audio_buffer event, so those events decide. */
  #playbackEvents = false;
  #speechStoppedAt: number | null = null;
  /** The caller has been heard at least once, so audio reaches the model. */
  #callerHeard = false;
  #ended = false;

  constructor(deps: PlaybackDeps) {
    this.#d = deps;
    this.#clock = deps.clock ?? realClock;
  }

  /** A reply of ours is queued, playing or waiting for its result (not one only waiting for proof of audio). */
  get busy(): boolean {
    return [...this.#playing.values()].some((p) => !p.settled && !p.awaitingProof);
  }

  /** Whether the call's playback events decide delivery (false until the first one arrives). */
  get usesPlaybackEvents(): boolean {
    return this.#playbackEvents;
  }

  observe(e: RealtimeEvent): void {
    if (this.#ended) return;
    const now = this.#clock.now();
    switch (e.type) {
      case "input_audio_buffer.speech_stopped":
        this.#speechStoppedAt = now;
        return;
      case "input_audio_buffer.speech_started":
        return this.#onSpeech();
      case "response.created": {
        const r = e.response ?? {};
        const messageId = r.metadata?.kritva === "say" ? r.metadata?.message_id : null;
        if (typeof r.id !== "string" || typeof messageId !== "string") return;
        this.#playing.set(r.id, { responseId: r.id, messageId, createdAt: now, audioAt: null, startedAt: null, audioStartMs: null, truncatedMs: null, cut: null, awaitingProof: false, timer: null, settled: false });
        return;
      }
      case "response.output_item.added":
        if (typeof e.item?.id === "string" && typeof e.response_id === "string" && this.#playing.has(e.response_id)) this.#items.set(e.item.id, e.response_id);
        return;
      case "response.content_part.added":
      case "response.output_audio.delta":
      case "response.output_audio_transcript.delta": {
        const p = this.#playing.get(String(e.response_id ?? ""));
        if (!p) return;
        if (typeof e.item_id === "string") this.#items.set(e.item_id, p.responseId);
        if (p.audioAt === null) this.#audioBegan(p, now);
        return;
      }
      case "output_audio_buffer.started": {
        this.#playbackEvents = true;
        const p = this.#bufferOf(e);
        if (!p || p.startedAt !== null) return;
        if (p.audioAt === null) this.#audioBegan(p, now);
        p.startedAt = now;
        // Playback events decide this reply now; the watchdog covers a lost end event.
        this.#arm(p, this.#windowMs(p) * 2 + 10_000, () => this.#finish(p, "interrupted", "playback_events", "no_end_event"));
        return;
      }
      case "output_audio_buffer.stopped": {
        this.#playbackEvents = true;
        const p = this.#bufferOf(e);
        if (p && !p.cut) this.#finish(p, "delivered", "playback_events", "stopped");
        return;
      }
      case "output_audio_buffer.cleared": {
        this.#playbackEvents = true;
        const p = this.#bufferOf(e);
        if (p) this.#cut(p, "playback_events", "cleared");
        return;
      }
      case "conversation.item.truncated": {
        const p = this.#playing.get(this.#items.get(String(e.item_id ?? "")) ?? "");
        if (!p || p.settled || typeof e.audio_end_ms !== "number") return;
        p.truncatedMs = Math.max(0, e.audio_end_ms);
        if (p.cut) this.#finish(p, "interrupted", p.cut.source, p.cut.reason);
        else this.#cut(p, "playback_events", "truncated");
        return;
      }
      case "response.done":
        return this.#onDone(e.response ?? {});
      default:
        return;
    }
  }

  /** The call ended: anything still playing or queued was not heard in full. */
  end(): void {
    if (this.#ended) return;
    for (const p of this.#playing.values()) this.#finish(p, "interrupted", this.#playbackEvents ? "playback_events" : "estimate", p.awaitingProof ? "no_caller_audio" : "call_ended");
    this.#ended = true;
  }

  #audioBegan(p: Playback, now: number) {
    p.audioAt = now;
    p.audioStartMs = this.#speechStoppedAt === null ? null : Math.max(0, Math.round(now - this.#speechStoppedAt));
    this.#speechStoppedAt = null;
  }

  /** The reply a playback event is about: by response ID, else the one playing now. */
  #bufferOf(e: RealtimeEvent): Playback | undefined {
    if (typeof e.response_id === "string" && e.response_id) return this.#playing.get(e.response_id);
    return [...this.#playing.values()].reverse().find((p) => !p.settled && (p.startedAt !== null || p.audioAt !== null));
  }

  #onDone(response: Record<string, any>) {
    const p = this.#playing.get(String(response.id ?? ""));
    if (!p || p.settled) return;
    for (const item of Array.isArray(response.output) ? response.output : []) if (typeof item?.id === "string") this.#items.set(item.id, p.responseId);
    const source = this.#playbackEvents ? "playback_events" : "estimate";
    if (response.status !== "completed") return this.#cut(p, source, "cancelled");
    if (p.startedAt !== null) return; // playing: its stop or clear decides
    if (this.#playbackEvents) {
      // Generated, but its playback has not started yet: wait for it, with the same watchdog.
      this.#arm(p, this.#windowMs(p) * 2 + 10_000, () => this.#finish(p, "interrupted", "playback_events", "no_end_event"));
      return;
    }
    // Fallback: delivered once the window has passed with no speech from them, and the caller has been heard on this call.
    const begin = p.audioAt ?? p.createdAt;
    this.#arm(p, Math.max(0, begin + this.#windowMs(p) - this.#clock.now()), () => {
      if (p.startedAt !== null) return;
      if (this.#callerHeard) this.#finish(p, "delivered", "estimate", "window_passed");
      else p.awaitingProof = true;
    });
  }

  #onSpeech() {
    for (const p of this.#playing.values()) {
      // Their first words prove the audio path: a reply whose window had already passed was heard.
      if (p.awaitingProof) {
        this.#finish(p, "delivered", "estimate", "window_passed");
        continue;
      }
      if (p.settled || p.cut) continue;
      // With playback events, OpenAI reports a cut itself (cleared); speech after the audio ended is a normal reply.
      if (this.#playbackEvents || p.startedAt !== null) continue;
      // Fallback: speech inside a reply's window cuts it. A reply with no audio yet is cancelled by OpenAI (response.done).
      if (p.audioAt !== null) this.#cut(p, "estimate", "speech");
    }
    this.#callerHeard = true;
  }

  /** Cut off: wait a moment for OpenAI's report of how much played, then report the interruption. */
  #cut(p: Playback, source: PlaybackReport["source"], reason: string) {
    if (p.settled || p.cut) return;
    p.cut = { source, reason };
    if (p.truncatedMs !== null || (p.audioAt === null && p.startedAt === null)) return this.#finish(p, "interrupted", source, reason);
    this.#arm(p, SETTLE_MS, () => this.#finish(p, "interrupted", source, reason));
  }

  #arm(p: Playback, ms: number, fn: () => void) {
    if (p.timer !== null) this.#clock.clearTimeout(p.timer);
    p.timer = this.#clock.setTimeout(() => {
      p.timer = null;
      fn();
    }, ms);
  }

  /** How long the fallback expects a reply's audio to last. */
  #windowMs(p: Playback) {
    return ((this.#d.textOf(p.messageId)?.length ?? 0) / WINDOW_RATE) * 1000 + WINDOW_GRACE_MS;
  }

  #heard(p: Playback): string {
    if (p.awaitingProof || (p.audioAt === null && p.startedAt === null)) return "";
    const text = this.#d.textOf(p.messageId) ?? "";
    const ms = p.truncatedMs ?? this.#clock.now() - (p.startedAt ?? p.audioAt!);
    return heardPart(text, ((ms / 1000) * SPEAKING_RATE) / Math.max(1, text.length));
  }

  #finish(p: Playback, status: PlaybackReport["status"], source: PlaybackReport["source"], reason: string) {
    if (p.settled || this.#ended) return;
    p.settled = true;
    if (p.timer !== null) this.#clock.clearTimeout(p.timer);
    p.timer = null;
    this.#playing.delete(p.responseId);
    for (const [item, response] of this.#items) if (response === p.responseId) this.#items.delete(item);
    this.#d.report({ messageId: p.messageId, status, heardText: status === "interrupted" ? this.#heard(p) : null, audioStartMs: p.audioStartMs, source, reason });
  }
}
