/**
 * Phone calls into Kritva (docs/Kritva_Phone_Calls.md).
 *
 *   Caller → Vobiz number → Vobiz SIP trunk (TLS + SRTP) → OpenAI SIP, India edge (sip-in.api.openai.com)
 *                                                                    │ webhook: realtime.call.incoming
 *                                                                    ▼
 *   POST /api/webhooks/openai → verify signature → route the dialled number to a listing or mandate
 *        → start a negotiation session → accept the call (same session settings as a browser call)
 *        → join over the sideband WebSocket → PhoneCall (RealtimeCall + server-side delivery)
 *
 * Audio never passes through this server: OpenAI and Vobiz exchange it directly. The server only
 * answers the webhook, controls the call and handles its events, exactly as for a browser call.
 *
 * SIP replies when a call cannot be taken (the caller hears the network's tone or message):
 *   404 the number has no route · 480 the listing is paused or closed, or its mandate is missing or
 *   not live · 486 busy (KRITVA_PHONE_MAX_CALLS calls already) · 500 a session could not start.
 */
import type { Hono } from "hono";
import type { ConfirmedMandate, DealGroups, MandateLibrary, NegotiationEngine, NegotiationRecord } from "@kritva/core";
import { openSessionFor, startNegotiation } from "../group-routes.ts";
import type { LiveCalls } from "../live-calls.ts";
import type { ListingConfig } from "../main-helpers.ts";
import { OpenAIRealtimeConnector, realtimeSession, RealtimeCallError, type RealtimeCallControl, type RealtimeConnector, type RealtimeSettings } from "../realtime-voice.ts";
import { resolveListing } from "../voice-routes.ts";
import { normalizeNumber, phoneSettingsFromEnv, sipUri, type PhoneSettings, type PhoneTarget } from "./config.ts";
import { PhoneCall } from "./phone-call.ts";
import { callerNumber, maskNumber, routeFor, type SipHeader } from "./sip-headers.ts";
import { verifyWebhook, WebhookSignatureError } from "./webhook-signature.ts";

/** The URL path to give OpenAI as the project's webhook endpoint. */
export const WEBHOOK_PATH = "/api/webhooks/openai";

/** Waits before each accept attempt; three attempts stay within the few seconds a webhook may take. */
const ACCEPT_BACKOFF_MS = [0, 300, 900];

export interface PhoneDeps {
  /** Several counterparties per saved mandate (docs/Kritva_Multiple_Counterparties.md). */
  groups?: DealGroups | null;
  /** Calls connected now, with the caller's number while the call lasts. */
  liveCalls?: LiveCalls | null;
  record: NegotiationRecord;
  engine: NegotiationEngine;
  library: MandateLibrary | null;
  listings: ListingConfig[];
  /** Joins calls (attach) and controls them (accept, reject, hangup). */
  connector: RealtimeConnector & RealtimeCallControl;
  settings: PhoneSettings;
  realtime: RealtimeSettings;
  log?: (entry: Record<string, unknown>) => void;
  /** How often a call checks for engine messages to speak (tests use a short interval). */
  pollMs?: number;
  /** Waits before each accept attempt (tests use none). */
  acceptBackoffMs?: number[];
}

/** What starting a negotiation for a call needs: the confirmed mandate and where it came from. */
type Resolved = { ok: true; mandate: ConfirmedMandate; source: { mandateId: string; revision: number } } | { ok: false; sip: number; reason: string };

/** Live phone calls by OpenAI call ID; the returned handle lets the server end them on shutdown. */
export interface PhoneHandle {
  calls: Map<string, PhoneCall>;
  endAll(): Promise<void>;
}

