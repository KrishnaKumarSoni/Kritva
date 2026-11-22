/**
 * Call-backs after the principal decides (docs/superpowers/specs/2026-11-22-approval-follow-up-design.md).
 *
 *   Kritva → Twilio Calls API (to the counterparty, recorded) → they answer → Twilio asks our answer
 *   URL for TwiML → <Dial><Sip> OpenAI's SIP address with X-Kritva-Follow-Up=<token>
 *   → OpenAI posts realtime.call.incoming → the phone routes claim(headers) → the call joins its
 *     negotiation and opens with the principal's decision.
 *
 * Every webhook carries a random single-use token in its URL; it is the only thing that ties a request
 * to a call-back. No answer, busy or a failed bridge counts as not reached: one retry after
 * KRITVA_FOLLOW_UP_RETRY_MINUTES, then the follow-up lapses (no agreement). Calls in flight are kept
 * in memory: a restart loses them, which the demo accepts.
 */
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { NegotiationEngine, NegotiationRecord } from "@kritva/core";
import { maskNumber, type SipHeader } from "./sip-headers.ts";
import { dialSipTwiml, FINAL_STATUSES, HANGUP_TWIML, readTwilioWebhook, TwilioTelephony, type OutboundTelephony, type TwilioWebhookAuth } from "./twilio.ts";

export interface FollowUpSettings {
  accountSid: string;
  authToken: string;
  /** Kritva's Twilio number, digits with country code: the caller ID the counterparty sees. */
  from: string;
  /** Public base URL of this server, without a trailing slash. */
  publicUrl: string;
  /** Where the answered call is handed: OpenAI's SIP address ("sip:proj_...@sip.api.openai.com;transport=tls"). */
  sipUri: string;
  retryMs: number;
  /** How long a placed call may ring. */
  ringSeconds: number;
}

