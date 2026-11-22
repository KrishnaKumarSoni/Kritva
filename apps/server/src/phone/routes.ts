/**
 * Phone calls into Kritva (docs/Kritva_Phone_Calls.md).
 *
 *   Caller → Vobiz number → Vobiz SIP trunk (TLS + SRTP) → OpenAI SIP (sip.api.openai.com, routed by location)
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
import { appendFileSync } from "node:fs";
import type { Hono } from "hono";
import type { ConfirmedMandate, DealGroups, MandateLibrary, NegotiationEngine, NegotiationRecord } from "@kritva/core";
import { openSessionFor, startNegotiation } from "../group-routes.ts";
import type { ListingConfig } from "../main-helpers.ts";
import { OpenAIRealtimeConnector, realtimeSession, RealtimeCallError, type RealtimeCall, type RealtimeCallControl, type RealtimeConnector, type RealtimeSettings } from "../realtime-voice.ts";
import { resolveListing } from "../voice-routes.ts";
import { normalizeNumber, outboundFromEnv, phoneSettingsFromEnv, sipUri, type PhoneSettings, type PhoneTarget } from "./config.ts";
import { OutboundDialer, type OutboundSettings } from "./outbound.ts";
import { PhoneCall, type EndReason } from "./phone-call.ts";
import { VobizTelephony, type OutboundTelephony } from "./vobiz.ts";
import { callerNumber, maskNumber, routeFor, type SipHeader } from "./sip-headers.ts";
import { verifyWebhook, WebhookSignatureError } from "./webhook-signature.ts";

/** The URL path to give OpenAI as the project's webhook endpoint. */
export const WEBHOOK_PATH = "/api/webhooks/openai";

/** Waits before each accept attempt; three attempts stay within the few seconds a webhook may take. */
const ACCEPT_BACKOFF_MS = [0, 300, 900];

export interface PhoneDeps {
  /** Several counterparties per saved mandate (docs/Kritva_Multiple_Counterparties.md). */
  groups?: DealGroups | null;
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
  /** Hang up live calls when the process is stopped or restarted (the running server sets it; tests do not). */
  hangUpOnExit?: boolean;
  /** Outbound calls through Vobiz (outbound.ts). Off when absent. */
  outbound?: { telephony: OutboundTelephony; settings: OutboundSettings } | null;
  /** An outbound dialer built by the host (main.ts), shared with other routes; used instead of building one from `outbound`. */
  dialer?: OutboundDialer | null;
  /** Calls connected now, with the counterparty's number while each lasts (the multiple-counterparties live-call registry). */
  liveCalls?: LiveCallRegistry | null;
}

/** What the phone routes tell the live-call registry: a call connected for a session, and when it ends. */
export interface LiveCallRegistry {
  register(sessionId: string, call: RealtimeCall, contact: string | null): void;
  unregister(sessionId: string, call: RealtimeCall): void;
}

/** The outbound dialer for the running server, built once in main.ts and passed to createApp as `dialer`. */
export function outboundDialer(phone: { outbound: PhoneDeps["outbound"]; log?: (entry: Record<string, unknown>) => void } | null, engine: NegotiationEngine): OutboundDialer | null {
  return phone?.outbound ? new OutboundDialer({ engine, telephony: phone.outbound.telephony, settings: phone.outbound.settings, log: phone.log }) : null;
}

/**
 * How a call is answered. "minimal" (the default, as in Vobiz's working sample): the accept carries
 * only the model, instructions and voice, and the full session follows as `session.update` over
 * the sideband before anything is said. A field OpenAI rejects then shows up as an `error` event in
 * the log instead of silently leaving a connected call without audio. "full" sends the whole
 * session in the accept, as OpenAI's guide shows.
 */
export function acceptPlan(full: Record<string, any>, mode: PhoneSettings["acceptMode"]): { accept: Record<string, unknown>; update: Record<string, unknown> | null } {
  if (mode === "full") return { accept: full, update: null };
  const { model, ...session } = full;
  return { accept: { type: "realtime", model, instructions: full.instructions, audio: { output: full.audio?.output } }, update: session };
}

/** Declares the call's audio codec for both directions of a session. */
function withCodec(session: Record<string, any>, type: string) {
  session.audio = { ...session.audio, input: { ...session.audio?.input, format: { type } }, output: { ...session.audio?.output, format: { type } } };
}

/** SIP header values for a trace, with every phone number masked. */
const maskedHeaders = (headers: SipHeader[]) => headers.map((h) => `${h.name}: ${h.value.replace(/\+?\d{10,15}/g, (n) => maskNumber(n.replace(/\D/g, "")) ?? "")}`.slice(0, 300));