export function registerPhoneRoutes(app: Hono, deps: PhoneDeps): PhoneHandle {
  const { record, engine, settings } = deps;
  const log = (entry: Record<string, unknown>) => deps.log?.(entry);
  const calls = new Map<string, PhoneCall>();
  /** Webhooks being handled, by call ID: a retry while one is in flight waits for the same result. */
  const inFlight = new Map<string, Promise<{ status: 200 | 500; body: Record<string, unknown> }>>();
  /** Calls already answered or declined (kept an hour), so a retried webhook does nothing twice. */
  const handled = new Map<string, number>();
  /** The session started for a call, reused if OpenAI retries after a failed accept. */
  const sessions = new Map<string, string>();
  /** The caller's number per call, kept in memory only while the call is being set up and connected. */
  const callers = new Map<string, string | null>();
  let connecting = 0;

  const resolve = (target: PhoneTarget): Resolved => {
    if (target.kind === "listing") {
      const r = resolveListing(deps.listings, deps.library, target.caseId);
      if ("error" in r) return { ok: false, sip: r.error.body.error === "not_found" ? 404 : 480, reason: r.error.body.error };
      return { ok: true, mandate: r.active.mandate, source: { mandateId: r.listing.libraryId, revision: r.active.revision } };
    }
    const detail = deps.library?.get(target.mandateId) ?? null;
    if (!detail || detail.deleted) return { ok: false, sip: 404, reason: "mandate_not_found" };
    if (detail.state !== "live") return { ok: false, sip: 480, reason: `mandate_${detail.state}` };
    const active = deps.library!.active(target.mandateId);
    if (!active) return { ok: false, sip: 480, reason: "mandate_missing" };
    return { ok: true, mandate: active.mandate, source: { mandateId: target.mandateId, revision: active.revision } };
  };

  /**
   * Answers the call, retrying a server error or timeout twice within the webhook. OpenAI answers
   * an accept for a call that no longer exists with 503 and no body (measured 2026-11-22), so a 503
   * cannot be told from an outage: both are retried, and a 404 is final.
   */
  const acceptWithRetry = async (callId: string, session: Record<string, unknown>): Promise<{ ok: true; attempts: number } | { ok: false; gone: boolean; error: string }> => {
    let last: unknown = null;
    for (const [attempt, wait] of (deps.acceptBackoffMs ?? ACCEPT_BACKOFF_MS).entries()) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        await deps.connector.accept(callId, session);
        return { ok: true, attempts: attempt + 1 };
      } catch (error) {
        last = error;
        if (error instanceof RealtimeCallError && error.status < 500) return { ok: false, gone: error.gone, error: String(error) };
      }
    }
    return { ok: false, gone: false, error: String(last) };
  };

  const reject = async (callId: string, sip: number, reason: string) => {
    log({ kind: "phone_rejected", callId, sip, reason });
    await deps.connector.reject(callId, sip).catch((error) => log({ kind: "phone_reject_failed", callId, error: String(error) }));
    return { status: 200 as const, body: { ok: true, rejected: sip, reason } };
  };

  /** After the accept: join the call and run it. A call that cannot be joined is hung up at once. */
  const connect = async (callId: string, sessionId: string) => {
    connecting += 1;
    try {
      let link;
      try {
        link = await deps.connector.attach(callId);
      } catch (error) {
        log({ kind: "phone_attach_failed", callId, sessionId, error: String(error) });
        await deps.connector.hangup(callId).catch(() => undefined);
        await record.append(sessionId, { id: `voice_end_${callId.replace(/[^\w-]/g, "")}`.slice(0, 128), type: "voice_connection", channel: "voice", payload: { status: "ended", transport: "phone", reason: "error" } }, { kind: "system", partyId: null });
        return;
      }
      const afterSeq = (await record.context(sessionId)).events.at(-1)?.seq ?? 0;
      const call: PhoneCall = new PhoneCall({
        engine, record, sessionId, callId, link, control: deps.connector, settings, afterSeq, log, pollMs: deps.pollMs,
        onEnded: () => {
          calls.delete(callId);
          callers.delete(callId);
          deps.liveCalls?.unregister(sessionId, call.realtime);
        },
      });
      calls.set(callId, call);
      deps.liveCalls?.register(sessionId, call.realtime, callers.get(callId) ?? null);
      await call.start().catch(async (error) => {
        log({ kind: "phone_start_failed", callId, sessionId, error: String(error) });
        await call.end("error");
      });
    } finally {
      connecting -= 1;
    }
  };

  const incoming = async (callId: string, headers: SipHeader[]): Promise<{ status: 200 | 500; body: Record<string, unknown> }> => {
    const { route, dialled } = routeFor(headers, settings.routes, settings.countryCode);
    // Header names (not values) show which headers the provider sends; the caller's number is masked.
    log({ kind: "phone_incoming", callId, dialled, caller: maskNumber(callerNumber(headers, settings.countryCode)), headerNames: headers.map((h) => h.name), route: route ? { number: route.number, target: route.target } : null });
    if (!route) return reject(callId, 404, "no_route");
    if (calls.size + connecting >= settings.maxCalls) return reject(callId, 486, "busy");
    const target = resolve(route.target);
    if (!target.ok) return reject(callId, target.sip, target.reason);

    let sessionId = sessions.get(callId);
    if (!sessionId) {
      // Several counterparties: a listed counterparty's number continues their open negotiation;
      // anyone else joins the mandate's group as a walk-in, within the cap.
      const caller = callerNumber(headers, settings.countryCode);
      callers.set(callId, caller);
      const entry = caller && deps.groups ? (deps.library?.counterparties(target.source.mandateId) ?? []).find((e) => e.phone && normalizeNumber(e.phone, settings.countryCode) === caller) ?? null : null;
      const existing = entry && deps.groups ? await openSessionFor(deps.groups, target.source.mandateId, entry.id) : null;
      if (existing) {
        sessionId = existing;
        log({ kind: "phone_continues", callId, sessionId });
      } else {
        const started = await startNegotiation(deps.groups ?? null, record, { mandate: target.mandate, source: target.source, entryId: entry?.id ?? null, via: "phone" });
        if (!started.ok) return reject(callId, started.error === "busy" ? 486 : started.error === "deal_concluded" ? 480 : 500, `session_failed: ${started.error}`);
        sessionId = started.sessionId;
      }
      sessions.set(callId, sessionId);
    }
    const briefing = await engine.voiceBriefing(sessionId);
    if (!briefing || briefing.status !== "active") return reject(callId, 480, "not_active");

    const accepted = await acceptWithRetry(callId, realtimeSession(deps.realtime, briefing, { noiseReduction: settings.noiseReduction }));
    if (!accepted.ok) {
      log({ kind: accepted.gone ? "phone_gone" : "phone_accept_failed", callId, sessionId, error: accepted.error });
      // If an accept went through unseen (a timeout), hanging up keeps the caller from an unsupervised voice.
      await deps.connector.hangup(callId).catch(() => undefined);
      // Acknowledged either way: a retried webhook would come after the caller stopped waiting.
      return { status: 200, body: { ok: false, error: accepted.gone ? "call_gone" : "accept_failed" } };
    }
    log({ kind: "phone_accepted", callId, sessionId, target: route.target, attempts: accepted.attempts });
    void connect(callId, sessionId);
    return { status: 200, body: { ok: true, sessionId } };
  };

  app.post(WEBHOOK_PATH, async (c) => {
    const raw = await c.req.text();
    try {
      verifyWebhook(raw, { id: c.req.header("webhook-id"), timestamp: c.req.header("webhook-timestamp"), signature: c.req.header("webhook-signature") }, settings.webhookSecret);
    } catch (error) {
      if (!(error instanceof WebhookSignatureError)) throw error;
      log({ kind: "phone_webhook_unverified", error: error.message });
      return c.json({ error: "invalid_signature" }, 400);
    }
    let event: { type?: string; data?: { call_id?: unknown; sip_headers?: unknown } };
    try {
      event = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    // Other event types (and the dashboard's empty test event) are acknowledged and ignored.
    if (event.type !== "realtime.call.incoming") return c.json({ ok: true, ignored: event.type ?? null });
    const callId = typeof event.data?.call_id === "string" && /^[\w-]{1,200}$/.test(event.data.call_id) ? event.data.call_id : null;
    if (!callId) return c.json({ ok: true, ignored: "no_call_id" });
    if (handled.has(callId)) return c.json({ ok: true, duplicate: true });
    const headers = (Array.isArray(event.data?.sip_headers) ? event.data.sip_headers : []).filter((h): h is SipHeader => typeof h?.name === "string" && typeof h?.value === "string");

    if (!inFlight.has(callId)) inFlight.set(callId, incoming(callId, headers).catch((error) => {
      log({ kind: "phone_incoming_failed", callId, error: String(error) });
      return { status: 500 as const, body: { error: "internal_error" } };
    }));
    const result = await inFlight.get(callId)!;
    inFlight.delete(callId);
    if (result.status === 200) {
      const now = Date.now();
      handled.set(callId, now);
      for (const [id, at] of handled) if (now - at > 3_600_000) handled.delete(id);
      sessions.delete(callId);
    }
    return c.json(result.body, result.status);
  });

  /** For the console and for checking the setup: what the provider and OpenAI need, and calls in progress. No secrets. */
  app.get("/api/operator/phone", (c) =>
    c.json({
      enabled: true,
      sipUri: sipUri(settings),
      webhookPath: WEBHOOK_PATH,
      routes: settings.routes.map((r) => ({ number: r.number === "*" ? "*" : `+${r.number}`, target: r.target })),
      limits: { idleSeconds: settings.idleMs / 1000, maxMinutes: settings.maxCallMs / 60_000, maxCalls: settings.maxCalls },
      calls: [...calls.values()].map((call) => ({ callId: call.callId, sessionId: call.sessionId, startedAt: call.startedAt.toISOString() })),
    }),
  );

  return {
    calls,
    endAll: async () => {
      await Promise.all([...calls.values()].map((call) => call.end("server")));
    },
  };
}

