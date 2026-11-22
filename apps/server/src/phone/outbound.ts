/**
 * Outbound calls: Kritva dials a counterparty for an existing negotiation session
 * (docs/Kritva_Phone_Calls.md, "Outbound calls").
 *
 *   call({ sessionId, to })
 *     → Vobiz Make Call (from Kritva's number, to them)          state: dialling
 *     → Vobiz ring callback                                       state: ringing
 *     → they answer; Vobiz asks the answer URL for XML            state: answered
 *       → the XML bridges the call to OpenAI's SIP address, tagged with this call's token
 *     → OpenAI's realtime.call.incoming webhook carries the tag   state: connected
 *       → routes.ts accepts it into the session (not a new one) and runs the same PhoneCall
 *     → hang-up (theirs, Kritva's, or the provider's)             state: ended, with an outcome
 *
 * The counterparty's number lives only in memory here and is masked in logs and views; the
 * negotiation record gets voice_connection events (direction "outbound"), never the number.
 * Every number must be on the allowlist (KRITVA_PHONE_OUTBOUND_ALLOW) until real calling is
 * approved: Indian rules restrict business calls (consent, Do-Not-Disturb, number series).
 */
import { randomBytes } from "node:crypto";
import type { NegotiationEngine } from "@kritva/core";
import { normalizeNumber } from "./config.ts";
import { maskNumber, type SipHeader } from "./sip-headers.ts";
import { bridgeXml, type OutboundTelephony } from "./vobiz.ts";

export interface OutboundSettings {
  /** Kritva's Vobiz number, digits with country code ("918064264194"). */
  callerId: string;
  /** Public HTTPS base URL Vobiz can reach for its callbacks (the tunnel or the deployed host). */
  publicUrl: string;
  /** OpenAI's SIP URI the answered call is bridged to ("sip:proj_...@sip.api.openai.com:5061;transport=tls"). */
  bridgeUri: string;
  /** Numbers Kritva may call (digits with country code), or ["*"] for any. Empty: none. */
  allow: string[];
  /** Calls at once (dialling, ringing or connected). */
  maxCalls: number;
  /** Longest a connected call may run, in seconds. */
  timeLimitSeconds: number;
  countryCode: string;
}

/** queued: waiting for a free line (more calls than KRITVA_PHONE_MAX_CALLS were asked for at once). */
export type OutboundState = "queued" | "dialling" | "ringing" | "answered" | "connected" | "ended";
export type OutboundOutcome = "completed" | "no_answer" | "busy" | "failed" | "cancelled";

/** What callers see of a call. The number is masked. */
export interface OutboundCallView {
  callId: string;
  sessionId: string;
  to: string;
  state: OutboundState;
  outcome: OutboundOutcome | null;
  startedAt: string;
  answeredAt: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  /** The provider's or Kritva's reason, when the call ended other than normally. */
  endReason: string | null;
}

/** Calls over the line limit are queued, not refused, so there is no "busy" error. */
export type OutboundError = "phone_off" | "invalid_number" | "not_allowed" | "session_not_active" | "provider_error";

interface OutboundCall {
  callId: string;
  token: string;
  sessionId: string;
  to: string;
  state: OutboundState;
  outcome: OutboundOutcome | null;
  providerCallId: string | null;
  /** OpenAI's call ID once the bridge arrived. */
  realtimeCallId: string | null;
  startedAt: Date;
  answeredAt: Date | null;
  connectedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
}

/** Vobiz hang-up causes that mean the call never connected, mapped to an outcome. */
const UNANSWERED: Array<[RegExp, OutboundOutcome]> = [
  [/busy/i, "busy"],
  [/no.?answer|timeout|not.?answered|unallocated|no.?user/i, "no_answer"],
  [/cancel|originator/i, "cancelled"],
];

/** A bridged call answered with no OpenAI webhook within this time is treated as failed. */
const BRIDGE_WAIT_MS = 45_000;

