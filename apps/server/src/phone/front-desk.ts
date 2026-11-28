/**
 * The shared line's front desk (docs/Kritva_Phone_Calls.md, "Listing codes and the front desk").
 *
 * One phone number can serve many mandates, and the call itself does not say which one the caller
 * means. So a call on a "code" route is answered before
 * any negotiation exists: the realtime agent picks up, talks with the caller as the plain-text guide
 * (voice-front-desk-guide.md) says, and asks for the 4-digit listing code printed on the listing.
 *
 * Code decides only what has to be exact:
 * - find_listing: the digits are checked (Damm check digit) and looked up; the result is data the
 *   agent talks about in its own words;
 * - on a match, the host starts (or continues) that mandate's negotiation, records what was said so
 *   far, switches the same realtime session to the negotiation's instructions and hands the call to
 *   PhoneCall, which answers the caller's last words as one continuous conversation.
 * Everything Kritva says is the agent's choice; this file never writes a line for it.
 */
import { readFileSync } from "node:fs";
import { CONVERSATION_MISTAKES, CONVERSATION_TONE, listingCodeDigits, textFile } from "@kritva/core";
import { END_CALL_TOOL, LANGUAGE_RULES, realtimeSessionWith, RealtimeCallError, scriptLanguage, VOICE_RULES, type RealtimeCallControl, type RealtimeEvent, type RealtimeLink, type RealtimeSettings, type SessionOptions } from "../realtime-voice.ts";
import type { EndReason } from "./phone-call.ts";

const GUIDE = textFile("voice-front-desk-guide.md", () => readFileSync(new URL("../voice-front-desk-guide.md", import.meta.url), "utf8")).trim();
const FOUND_HEADING = "Once the listing is found";

/**
 * The guide's last section. Once the listing is found it is added to the negotiation's instructions,
 * so the agent goes on from where the caller was instead of greeting them again.
 */
export const AFTER_FRONT_DESK = (() => {
  const at = GUIDE.indexOf(`\n${FOUND_HEADING}\n`);
  if (at < 0) throw new Error(`voice-front-desk-guide.md needs a "${FOUND_HEADING}" section`);
  return GUIDE.slice(at + 1);
})();

export const FIND_LISTING_TOOL = {
  type: "function",
  name: "find_listing",
  description: "Find the listing the caller is calling about from the 4-digit listing code printed on it. Call it as soon as they have given all four digits. It says whether the code matched a listing; if it did, the call goes on with that listing.",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "The digits they gave, as digits only, in the order heard (for example 4821)." } },
    required: ["code"],
    additionalProperties: false,
  },
} as const;

/** The front desk's instructions: the guide, who the line may say it answers for, and the shared voice rules. */
export function frontDeskInstructions(line: { answersFor: string[] }): string {
  return `${GUIDE}

On this line:
${line.answersFor.length ? line.answersFor.map((name) => `- ${name}`).join("\n") : "- (no names given)"}

${LANGUAGE_RULES}

${VOICE_RULES}

How you sound:
${CONVERSATION_TONE}

Mistakes to avoid:
${CONVERSATION_MISTAKES}`;
}

/** The realtime session a front-desk call is answered with. */
export function frontDeskSession(settings: RealtimeSettings, line: { answersFor: string[] }, options: SessionOptions = {}): Record<string, unknown> {
  return realtimeSessionWith(settings, { instructions: frontDeskInstructions(line), tools: [FIND_LISTING_TOOL, END_CALL_TOOL] }, options);
}

/** What find_listing found. On a match the negotiation has already started; `listing` is what the agent is told. */
export type Lookup =
  | { found: true; sessionId: string; listing: Record<string, unknown> }
  | { found: false; reason: "check_failed" | "wrong_length" | "not_found" | "paused" | "closed" | "busy" | "unavailable" };

export interface FrontDeskTurn {
  role: "caller" | "kritva";
  /** The caller's audio item, for their turns. */
  itemId: string | null;
  text: string;
}

export interface HandOver {
  sessionId: string;
  /** Everything said before the caller's last words, in order. */
  history: FrontDeskTurn[];
  /** The caller's last words (usually the code), which the negotiation agent answers first. */
  seed: { itemId: string | null; transcript: string | null; language: string | null };
}