/**
 * Phone settings for the running server, or null (with the reason logged) when phone calls are off.
 * Needs OPENAI_API_KEY with realtime voice on, OPENAI_WEBHOOK_SECRET and KRITVA_PHONE_ROUTES.
 */
export function phoneFromEnv(env: NodeJS.ProcessEnv = process.env, print: (line: string) => void = console.log): { settings: PhoneSettings; connector: RealtimeConnector & RealtimeCallControl; log: (entry: Record<string, unknown>) => void } | null {
  const apiKey = env.OPENAI_API_KEY;
  const { settings, problems } = phoneSettingsFromEnv(env);
  if (!apiKey || (env.KRITVA_VOICE_MODE ?? "realtime") !== "realtime") {
    if (settings) print("Phone calls: off (they need OPENAI_API_KEY and realtime voice).");
    return null;
  }
  if (!settings) {
    const configured = Boolean(env.OPENAI_WEBHOOK_SECRET || env.KRITVA_PHONE_ROUTES);
    print(configured ? `Phone calls: off. ${problems.join(" ")}` : "Phone calls: off (see docs/Kritva_Phone_Calls.md to turn them on).");
    return null;
  }
  for (const problem of problems) print(`Phone calls: ${problem}`);
  print(`Phone calls: on. SIP URI for the trunk: ${sipUri(settings)} (TLS). OpenAI webhook: https://<public host>${WEBHOOK_PATH}`);
  return { settings, connector: new OpenAIRealtimeConnector(apiKey), log: (entry) => console.log("[phone]", JSON.stringify(entry)) };
}