export interface OutboundDeps {
  engine: NegotiationEngine;
  telephony: OutboundTelephony;
  settings: OutboundSettings;
  log?: (entry: Record<string, unknown>) => void;
}

export class OutboundDialer {
  readonly #d: OutboundDeps;
  readonly #calls = new Map<string, OutboundCall>();
  readonly #byToken = new Map<string, OutboundCall>();
  readonly #byRequest = new Map<string, Promise<CallResult>>();
  readonly #listeners = new Set<(call: OutboundCallView) => void>();

  constructor(deps: OutboundDeps) {
    this.#d = deps;
  }

  get settings(): OutboundSettings {
    return this.#d.settings;
  }

  /** Places a call for a session. A repeated clientRequestId returns the first call, so a double click calls once. */
  call(input: { sessionId: string; to: string; clientRequestId?: string | null }): Promise<CallResult> {
    const key = input.clientRequestId ? `${input.sessionId}:${input.clientRequestId}` : null;
    if (key && this.#byRequest.has(key)) return this.#byRequest.get(key)!;
    const result = this.#place(input.sessionId, input.to);
    if (key) {
      this.#byRequest.set(key, result);
      void result.then((r) => {
        if (!r.ok) this.#byRequest.delete(key);
      });
    }
    return result;
  }

  async #place(sessionId: string, rawTo: string): Promise<CallResult> {
    const s = this.#d.settings;
    const to = normalizeNumber(rawTo ?? "", s.countryCode);
    if (!/^\d{10,15}$/.test(to)) return fail("invalid_number", "That doesn't look like a phone number. Use the full number, for example +91 98765 43210.");
    if (!s.allow.includes("*") && !s.allow.includes(to)) return fail("not_allowed", "Calling this number isn't allowed yet. Add it to KRITVA_PHONE_OUTBOUND_ALLOW once calling it is approved.");
    const briefing = await this.#d.engine.voiceBriefing(sessionId);
    if (!briefing || briefing.status !== "active") return fail("session_not_active", "This negotiation isn't active, so Kritva can't call about it.");

    const call: OutboundCall = { callId: `oc_${randomBytes(9).toString("base64url")}`, token: randomBytes(18).toString("base64url"), sessionId, to, state: "queued", outcome: null, providerCallId: null, realtimeCallId: null, startedAt: new Date(), answeredAt: null, connectedAt: null, endedAt: null, endReason: null };
    this.#calls.set(call.callId, call);
    this.#byToken.set(call.token, call);
    // Over the line limit the call waits its turn; "Start negotiations" asks for every counterparty at once.
    if (this.#lines().length >= s.maxCalls) {
      this.#log({ kind: "outbound_queued", callId: call.callId, sessionId, to: maskNumber(to) });
      this.#emit(call);
      return { ok: true, call: view(call) };
    }
    const dialled = await this.#dial(call);
    return dialled ? { ok: true, call: view(call) } : fail("provider_error", "The call couldn't be placed. Nothing was dialled.");
  }