export interface FrontDeskDeps {
  callId: string;
  link: RealtimeLink;
  control: RealtimeCallControl;
  /** The front desk's instructions, repeated when the agent is told the line went quiet. */
  instructions: string;
  /** The session to apply before the agent picks up (when the accept carried only the basics). */
  sessionUpdate: Record<string, unknown> | null;
  settings: { idleMs: number; maxCallMs: number };
  lookup(digits: string): Promise<Lookup>;
  /** The listing was found and its negotiation started: the host takes the call from here. */
  handOver(input: HandOver): Promise<void>;
  /** The call ended at the front desk, without reaching a listing. */
  onEnded?(reason: EndReason): void;
  log?: (entry: Record<string, unknown>) => void;
  trace?: boolean;
}

/** Events too frequent to trace one by one. */
const NOISY = new Set(["response.output_audio.delta", "response.output_audio_transcript.delta", "conversation.item.input_audio_transcription.delta", "response.function_call_arguments.delta", "rate_limits.updated"]);
/** Quiet reports to the agent before the line is hung up anyway. */
const QUIET_REPORTS = 2;
/** How long after the last keypad press the digits are passed on. */
const KEYPAD_PAUSE_MS = 1_500;
/** The longest a goodbye may take to play when the call does not report the end of playback. */
const playTimeMs = (text: string) => Math.min(15_000, Math.max(2_500, 1_200 + text.length * 80));

export class FrontDesk {
  readonly callId: string;
  readonly startedAt = new Date();
  readonly #d: FrontDeskDeps;
  readonly #turns: FrontDeskTurn[] = [];
  readonly #transcripts = new Map<string, string>();
  readonly #waiters = new Map<string, Array<() => void>>();
  readonly #counts = new Map<string, number>();
  #responding = false;
  /** A response to create once the one in progress is done (a quiet report or keypad digits). */
  #pending: Record<string, unknown> | null = null;
  #language: string | null = null;
  #attempts = 0;
  #quiet = 0;
  #keys = "";
  #keyTimer: ReturnType<typeof setTimeout> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #maxTimer: ReturnType<typeof setTimeout> | null = null;
  #ending: { responseId: string | null; timer: ReturnType<typeof setTimeout> } | null = null;
  #goodbyeAsked = false;
  #handing = false;
  #lineClosed = false;
  #ended: Promise<void> | null = null;