/** What starting a negotiation for a call needs: the confirmed mandate and where it came from. */
type Resolved = { ok: true; mandate: ConfirmedMandate; source: { mandateId: string; revision: number } } | { ok: false; sip: number; reason: string };

/** Live phone calls by OpenAI call ID; the returned handle lets the server end them on shutdown. */
export interface PhoneHandle {
  calls: Map<string, PhoneCall>;
  endAll(): Promise<void>;
  /** Places outbound calls, or null when outbound calling is off. */
  outbound: OutboundDialer | null;
}

export function registerPhoneRoutes(app: Hono, deps: PhoneDeps): PhoneHandle {
  const { record, engine, settings } = deps;
  const log = (entry: Record<string, unknown>) => deps.log?.(entry);
  const calls = new Map<string, PhoneCall>();
  const dialer = deps.dialer ?? (deps.outbound ? new OutboundDialer({ engine, telephony: deps.outbound.telephony, settings: deps.outbound.settings, log }) : null);
  /**
   * The counterparty's number per call, in memory only while the call is set up and connected: the
   * caller for an inbound call, the dialled number for Kritva's own. Never written to the record.
   */
  const callers = new Map<string, string | null>();
  /** Kritva's outbound call → the realtime call it bridged to, while both last. */
  const bridgedTo = new Map<string, string>();
  // OpenAI did not pass on the hang-up of a bridged outbound call on the first live test, so when
  // Vobiz reports the phone leg over, Kritva ends its side too (it would otherwise run on in silence).
  dialer?.onChange((view) => {
    if (view.state !== "ended") return;
    const realtimeCallId = bridgedTo.get(view.callId);
    bridgedTo.delete(view.callId);
    if (realtimeCallId) void calls.get(realtimeCallId)?.end("hung_up");
  });
  /** Webhooks being handled, by call ID: a retry while one is in flight waits for the same result. */
  const inFlight = new Map<string, Promise<{ status: 200 | 500; body: Record<string, unknown> }>>();
  /** Calls already answered or declined (kept an hour), so a retried webhook does nothing twice. */
  const handled = new Map<string, number>();
  /** The session started for a call, reused if OpenAI retries after a failed accept. */
  const sessions = new Map<string, string>();
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
    callers.delete(callId);
    log({ kind: "phone_rejected", callId, sip, reason });
    await deps.connector.reject(callId, sip).catch((error) => log({ kind: "phone_reject_failed", callId, error: String(error) }));
    return { status: 200 as const, body: { ok: true, rejected: sip, reason } };
  };

  /** After the accept: join the call and run it. A call that cannot be joined is hung up at once. */
  const connect = async (callId: string, sessionId: string, sessionUpdate: Record<string, unknown> | null, outboundCallId: string | null) => {
    connecting += 1;
    const direction = outboundCallId ? "outbound" : "inbound";
    try {
      let link;
      try {
        link = await deps.connector.attach(callId);
      } catch (error) {
        log({ kind: "phone_attach_failed", callId, sessionId, error: String(error) });
        await deps.connector.hangup(callId).catch(() => undefined);
        await record.append(sessionId, { id: `voice_end_${callId.replace(/[^\w-]/g, "")}`.slice(0, 128), type: "voice_connection", channel: "voice", payload: { status: "ended", transport: "phone", reason: "error", direction } }, { kind: "system", partyId: null });
        if (outboundCallId) dialer?.realtimeEnded(outboundCallId, "error");
        return;
      }
      const afterSeq = (await record.context(sessionId)).events.at(-1)?.seq ?? 0;
      const onEnded = (ended: PhoneCall, reason: EndReason) => {
        calls.delete(callId);
        callers.delete(callId);
        deps.liveCalls?.unregister(sessionId, ended.realtime);
        if (outboundCallId) dialer?.realtimeEnded(outboundCallId, reason);
      };
      const call = new PhoneCall({ engine, record, sessionId, callId, link, control: deps.connector, settings, afterSeq, log, pollMs: deps.pollMs, sessionUpdate, trace: settings.trace, direction, onEnded });
      calls.set(callId, call);
      deps.liveCalls?.register(sessionId, call.realtime, callers.get(callId) ?? null);
      if (outboundCallId) {
        bridgedTo.set(outboundCallId, callId);
        dialer?.connected(outboundCallId, callId);
      }
      await call.start().catch(async (error) => {
        log({ kind: "phone_start_failed", callId, sessionId, error: String(error) });
        await call.end("error");
      });
    } finally {
      connecting -= 1;
    }
  };

  /** Answers a call into a session that already exists, then joins it. */
  const answerInto = async (callId: string, sessionId: string, outboundCallId: string | null, target: unknown): Promise<{ status: 200 | 500; body: Record<string, unknown> }> => {
    const briefing = await engine.voiceBriefing(sessionId);
    if (!briefing || briefing.status !== "active") return reject(callId, 480, "not_active");
    const plan = acceptPlan(realtimeSession(deps.realtime, briefing, { noiseReduction: settings.noiseReduction }), settings.acceptMode);
    // Kritva's own calls arrive as G.711 mu-law from Vobiz: declare it, so OpenAI decodes and plays the call's audio.
    if (outboundCallId && settings.outboundCodec) withCodec(plan.update ?? plan.accept, `audio/${settings.outboundCodec}`);
    const accepted = await acceptWithRetry(callId, plan.accept);
    if (!accepted.ok) {
      log({ kind: accepted.gone ? "phone_gone" : "phone_accept_failed", callId, sessionId, error: accepted.error });
      // If an accept went through unseen (a timeout), hanging up keeps the caller from an unsupervised voice.
      await deps.connector.hangup(callId).catch(() => undefined);
      callers.delete(callId);
      if (outboundCallId) dialer?.realtimeEnded(outboundCallId, "error");
      // Acknowledged either way: a retried webhook would come after the caller stopped waiting.
      return { status: 200, body: { ok: false, error: accepted.gone ? "call_gone" : "accept_failed" } };
    }
    log({ kind: "phone_accepted", callId, sessionId, target, outboundCallId, attempts: accepted.attempts, acceptMode: settings.acceptMode });
    void connect(callId, sessionId, plan.update, outboundCallId);
    return { status: 200, body: { ok: true, sessionId } };
  };

  const incoming = async (callId: string, headers: SipHeader[], mediaSecurity: unknown): Promise<{ status: 200 | 500; body: Record<string, unknown> }> => {
    if (settings.trace) log({ kind: "phone_trace_headers", callId, headers: maskedHeaders(headers) });
    // Kritva's own outbound call, bridged to OpenAI by Vobiz once they answered: join its session.
    const outbound = dialer?.match(headers) ?? null;
    if (outbound) {
      log({ kind: "phone_outbound_bridged", callId, outboundCallId: outbound.callId, sessionId: outbound.sessionId, matchedBy: outbound.how, from: outbound.from, mediaSecurity: mediaSecurity ?? null, headerNames: headers.map((h) => h.name) });
      callers.set(callId, dialer?.dialledNumber(outbound.callId) ?? null);
      return answerInto(callId, outbound.sessionId, outbound.callId, { kind: "outbound" });
    }
    callers.set(callId, callerNumber(headers, settings.countryCode));
    const { route, dialled } = routeFor(headers, settings.routes, settings.countryCode);
    // Header names (not values) show which headers the provider sends; the caller's number is masked.
    log({ kind: "phone_incoming", callId, dialled, caller: maskNumber(callerNumber(headers, settings.countryCode)), mediaSecurity: mediaSecurity ?? null, headerNames: headers.map((h) => h.name), route: route ? { number: route.number, target: route.target } : null });
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
    return answerInto(callId, sessionId, null, route.target);
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
    let event: { type?: string; data?: { call_id?: unknown; sip_headers?: unknown; sip_media_security?: unknown } };
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

    if (!inFlight.has(callId)) inFlight.set(callId, incoming(callId, headers, event.data?.sip_media_security).catch((error) => {
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

  if (dialer) {
    // ---------- Vobiz callbacks for outbound calls ----------
    // Public routes: the per-call token in the path is unguessable (18 random bytes) and is the
    // authorisation. Vobiz posts form fields or JSON; both are read.
    const fields = async (c: { req: { header(name: string): string | undefined; parseBody(): Promise<Record<string, unknown>>; json(): Promise<unknown> } }) => {
      try {
        return (c.req.header("content-type") ?? "").includes("json") ? ((await c.req.json()) as Record<string, unknown>) : await c.req.parseBody();
      } catch {
        return {} as Record<string, unknown>;
      }
    };
    const hangupXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>`;
    app.post("/api/phone/vobiz/:token/answer", async (c) => {
      const xml = await dialer.answered(c.req.param("token"));
      return c.body(xml ?? hangupXml, 200, { "Content-Type": "application/xml" });
    });
    app.post("/api/phone/vobiz/:token/ring", (c) => c.json({ ok: dialer.ringing(c.req.param("token")) }));
    app.post("/api/phone/vobiz/:token/hangup", async (c) => {
      const f = await fields(c);
      const cause = [f.HangupCauseName, f.HangupCause, f.hangup_cause_name, f.DialHangupCause, f.CallStatus].find((v): v is string => typeof v === "string" && v.length > 0) ?? null;
      return c.json({ ok: dialer.hungUp(c.req.param("token"), cause) });
    });

    // ---------- Operator: place and follow outbound calls ----------
    app.post("/api/operator/sessions/:id/calls", async (c) => {
      const body = await c.req.json<{ to?: string; clientRequestId?: string }>().catch(() => ({}) as { to?: string; clientRequestId?: string });
      const clientRequestId = typeof body.clientRequestId === "string" && /^[\w-]{8,100}$/.test(body.clientRequestId) ? body.clientRequestId : null;
      const result = await dialer.call({ sessionId: c.req.param("id"), to: String(body.to ?? ""), clientRequestId });
      if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "invalid_number" ? 400 : result.code === "provider_error" ? 502 : 409);
      return c.json(result.call, 202);
    });
    app.get("/api/operator/sessions/:id/calls", (c) => c.json(dialer.listForSession(c.req.param("id"))));
    app.get("/api/operator/calls/:callId", (c) => {
      const call = dialer.get(c.req.param("callId"));
      return call ? c.json(call) : c.json({ error: "not_found" }, 404);
    });
    app.post("/api/operator/calls/:callId/hangup", async (c) => {
      const ended = await dialer.hangup(c.req.param("callId"));
      return ended ? c.json(dialer.get(c.req.param("callId"))) : c.json({ error: "not_active", message: "That call isn't in progress." }, 409);
    });
  }

  /** For the console and for checking the setup: what the provider and OpenAI need, and calls in progress. No secrets. */
  app.get("/api/operator/phone", (c) =>
    c.json({
      enabled: true,
      sipUri: sipUri(settings),
      webhookPath: WEBHOOK_PATH,
      routes: settings.routes.map((r) => ({ number: r.number === "*" ? "*" : `+${r.number}`, target: r.target })),
      limits: { idleSeconds: settings.idleMs / 1000, maxMinutes: settings.maxCallMs / 60_000, maxCalls: settings.maxCalls },
      outbound: dialer ? { callerId: `+${dialer.settings.callerId}`, allow: dialer.settings.allow.map((n) => (n === "*" ? "*" : maskNumber(n))) } : null,
      calls: [...calls.values()].map((call) => ({ callId: call.callId, sessionId: call.sessionId, startedAt: call.startedAt.toISOString() })),
    }),
  );

  const endAll = async () => {
    await Promise.all([...calls.values()].map((call) => call.end("server")));
  };

  if (deps.hangUpOnExit) {
    // A stopped or restarted server (node --watch restarts on every saved file) would otherwise
    // leave its calls connected to a voice nobody supervises. Hang them up first, for at most 3 s.
    const stop = (signal: NodeJS.Signals) => {
      if (calls.size === 0) process.exit(0);
      log({ kind: "phone_shutdown", signal, calls: calls.size });
      void Promise.race([endAll(), new Promise((r) => setTimeout(r, 3_000))]).finally(() => process.exit(0));
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }

  return { calls, endAll, outbound: dialer };
}

/**
 * Phone settings for the running server, or null (with the reason logged) when phone calls are off.
 * Needs OPENAI_API_KEY with realtime voice on, OPENAI_WEBHOOK_SECRET and KRITVA_PHONE_ROUTES.
 */
export function phoneFromEnv(env: NodeJS.ProcessEnv = process.env, print: (line: string) => void = console.log): { settings: PhoneSettings; connector: RealtimeConnector & RealtimeCallControl; log: (entry: Record<string, unknown>) => void; hangUpOnExit: boolean; outbound: { telephony: OutboundTelephony; settings: OutboundSettings } | null } | null {
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
  // KRITVA_PHONE_LOG_FILE also appends each log line to a file, so a call can be followed outside the server's console.
  const file = env.KRITVA_PHONE_LOG_FILE?.trim() || null;
  const log = (entry: Record<string, unknown>) => {
    const line = JSON.stringify(entry);
    console.log("[phone]", line);
    if (!file) return;
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch (error) {
      console.error("[phone] could not write the log file", error);
    }
  };
  // Outbound calls (Kritva dials counterparties) need Vobiz credentials, Kritva's number and a public URL.
  const out = outboundFromEnv(env, settings);
  const allowed = out.config ? (out.config.allow.includes("*") ? "any number" : `${out.config.allow.length} number(s)`) : "";
  if (out.config) print(`Outbound calls: on, from +${out.config.callerId}. ${out.config.allow.length ? `Allowed: ${allowed}.` : "No number is allowed yet (KRITVA_PHONE_OUTBOUND_ALLOW)."}`);
  else if (env.KRITVA_PHONE_CALLER_ID || env.KRITVA_PUBLIC_URL) print(`Outbound calls: off. ${out.problems.join(" ")}`);
  const outbound = out.config ? { telephony: new VobizTelephony(out.config.authId, out.config.authToken), settings: out.config } : null;
  return { settings, connector: new OpenAIRealtimeConnector(apiKey), log, hangUpOnExit: true, outbound };
}