  /** Asks Vobiz to ring the number. False when the provider refused (the call is then ended as failed). */
  async #dial(call: OutboundCall): Promise<boolean> {
    const s = this.#d.settings;
    call.state = "dialling";
    const base = `${s.publicUrl.replace(/\/+$/, "")}/api/phone/vobiz/${call.token}`;
    try {
      const placed = await this.#d.telephony.placeCall({ from: `+${s.callerId}`, to: `+${call.to}`, answerUrl: `${base}/answer`, ringUrl: `${base}/ring`, hangupUrl: `${base}/hangup`, timeLimitSeconds: s.timeLimitSeconds });
      call.providerCallId = placed.providerCallId;
    } catch (error) {
      this.#end(call, "failed", `provider: ${String(error).slice(0, 200)}`);
      return false;
    }
    // Cancelled while Vobiz was queuing it (the state can change during the await): end the provider's call too.
    if ((call.state as OutboundState) === "ended") {
      void this.#d.telephony.hangup(call.providerCallId).catch(() => undefined);
      return true;
    }
    this.#log({ kind: "outbound_placed", callId: call.callId, sessionId: call.sessionId, to: maskNumber(call.to), providerCallId: call.providerCallId });
    this.#emit(call);
    return true;
  }

  /** Dials queued calls, oldest first, while lines are free. A queued call whose negotiation stopped is cancelled. */
  #pump() {
    const max = this.#d.settings.maxCalls;
    for (const call of [...this.#calls.values()].filter((c) => c.state === "queued")) {
      if (this.#lines().length >= max) return;
      call.state = "dialling";
      void this.#d.engine
        .voiceBriefing(call.sessionId)
        .then(async (b) => {
          if (b?.status === "active") await this.#dial(call);
          else this.#end(call, "cancelled", "The negotiation stopped before the call was placed.");
        })
        .catch((error) => this.#end(call, "failed", String(error)));
    }
  }

  /** The counterparty's number for a call, digits with country code, in memory only (for the live-call registry while it lasts). */
  dialledNumber(callId: string): string | null {
    const call = this.#calls.get(callId);
    return call && call.state !== "ended" ? call.to : null;
  }

  get(callId: string): OutboundCallView | null {
    const call = this.#calls.get(callId);
    return call ? view(call) : null;
  }

  listForSession(sessionId: string): OutboundCallView[] {
    return [...this.#calls.values()].filter((c) => c.sessionId === sessionId).map(view);
  }

  /** Ends a call in any state (cancels one still ringing). */
  async hangup(callId: string): Promise<boolean> {
    const call = this.#calls.get(callId);
    if (!call || call.state === "ended") return false;
    if (call.providerCallId) await this.#d.telephony.hangup(call.providerCallId).catch((error) => this.#log({ kind: "outbound_hangup_failed", callId, error: String(error) }));
    this.#end(call, call.connectedAt ? "completed" : "cancelled", "Kritva ended the call.");
    return true;
  }

  /** Status changes, for the multi-party coordinator. Returns the unsubscribe function. */
  onChange(listener: (call: OutboundCallView) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ---------- Vobiz callbacks (public routes, authorised by the unguessable token in the URL) ----------

  /** Vobiz rang the number. */
  ringing(token: string): boolean {
    const call = this.#byToken.get(token);
    if (!call) return false;
    if (call.state === "dialling") {
      call.state = "ringing";
      this.#emit(call);
    }
    return true;
  }

  /** They answered: the XML that bridges the call to OpenAI, or null for an unknown or finished call. */
  answered(token: string): string | null {
    const call = this.#byToken.get(token);
    if (!call || call.state === "ended") return null;
    call.state = "answered";
    call.answeredAt = new Date();
    this.#log({ kind: "outbound_answered", callId: call.callId, sessionId: call.sessionId });
    this.#emit(call);
    // If OpenAI never reports the bridged call, don't leave the person on a silent line.
    setTimeout(() => {
      if (call.state === "answered") {
        this.#log({ kind: "outbound_bridge_missing", callId: call.callId });
        void this.#d.telephony.hangup(call.providerCallId ?? "").catch(() => undefined);
        this.#end(call, "failed", "The call was answered but never reached Kritva's voice.");
      }
    }, BRIDGE_WAIT_MS).unref?.();
    return bridgeXml({ callerId: `+${this.#d.settings.callerId}`, sipUri: this.#d.settings.bridgeUri, token: call.token, timeLimitSeconds: this.#d.settings.timeLimitSeconds });
  }

  /** Vobiz reports the call over, with its hang-up cause when it gives one. */
  hungUp(token: string, cause: string | null): boolean {
    const call = this.#byToken.get(token);
    if (!call) return false;
    if (call.state === "ended") return true;
    if (call.connectedAt) return this.#end(call, "completed", cause), true;
    if (call.answeredAt) return this.#end(call, "failed", cause ?? "Answered, but the call ended before Kritva's voice joined."), true;
    const outcome = UNANSWERED.find(([rx]) => rx.test(cause ?? ""))?.[1] ?? "no_answer";
    this.#end(call, outcome, cause);
    return true;
  }

  // ---------- The bridged call arriving at OpenAI ----------

  /**
   * The outbound call an incoming realtime call belongs to: the token in a SIP header that Vobiz
   * added from `sipHeaders` (any header whose name mentions kritva_call, or a value carrying
   * `kritva_call=<token>`). Without the tag, the one call that is answered and waiting for its
   * bridge, if there is exactly one.
   */
  match(headers: SipHeader[]): { callId: string; sessionId: string; how: "header" | "only_waiting" } | null {
    for (const h of headers) {
      const fromName = /kritva[_-]?call/i.test(h.name) ? h.value.trim() : null;
      const fromValue = /kritva[_-]?call[=:]\s*([\w-]{16,})/i.exec(h.value)?.[1] ?? null;
      const call = this.#byToken.get(fromName ?? fromValue ?? "");
      if (call && call.state !== "ended") return { callId: call.callId, sessionId: call.sessionId, how: "header" };
    }
    const waiting = [...this.#calls.values()].filter((c) => c.state === "answered");
    return waiting.length === 1 ? { callId: waiting[0]!.callId, sessionId: waiting[0]!.sessionId, how: "only_waiting" } : null;
  }

  /** The bridged call was accepted and joined. */
  connected(callId: string, realtimeCallId: string): void {
    const call = this.#calls.get(callId);
    if (!call || call.state === "ended") return;
    call.state = "connected";
    call.connectedAt = new Date();
    call.realtimeCallId = realtimeCallId;
    this.#emit(call);
  }

  /** The realtime side of the call ended (hang-up, silence, time limit): make sure the phone leg ends too. */
  realtimeEnded(callId: string, reason: string): void {
    const call = this.#calls.get(callId);
    if (!call || call.state === "ended") return;
    if (call.providerCallId) void this.#d.telephony.hangup(call.providerCallId).catch(() => undefined);
    this.#end(call, call.connectedAt ? "completed" : "failed", reason === "hung_up" ? null : reason);
  }

  /** Calls using a line: dialling, ringing, answered or connected (not queued, not ended). */
  #lines() {
    return [...this.#calls.values()].filter((c) => c.state !== "ended" && c.state !== "queued");
  }

  #end(call: OutboundCall, outcome: OutboundOutcome, reason: string | null) {
    if (call.state === "ended") return;
    call.state = "ended";
    call.outcome = outcome;
    call.endedAt = new Date();
    call.endReason = reason;
    this.#log({ kind: "outbound_ended", callId: call.callId, sessionId: call.sessionId, outcome, reason });
    this.#emit(call);
    // A line is free: the next queued call goes out.
    this.#pump();
  }

  #emit(call: OutboundCall) {
    const v = view(call);
    for (const l of this.#listeners) {
      try {
        l(v);
      } catch (error) {
        this.#log({ kind: "outbound_listener_failed", error: String(error) });
      }
    }
  }

  #log(entry: Record<string, unknown>) {
    this.#d.log?.(entry);
  }
}

export type CallResult = { ok: true; call: OutboundCallView } | { ok: false; code: OutboundError; message: string };

const fail = (code: OutboundError, message: string): CallResult => ({ ok: false, code, message });

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function view(c: OutboundCall): OutboundCallView {
  return { callId: c.callId, sessionId: c.sessionId, to: maskNumber(c.to) ?? "", state: c.state, outcome: c.outcome, startedAt: c.startedAt.toISOString(), answeredAt: iso(c.answeredAt), connectedAt: iso(c.connectedAt), endedAt: iso(c.endedAt), endReason: c.endReason };
}