  constructor(deps: FrontDeskDeps) {
    this.#d = deps;
    this.callId = deps.callId;
    deps.link.onEvent = (e) => void this.#observe(e).catch((error) => this.#log({ kind: "front_desk_error", error: String(error) }));
    deps.link.onClose = () => {
      this.#lineClosed = true;
      if (!this.#handing) void this.end("hung_up");
    };
  }

  /** The caller hung up while the call was being handed over; the host ends the handed-over call. */
  get lineClosed(): boolean {
    return this.#lineClosed;
  }

  get ended(): boolean {
    return this.#ended !== null;
  }

  /** Applies the session and lets the agent pick up, as a person answers a phone. */
  start(): void {
    this.#log({ kind: "front_desk_started" });
    if (this.#d.sessionUpdate) this.#d.link.send({ type: "session.update", session: this.#d.sessionUpdate });
    this.#maxTimer = setTimeout(() => void this.end("max_duration"), this.#d.settings.maxCallMs);
    this.#armIdle();
    this.#create({});
  }

  /** Ends the call at the front desk, once: hangs up at OpenAI and closes the sideband. */
  end(reason: EndReason): Promise<void> {
    this.#ended ??= this.#finish(reason);
    return this.#ended;
  }

  async #finish(reason: EndReason): Promise<void> {
    this.#stopTimers();
    await this.#d.control.hangup(this.callId).catch((error) => {
      if (reason !== "hung_up" && !(error instanceof RealtimeCallError && error.gone)) this.#log({ kind: "front_desk_hangup_failed", error: String(error) });
    });
    this.#d.link.close();
    this.#log({ kind: "front_desk_ended", reason, attempts: this.#attempts, durationMs: Date.now() - this.startedAt.getTime(), events: Object.fromEntries(this.#counts) });
    this.#d.onEnded?.(reason);
  }

  #log(entry: Record<string, unknown>) {
    this.#d.log?.({ callId: this.callId, ...entry });
  }

  #stopTimers() {
    for (const t of [this.#idleTimer, this.#maxTimer, this.#keyTimer, this.#ending?.timer ?? null]) if (t) clearTimeout(t);
  }

  #armIdle() {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#ended || this.#handing) return;
    this.#idleTimer = setTimeout(() => this.#onIdle(), this.#d.settings.idleMs);
  }

  /** The line went quiet: the agent is told and decides (the guide says how); after that, the call ends. */
  #onIdle() {
    if (this.#ended || this.#handing || this.#ending) return;
    if (this.#responding) return this.#armIdle();
    this.#quiet += 1;
    if (this.#quiet > QUIET_REPORTS) return void this.end("idle");
    const seconds = Math.round((this.#d.settings.idleMs * this.#quiet) / 1000);
    this.#create({ instructions: `${this.#d.instructions}\n\nNow: the line has been quiet for ${seconds} seconds.` });
    this.#armIdle();
  }

  /** Creates a response now, or after the one in progress. */
  #create(response: Record<string, unknown>) {
    if (this.#ended || this.#handing) return;
    if (this.#responding) {
      this.#pending = response;
      return;
    }
    this.#responding = true;
    this.#d.link.send({ type: "response.create", response });
  }

  #output(callId: unknown, output: Record<string, unknown>) {
    this.#d.link.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: String(callId ?? ""), output: JSON.stringify(output) } });
  }

  async #observe(e: RealtimeEvent): Promise<void> {
    this.#counts.set(e.type, (this.#counts.get(e.type) ?? 0) + 1);
    if (this.#d.trace && !NOISY.has(e.type)) this.#log({ kind: "front_desk_trace", ms: Date.now() - this.startedAt.getTime(), type: e.type, responseId: e.response_id ?? e.response?.id, itemId: e.item_id ?? e.item?.id, status: e.response?.status, error: e.error });
    if (e.type === "conversation.item.input_audio_transcription.completed") {
      const text = String(e.transcript ?? "").trim();
      this.#transcripts.set(e.item_id, text);
      const turn = this.#turns.find((t) => t.role === "caller" && t.itemId === e.item_id);
      if (turn) turn.text = text;
      // The language they speak, from words (a code alone says nothing about it).
      if (/\p{L}/u.test(text)) this.#language = scriptLanguage(text);
      for (const w of this.#waiters.get(e.item_id) ?? []) w();
      this.#waiters.delete(e.item_id);
      return;
    }
    if (this.#ended || this.#handing) return;
    switch (e.type) {
      case "input_audio_buffer.speech_started":
        this.#quiet = 0;
        this.#armIdle();
        // They are talking again: the goodbye was not the end.
        if (this.#ending) {
          clearTimeout(this.#ending.timer);
          this.#ending = null;
          this.#log({ kind: "front_desk_end_cancelled" });
        }
        return;
      case "input_audio_buffer.speech_stopped":
        this.#armIdle();
        return;
      case "input_audio_buffer.committed":
        if (typeof e.item_id === "string" && !this.#turns.some((t) => t.itemId === e.item_id)) this.#turns.push({ role: "caller", itemId: e.item_id, text: this.#transcripts.get(e.item_id) ?? "" });
        return;
      case "input_audio_buffer.dtmf_event_received":
      case "transport.dtmf.received":
        return this.#keypad(String(e.event ?? e.digit ?? e.key ?? ""));
      case "response.created":
        this.#responding = true;
        this.#armIdle();
        return;
      case "output_audio_buffer.stopped":
        if (this.#ending && (e.response_id === undefined || e.response_id === this.#ending.responseId)) {
          clearTimeout(this.#ending.timer);
          this.#ending.timer = setTimeout(() => void this.end("server"), 400);
        }
        return;
      case "error":
        this.#log({ kind: "front_desk_realtime_error", error: e.error });
        // A response that could not start leaves nothing in progress (a clash means one is, and it will finish).
        if (!/active.?response/i.test(String(e.error?.code ?? e.error?.message ?? ""))) this.#responding = false;
        return;
      case "response.done":
        return this.#done(e.response ?? {});
      default:
        return;
    }
  }

  async #done(response: Record<string, any>) {
    this.#responding = false;
    this.#armIdle();
    const output: Array<Record<string, any>> = Array.isArray(response.output) ? response.output : [];
    const spoken = output
      .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
      .map((c: Record<string, any>) => c.transcript ?? c.text ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
    if (spoken) this.#turns.push({ role: "kritva", itemId: null, text: spoken });
    const find = output.find((o) => o.type === "function_call" && o.name === FIND_LISTING_TOOL.name);
    const end = output.find((o) => o.type === "function_call" && o.name === END_CALL_TOOL.name);
    if (find && response.status !== "cancelled") return this.#find(find);
    if (end && response.status !== "cancelled") return this.#endCall(response, end, spoken);
    const next = this.#pending;
    this.#pending = null;
    if (next) this.#create(next);
  }

  /** Keypad presses are passed to the agent as what they pressed, once they pause. */
  #keypad(key: string) {
    if (!/^[0-9*#]$/.test(key)) return;
    this.#quiet = 0;
    this.#armIdle();
    if (this.#keyTimer) clearTimeout(this.#keyTimer);
    if (key !== "#") this.#keys += key;
    const flush = () => {
      this.#keyTimer = null;
      const keys = this.#keys;
      this.#keys = "";
      if (!keys || this.#ended || this.#handing) return;
      this.#log({ kind: "front_desk_keypad", count: keys.length });
      this.#d.link.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `(On the keypad, the caller pressed: ${[...keys].join(" ")})` }] } });
      this.#create({});
    };
    if (key === "#") flush();
    else this.#keyTimer = setTimeout(flush, KEYPAD_PAUSE_MS);
  }

  /** find_listing: the digits are checked and looked up; on a match the call is handed over. */
  async #find(call: Record<string, any>) {
    let raw = "";
    try {
      raw = String(JSON.parse(String(call.arguments ?? "{}")).code ?? "");
    } catch {
      /* no code given */
    }
    const digits = listingCodeDigits(raw);
    this.#attempts += 1;
    const result = await this.#d.lookup(digits).catch((error): Lookup => {
      this.#log({ kind: "front_desk_lookup_failed", error: String(error) });
      return { found: false, reason: "unavailable" };
    });
    this.#log({ kind: "front_desk_lookup", attempt: this.#attempts, found: result.found, reason: result.found ? null : result.reason, sessionId: result.found ? result.sessionId : null });
    if (this.#ended) return;
    if (!result.found) {
      this.#output(call.call_id, { found: false, reason: result.reason, digits_heard: digits, tries: this.#attempts });
      return this.#create({});
    }
    this.#handing = true;
    this.#stopTimers();
    this.#output(call.call_id, { found: true, ...result.listing });
    const seed = await this.#seed();
    const history = this.#turns.slice(0, seed.index).filter((t) => t.text);
    try {
      await this.#d.handOver({ sessionId: result.sessionId, history, seed: { itemId: seed.itemId, transcript: seed.transcript, language: this.#language } });
    } catch (error) {
      this.#log({ kind: "front_desk_handover_failed", sessionId: result.sessionId, error: String(error) });
      this.#handing = false;
      await this.end("error");
    }
  }

  /** The caller's last words before the hand-over, with their transcript (waiting briefly for it). */
  async #seed(): Promise<{ index: number; itemId: string | null; transcript: string | null }> {
    const index = this.#turns.findLastIndex((t) => t.role === "caller");
    if (index < 0) return { index: this.#turns.length, itemId: null, transcript: null };
    const itemId = this.#turns[index]!.itemId;
    if (itemId && !this.#transcripts.has(itemId)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_500);
        const list = this.#waiters.get(itemId) ?? [];
        list.push(() => {
          clearTimeout(timer);
          resolve();
        });
        this.#waiters.set(itemId, list);
      });
    }
    return { index, itemId, transcript: itemId ? (this.#transcripts.get(itemId) ?? null) : null };
  }

  /** The agent ended the call: hang up once its goodbye has played, unless they speak first. */
  #endCall(response: Record<string, any>, end: Record<string, any>, spoken: string) {
    if (!spoken && !this.#goodbyeAsked) {
      // Never hang up on silence: the agent is asked for its goodbye once.
      this.#goodbyeAsked = true;
      this.#output(end.call_id, { ended: false, note: "Say your short, warm goodbye first, then call end_call again." });
      return this.#create({});
    }
    this.#output(end.call_id, { ended: true });
    const responseId = typeof response.id === "string" ? response.id : null;
    this.#ending = { responseId, timer: setTimeout(() => void this.end("server"), playTimeMs(spoken)) };
    this.#log({ kind: "front_desk_ending", attempts: this.#attempts });
  }
}