/** Follow-up call settings from the environment, or null with the reason when call-backs are off. */
export function followUpSettingsFromEnv(env: NodeJS.ProcessEnv, defaultSipUri: string | null): { settings: FollowUpSettings | null; problems: string[] } {
  const problems: string[] = [];
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  // The caller ID: KRITVA_FOLLOW_UP_FROM, else Kritva's number for outbound calls.
  const from = (env.KRITVA_FOLLOW_UP_FROM || env.KRITVA_PHONE_CALLER_ID || "").replace(/\D/g, "");
  const publicUrl = env.KRITVA_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  const sipUri = env.KRITVA_FOLLOW_UP_SIP_URI?.trim() || defaultSipUri || "";
  if (!accountSid || !authToken) problems.push("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are needed.");
  if (from.length < 10) problems.push("KRITVA_PHONE_CALLER_ID (Kritva's Twilio number) is needed.");
  if (!/^https:\/\//.test(publicUrl)) problems.push("KRITVA_PUBLIC_URL (this server's public https address) is needed.");
  if (!sipUri.startsWith("sip:")) problems.push("KRITVA_FOLLOW_UP_SIP_URI is needed (or phone calls with OPENAI_PROJECT_ID).");
  const minutes = Number(env.KRITVA_FOLLOW_UP_RETRY_MINUTES ?? 15);
  if (problems.length) return { settings: null, problems };
  return {
    settings: {
      accountSid: accountSid!,
      authToken: authToken!,
      from,
      publicUrl,
      sipUri,
      retryMs: Math.max(1, Number.isFinite(minutes) ? minutes : 15) * 60_000,
      ringSeconds: 30,
    },
    problems,
  };
}

interface Attempt {
  token: string;
  sessionId: string;
  responseId: string;
  attempt: number;
  phone: string;
  placedAt: number;
  answeredAt: number | null;
  /** The bridged call reached OpenAI and joined the negotiation. */
  joined: boolean;
  finished: boolean;
}

export interface FollowUpDeps {
  record: NegotiationRecord;
  engine: NegotiationEngine;
  settings: FollowUpSettings;
  log?: (entry: Record<string, unknown>) => void;
  /** Places and ends calls. Default: Twilio with the settings' credentials (and `fetch`, for tests). */
  telephony?: OutboundTelephony;
  fetch?: typeof fetch;
  /** Checks the signature on Twilio's webhooks. Absent: not checked (tests). */
  twilio?: TwilioWebhookAuth | null;
  /** Schedules the retry (tests run it at once). */
  later?: (fn: () => void, ms: number) => void;
  now?: () => number;
}

export class FollowUpCalls {
  readonly #d: FollowUpDeps;
  readonly #attempts = new Map<string, Attempt>();
  readonly #telephony: OutboundTelephony;

  constructor(deps: FollowUpDeps) {
    this.#d = deps;
    this.#telephony = deps.telephony ?? new TwilioTelephony({ accountSid: deps.settings.accountSid, authToken: deps.settings.authToken }, { fetch: deps.fetch });
  }

  #log(entry: Record<string, unknown>) {
    this.#d.log?.({ kind: "follow_up", ...entry });
  }

  #now() {
    return this.#d.now?.() ?? Date.now();
  }

  /** Calls the buyer for the principal's latest decision. Attempt 2 is the retry; there is no third. */
  async start(sessionId: string, phone: string, attempt = 1): Promise<{ ok: boolean; error?: string }> {
    const state = await this.#d.engine.state(sessionId);
    const decision = state.followUp.decision;
    if (!decision || state.followUp.followedUp) return { ok: false, error: "nothing_to_follow_up" };
    const token = randomBytes(18).toString("base64url");
    const a: Attempt = { token, sessionId, responseId: decision.responseId, attempt, phone, placedAt: this.#now(), answeredAt: null, joined: false, finished: false };
    this.#attempts.set(token, a);
    const url = (path: string) => `${this.#d.settings.publicUrl}/api/phone/twilio/follow-up/${token}/${path}`;
    let providerCallId: string | null = null;
    // Noted before the call is placed, so the call's own webhooks can never come before it.
    await this.#note(a, "calling", null);
    try {
      // The whole call is recorded for the principal; the recording arrives at url("recording").
      const placed = await this.#telephony.placeCall({ from: `+${this.#d.settings.from}`, to: `+${phone}`, answerUrl: url("answer"), statusUrl: url("status"), recordingUrl: url("recording"), ringSeconds: this.#d.settings.ringSeconds, timeLimitSeconds: 1800 });
      providerCallId = placed.providerCallId.slice(0, 200);
    } catch (error) {
      this.#log({ event: "dial_failed", sessionId, attempt, to: maskNumber(phone), error: String(error) });
      a.finished = true;
      await this.#note(a, "failed", null);
      await this.#notReached(a);
      return { ok: false, error: String(error) };
    }
    this.#log({ event: "calling", sessionId, attempt, to: maskNumber(phone), providerCallId });
    return { ok: true };
  }

  /**
   * The incoming OpenAI call for a call-back: the token in a SIP header, or else the one call-back
   * answered in the last 30 seconds that has not joined yet. Null for any other call.
   */
  claim(headers: SipHeader[]): { sessionId: string } | null {
    const open = [...this.#attempts.values()].filter((a) => !a.joined && !a.finished);
    let found = open.find((a) => headers.some((h) => h.value.includes(a.token)));
    if (!found) {
      const recent = open.filter((a) => a.answeredAt !== null && this.#now() - a.answeredAt < 30_000);
      if (recent.length === 1) found = recent[0];
    }
    if (!found) return null;
    found.joined = true;
    this.#log({ event: "joined", sessionId: found.sessionId, attempt: found.attempt });
    void this.#note(found, "reached", null);
    return { sessionId: found.sessionId };
  }

  /** Twilio's webhooks for call-backs. Each answers fast; the token in the path decides which call-back it is about. */
  register(app: Hono): void {
    const find = (token: string | undefined) => (token ? this.#attempts.get(token) ?? null : null);
    const signed = async (c: Parameters<typeof readTwilioWebhook>[0], route: string) => {
      const hook = await readTwilioWebhook(c, this.#d.twilio ?? null);
      if (!hook.ok) this.#log({ event: "twilio_signature_mismatch", route, url: hook.url });
      return hook.ok ? hook.params : null;
    };
    const base = "/api/phone/twilio/follow-up/:token";

    app.post(`${base}/answer`, async (c) => {
      if (!(await signed(c, "answer"))) return c.body(HANGUP_TWIML, 403, { "Content-Type": "text/xml" });
      const a = find(c.req.param("token"));
      if (!a || a.finished) return c.body(HANGUP_TWIML, 200, { "Content-Type": "text/xml" });
      a.answeredAt = this.#now();
      // Hand the answered call to the realtime voice, tagged so claim() finds its negotiation.
      return c.body(dialSipTwiml({ sipUri: this.#d.settings.sipUri, headers: { "X-Kritva-Follow-Up": a.token }, timeLimitSeconds: 1800 }), 200, { "Content-Type": "text/xml" });
    });

    app.post(`${base}/status`, async (c) => {
      const p = await signed(c, "status");
      if (!p) return c.json({ error: "bad_signature" }, 403);
      const a = find(c.req.param("token"));
      if (!FINAL_STATUSES.has((p.CallStatus ?? "").toLowerCase())) return c.json({ ok: true });
      if (!a || a.finished) return c.json({ ok: true });
      a.finished = true;
      if (!a.joined) {
        this.#log({ event: a.answeredAt === null ? "no_answer" : "not_bridged", sessionId: a.sessionId, attempt: a.attempt });
        await this.#note(a, a.answeredAt === null ? "no_answer" : "failed", null);
        await this.#notReached(a);
      }
      return c.json({ ok: true });
    });

    app.post(`${base}/recording`, async (c) => {
      const p = await signed(c, "recording");
      if (!p) return c.json({ error: "bad_signature" }, 403);
      const a = find(c.req.param("token"));
      const file = String(p.RecordingUrl ?? "");
      if (a && /^https:\/\//.test(file)) {
        const seconds = Number(p.RecordingDuration);
        const saved = await this.#d.record.append(a.sessionId, { id: `rec_${a.token}`.slice(0, 128), type: "recording_saved", channel: null, payload: { source: "twilio", file: file.slice(0, 500), contentType: "audio/mpeg", durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null } }, { kind: "system", partyId: null });
        if (!saved.ok) this.#log({ event: "recording_not_saved", sessionId: a.sessionId, error: saved.error.message });
      }
      return c.json({ ok: true });
    });
  }

  async #note(a: Attempt, outcome: "calling" | "reached" | "no_answer" | "failed", providerCallId: string | null) {
    const recorded = await this.#d.record.append(
      a.sessionId,
      { id: `fu_${a.token}_${outcome}`.slice(0, 128), type: "follow_up_attempted", channel: null, payload: { responseId: a.responseId, channel: "call", attempt: a.attempt, outcome, providerCallId } },
      { kind: "system", partyId: null },
    );
    if (!recorded.ok) this.#log({ event: "attempt_not_recorded", sessionId: a.sessionId, error: recorded.error.message });
  }

  /** Not reached: retry once, later; after the retry, the follow-up lapses. */
  async #notReached(a: Attempt) {
    if (a.attempt >= 2) {
      const lapsed = await this.#d.engine.lapseFollowUp({ sessionId: a.sessionId, reason: "The call-back was not answered, twice." });
      this.#log({ event: "lapsed", sessionId: a.sessionId, ok: lapsed.ok });
      return;
    }
    const retry = () => void this.start(a.sessionId, a.phone, a.attempt + 1).catch((error) => this.#log({ event: "retry_failed", sessionId: a.sessionId, error: String(error) }));
    (this.#d.later ?? ((fn, ms) => void setTimeout(fn, ms).unref?.()))(retry, this.#d.settings.retryMs);
  }
}
