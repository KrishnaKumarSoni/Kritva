/**
 * Call-backs after the principal decides (docs/superpowers/specs/2026-11-22-approval-follow-up-design.md).
 *
 *   Kritva → Vobiz Make Call (to the buyer) → buyer answers → Vobiz asks our answer URL for XML
 *   → <Record> the call, <Dial><User sipHeaders="KritvaFollowUp=token"> OpenAI's SIP address
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

export interface FollowUpSettings {
  authId: string;
  authToken: string;
  /** Kritva's Vobiz number, digits with country code: the caller ID the buyer sees. */
  from: string;
  /** Public base URL of this server (the tunnel), without a trailing slash. */
  publicUrl: string;
  /** Where the answered call is bridged: OpenAI's SIP address (or Kritva's own number, as a fallback). */
  sipUri: string;
  retryMs: number;
  /** How long a placed call may ring. */
  ringSeconds: number;
  apiBase: string;
}

/** Follow-up call settings from the environment, or null with the reason when call-backs are off. */
export function followUpSettingsFromEnv(env: NodeJS.ProcessEnv, defaultSipUri: string | null): { settings: FollowUpSettings | null; problems: string[] } {
  const problems: string[] = [];
  const authId = env.VOBIZ_AUTH_ID?.trim();
  const authToken = env.VOBIZ_AUTH_TOKEN?.trim();
  const from = env.KRITVA_FOLLOW_UP_FROM?.replace(/\D/g, "") ?? "";
  const publicUrl = env.KRITVA_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  const sipUri = env.KRITVA_FOLLOW_UP_SIP_URI?.trim() || (defaultSipUri ? `${defaultSipUri};transport=tls` : "");
  if (!authId || !authToken) problems.push("VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN are needed.");
  if (from.length < 10) problems.push("KRITVA_FOLLOW_UP_FROM (Kritva's Vobiz number) is needed.");
  if (!/^https:\/\//.test(publicUrl)) problems.push("KRITVA_PUBLIC_URL (the https tunnel to this server) is needed.");
  if (!sipUri.startsWith("sip:")) problems.push("KRITVA_FOLLOW_UP_SIP_URI is needed (or phone calls with OPENAI_PROJECT_ID).");
  const minutes = Number(env.KRITVA_FOLLOW_UP_RETRY_MINUTES ?? 15);
  if (problems.length) return { settings: null, problems };
  return {
    settings: {
      authId: authId!,
      authToken: authToken!,
      from,
      publicUrl,
      sipUri,
      retryMs: Math.max(1, Number.isFinite(minutes) ? minutes : 15) * 60_000,
      ringSeconds: 30,
      apiBase: env.VOBIZ_API_BASE?.trim().replace(/\/+$/, "") || "https://api.vobiz.ai/api/v1",
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
  fetch?: typeof fetch;
  /** Schedules the retry (tests run it at once). */
  later?: (fn: () => void, ms: number) => void;
  now?: () => number;
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export class FollowUpCalls {
  readonly #d: FollowUpDeps;
  readonly #attempts = new Map<string, Attempt>();

  constructor(deps: FollowUpDeps) {
    this.#d = deps;
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
    const url = (path: string) => `${this.#d.settings.publicUrl}/api/webhooks/vobiz/${path}?t=${token}`;
    let providerCallId: string | null = null;
    // Noted before the call is placed, so the call's own webhooks can never come before it.
    await this.#note(a, "calling", null);
    try {
      const res = await (this.#d.fetch ?? fetch)(`${this.#d.settings.apiBase}/Account/${encodeURIComponent(this.#d.settings.authId)}/Call/`, {
        method: "POST",
        headers: { "X-Auth-ID": this.#d.settings.authId, "X-Auth-Token": this.#d.settings.authToken, "Content-Type": "application/json" },
        // Numbers in E.164 with "+", as the phone routes' tested outbound calls send them.
        body: JSON.stringify({ from: `+${this.#d.settings.from}`, to: `+${phone}`, answer_url: url("answer"), answer_method: "POST", hangup_url: url("hangup"), hangup_method: "POST", hangup_on_ring: this.#d.settings.ringSeconds, time_limit: 1800 }),
        signal: AbortSignal.timeout(8_000),
      });
      const body = (await res.json().catch(() => ({}))) as { request_uuid?: string; message?: string };
      if (!res.ok) throw new Error(`Vobiz ${res.status}: ${String(body.message ?? "").slice(0, 200)}`);
      providerCallId = typeof body.request_uuid === "string" ? body.request_uuid.slice(0, 200) : null;
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

  /** The provider's webhooks. Each answers fast; the token decides which call-back it is about. */
  register(app: Hono): void {
    const find = (token: string | undefined) => (token ? this.#attempts.get(token) ?? null : null);
    const form = async (c: { req: { parseBody(): Promise<Record<string, unknown>> } }) => (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;

    app.post("/api/webhooks/vobiz/answer", async (c) => {
      const a = find(c.req.query("t"));
      if (!a || a.finished) return c.body('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>', 200, { "Content-Type": "application/xml" });
      a.answeredAt = this.#now();
      const s = this.#d.settings;
      const url = (path: string) => xml(`${s.publicUrl}/api/webhooks/vobiz/${path}?t=${a.token}`);
      // Record the whole call for the principal, then bridge it to the realtime voice.
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" fileFormat="mp3" maxLength="1800" playBeep="false" redirect="false" callbackUrl="${url("recording")}" callbackMethod="POST"/>
  <Dial callerId="${xml(`+${s.from}`)}" timeout="${s.ringSeconds}" action="${url("dial")}" method="POST" redirect="false">
    <User sipHeaders="${xml(`KritvaFollowUp=${a.token}`)}">${xml(s.sipUri)}</User>
  </Dial>
</Response>`;
      return c.body(body, 200, { "Content-Type": "application/xml" });
    });

    app.post("/api/webhooks/vobiz/dial", async (c) => {
      const a = find(c.req.query("t"));
      const p = await form(c);
      if (a) this.#log({ event: "dial_result", sessionId: a.sessionId, attempt: a.attempt, status: String(p.DialStatus ?? "") });
      return c.body('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>', 200, { "Content-Type": "application/xml" });
    });

    app.post("/api/webhooks/vobiz/hangup", async (c) => {
      const a = find(c.req.query("t"));
      if (!a || a.finished) return c.json({ ok: true });
      a.finished = true;
      if (!a.joined) {
        this.#log({ event: a.answeredAt === null ? "no_answer" : "not_bridged", sessionId: a.sessionId, attempt: a.attempt });
        await this.#note(a, a.answeredAt === null ? "no_answer" : "failed", null);
        await this.#notReached(a);
      }
      return c.json({ ok: true });
    });

    app.post("/api/webhooks/vobiz/recording", async (c) => {
      const a = find(c.req.query("t"));
      const p = await form(c);
      const file = String(p.RecordUrl ?? p.RecordFile ?? "");
      if (a && /^https:\/\//.test(file)) {
        const seconds = Number(p.RecordingDuration);
        const saved = await this.#d.record.append(a.sessionId, { id: `rec_${a.token}`.slice(0, 128), type: "recording_saved", channel: null, payload: { source: "vobiz", file: file.slice(0, 500), contentType: "audio/mpeg", durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null } }, { kind: "system", partyId: null });
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
