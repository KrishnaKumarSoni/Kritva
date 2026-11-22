/**
 * Phone calls into Kritva (docs/Kritva_Phone_Calls.md).
 *
 *   Caller → Kritva's Twilio number → POST /api/phone/twilio/voice → TwiML <Dial><Sip>
 *          → OpenAI SIP (sip.api.openai.com over TLS, with X-Kritva-Called / X-Kritva-Caller headers)
 *                                                                    │ webhook: realtime.call.incoming
 *                                                                    ▼
 *   POST /api/webhooks/openai → verify signature → route the dialled number to a listing or mandate
 *        → start a negotiation session → accept the call (same session settings as a browser call)
 *        → join over the sideband WebSocket → PhoneCall (RealtimeCall + server-side delivery)
 *
 * Audio never passes through this server: OpenAI and Twilio exchange it directly. The server only
 * answers the webhook, controls the call and handles its events, exactly as for a browser call.
 *
 * A "code" route answers with the shared line's front desk instead (front-desk.ts): the agent asks for
 * the listing code, find_listing reaches that mandate, and the call goes on there as one conversation.
 *
 * SIP replies when a call cannot be taken (the caller hears the network's tone or message):
 *   404 the number has no route · 480 the listing is paused or closed, or its mandate is missing or
 *   not live (on a "code" route: no listing is live) · 486 busy (KRITVA_PHONE_MAX_CALLS calls
 *   already) · 500 a session could not start.
 */
import { appendFileSync } from "node:fs";
import type { Hono } from "hono";
import { isListingCode, type ConfirmedMandate, type DealGroups, type MandateLibrary, type NegotiationEngine, type NegotiationRecord } from "@kritva/core";
import { openSessionFor, startNegotiation } from "../group-routes.ts";
import type { ListingConfig } from "../main-helpers.ts";
import { OpenAIRealtimeConnector, realtimeSession, RealtimeCallError, type RealtimeCall, type RealtimeCallControl, type RealtimeConnector, type RealtimeLink, type RealtimeSettings } from "../realtime-voice.ts";
import { resolveListing } from "../voice-routes.ts";
import { lineNumber, normalizeNumber, outboundFromEnv, phoneSettingsFromEnv, sipUri, twilioFromEnv, usesListingCodes, type PhoneSettings, type PhoneTarget } from "./config.ts";
import { AFTER_FRONT_DESK, FrontDesk, frontDeskInstructions, frontDeskSession, type FrontDeskTurn, type HandOver, type Lookup } from "./front-desk.ts";
import { OutboundDialer, type OutboundSettings } from "./outbound.ts";
import { PhoneCall, type EndReason } from "./phone-call.ts";
import { dialSipTwiml, FINAL_STATUSES, HANGUP_TWIML, readTwilioWebhook, TwilioTelephony, type OutboundTelephony, type TwilioWebhookAuth } from "./twilio.ts";
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
  /** Call-backs Kritva placed: an incoming call that is one of them joins its negotiation. */
  followUps?: { claim(headers: SipHeader[]): { sessionId: string } | null } | null;
  /** Hang up live calls when the process is stopped or restarted (the running server sets it; tests do not). */
  hangUpOnExit?: boolean;
  /** Outbound calls through Twilio (outbound.ts). Off when absent. */
  outbound?: { telephony: OutboundTelephony; settings: OutboundSettings } | null;
  /** Checks the signature on Twilio's webhooks (twilio.ts). Absent: not checked (tests). */
  twilio?: TwilioWebhookAuth | null;
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
 * How a call is answered. "minimal" (the default): the accept carries
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

/**
 * A pause between the accept and joining the call (so before the session.update and the greeting).
 * Answered from far away (the Mac in India: about 400 ms to session.updated), calls had audio; answered
 * from a server next to OpenAI (AWS us-west-2: about 150 ms), the same calls were silent both ways, as
 * when the whole session went in the accept. Applying the audio settings before the SIP media leg is up
 * seems to leave it silent, so the server waits. KRITVA_PHONE_SETUP_DELAY_MS, 0 to 5000, default 0.
 */
const SETUP_DELAY_MS = Math.min(5000, Math.max(0, Number(process.env.KRITVA_PHONE_SETUP_DELAY_MS ?? 0) || 0));
const setupPause = () => (SETUP_DELAY_MS ? new Promise<void>((r) => setTimeout(r, SETUP_DELAY_MS)) : Promise.resolve());

/** SIP header values for a trace, with every phone number masked. */
const maskedHeaders = (headers: SipHeader[]) => headers.map((h) => `${h.name}: ${h.value.replace(/\+?\d{10,15}/g, (n) => maskNumber(n.replace(/\D/g, "")) ?? "")}`.slice(0, 300));

/** What starting a negotiation for a call needs: the confirmed mandate and where it came from. */
type Resolved = { ok: true; mandate: ConfirmedMandate; source: { mandateId: string; revision: number } } | { ok: false; sip: number; reason: string };

/** Live phone calls by OpenAI call ID; the returned handle lets the server end them on shutdown. */
export interface PhoneHandle {
  calls: Map<string, PhoneCall>;
  /** Calls still at the front desk (no listing yet), by OpenAI call ID. */
  desks: Map<string, FrontDesk>;
  endAll(): Promise<void>;
  /** Places outbound calls, or null when outbound calling is off. */
  outbound: OutboundDialer | null;
}

export function registerPhoneRoutes(app: Hono, deps: PhoneDeps): PhoneHandle {
  const { record, engine, settings } = deps;
  const log = (entry: Record<string, unknown>) => deps.log?.(entry);
  const calls = new Map<string, PhoneCall>();
  const desks = new Map<string, FrontDesk>();
  const dialer = deps.dialer ?? (deps.outbound ? new OutboundDialer({ engine, telephony: deps.outbound.telephony, settings: deps.outbound.settings, log }) : null);
  /**
   * The counterparty's number per call, in memory only while the call is set up and connected: the
   * caller for an inbound call, the dialled number for Kritva's own. Never written to the record.
   */
  const callers = new Map<string, string | null>();
  /** Kritva's outbound call → the realtime call it bridged to, while both last. */
  const bridgedTo = new Map<string, string>();
  // When Twilio reports the phone leg of an outbound call over, Kritva ends its realtime side too, in
  // case OpenAI does not pass the hang-up on (the call would otherwise run on in silence).
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

  const resolve = (target: Exclude<PhoneTarget, { kind: "code" }>): Resolved => {
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

  type Opening = { opening: "greet" | "follow_up" | "continue"; contactNumber: string | null; seed?: HandOver["seed"] | null };

  /** After the accept: join the call and run it. A call that cannot be joined is hung up at once. */
  const connect = async (callId: string, sessionId: string, sessionUpdate: Record<string, unknown> | null, outboundCallId: string | null, how: Opening = { opening: "greet", contactNumber: null }) => {
    connecting += 1;
    const direction = outboundCallId ? "outbound" : "inbound";
    try {
      let link;
      try {
        await setupPause();
        link = await deps.connector.attach(callId);
      } catch (error) {
        log({ kind: "phone_attach_failed", callId, sessionId, error: String(error) });
        await deps.connector.hangup(callId).catch(() => undefined);
        await record.append(sessionId, { id: `voice_end_${callId.replace(/[^\w-]/g, "")}`.slice(0, 128), type: "voice_connection", channel: "voice", payload: { status: "ended", transport: "phone", reason: "error", direction } }, { kind: "system", partyId: null });
        if (outboundCallId) dialer?.realtimeEnded(outboundCallId, "error");
        return;
      }
      await run(callId, sessionId, link, sessionUpdate, outboundCallId, how);
    } finally {
      connecting -= 1;
    }
  };

  /** Runs a joined call as a negotiation call (PhoneCall), from a greeting, a follow-up or the front desk's hand-over. */
  const run = async (callId: string, sessionId: string, link: RealtimeLink, sessionUpdate: Record<string, unknown> | null, outboundCallId: string | null, how: Opening): Promise<PhoneCall> => {
    const direction = outboundCallId ? "outbound" : "inbound";
    const afterSeq = (await record.context(sessionId)).events.at(-1)?.seq ?? 0;
    const onEnded = (ended: PhoneCall, reason: EndReason) => {
      calls.delete(callId);
      callers.delete(callId);
      deps.liveCalls?.unregister(sessionId, ended.realtime);
      if (outboundCallId) dialer?.realtimeEnded(outboundCallId, reason);
    };
    const call = new PhoneCall({ engine, record, sessionId, callId, link, control: deps.connector, settings, afterSeq, log, pollMs: deps.pollMs, sessionUpdate, trace: settings.trace, direction, onEnded, opening: how.opening, seed: how.seed ?? null, contactNumber: how.contactNumber });
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
    return call;
  };

  /** Answers a call into a session that already exists, then joins it. */
  const answerInto = async (callId: string, sessionId: string, outboundCallId: string | null, target: unknown, continuing = false): Promise<{ status: 200 | 500; body: Record<string, unknown> }> => {
    const briefing = await engine.voiceBriefing(sessionId);
    // A listed counterparty calling back while their offer waits for the principal (or the negotiation is
    // paused) is let in: every turn then goes to the engine, which tells them where it stands.
    const waiting = continuing && (briefing?.status === "awaiting_approval" || briefing?.status === "paused");
    if (!briefing || (briefing.status !== "active" && !waiting)) return reject(callId, 480, "not_active");
    const plan = acceptPlan(realtimeSession(deps.realtime, briefing, { noiseReduction: settings.noiseReduction }), settings.acceptMode);
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
    void connect(callId, sessionId, plan.update, outboundCallId, { opening: "greet", contactNumber: callers.get(callId) ?? null });
    return { status: 200, body: { ok: true, sessionId } };
  };

  /** A call-back after the principal decided (follow-up.ts): it continues its own negotiation and opens with the decision. */
  const followUp = async (callId: string, sessionId: string): Promise<{ status: 200 | 500; body: Record<string, unknown> }> => {
    log({ kind: "phone_follow_up", callId, sessionId });
    const briefing = await engine.voiceBriefing(sessionId);
    if (!briefing) return reject(callId, 404, "follow_up_session_missing");
    const plan = acceptPlan(realtimeSession(deps.realtime, briefing, { noiseReduction: settings.noiseReduction }), settings.acceptMode);
    const accepted = await acceptWithRetry(callId, plan.accept);
    if (!accepted.ok) {
      log({ kind: "phone_accept_failed", callId, sessionId, error: accepted.error });
      await deps.connector.hangup(callId).catch(() => undefined);
      return { status: 200, body: { ok: false, error: "accept_failed" } };
    }
    void connect(callId, sessionId, plan.update, null, { opening: "follow_up", contactNumber: null });
    return { status: 200, body: { ok: true, sessionId, followUp: true } };
  };

  const incoming = async (callId: string, headers: SipHeader[], mediaSecurity: unknown): Promise<{ status: 200 | 500; body: Record<string, unknown> }> => {
    if (settings.trace) log({ kind: "phone_trace_headers", callId, headers: maskedHeaders(headers) });
    // Kritva's own outbound call, handed to OpenAI by Twilio once they answered: join its session.
    const outbound = dialer?.match(headers) ?? null;
    if (outbound) {
      log({ kind: "phone_outbound_bridged", callId, outboundCallId: outbound.callId, sessionId: outbound.sessionId, matchedBy: outbound.how, from: outbound.from, mediaSecurity: mediaSecurity ?? null, headerNames: headers.map((h) => h.name) });
      callers.set(callId, dialer?.dialledNumber(outbound.callId) ?? null);
      return answerInto(callId, outbound.sessionId, outbound.callId, { kind: "outbound" });
    }
    // A call-back Kritva placed after the principal decided: it joins its own negotiation.
    const placed = deps.followUps?.claim(headers) ?? null;
    if (placed) return followUp(callId, placed.sessionId);
    callers.set(callId, callerNumber(headers, settings.countryCode));
    const { route, dialled } = routeFor(headers, settings.routes, settings.countryCode);
    // Header names (not values) show which headers the provider sends; the caller's number is masked.
    log({ kind: "phone_incoming", callId, dialled, caller: maskNumber(callerNumber(headers, settings.countryCode)), mediaSecurity: mediaSecurity ?? null, headerNames: headers.map((h) => h.name), route: route ? { number: route.number, target: route.target } : null });
    if (!route) return reject(callId, 404, "no_route");
    if (calls.size + desks.size + connecting >= settings.maxCalls) return reject(callId, 486, "busy");
    if (route.target.kind === "code") return frontDesk(callId, headers);
    const target = resolve(route.target);
    if (!target.ok) return reject(callId, target.sip, target.reason);
    const opened = await sessionFor(callId, headers, target);
    if (!opened.ok) return reject(callId, opened.sip, opened.reason);
    return answerInto(callId, opened.sessionId, null, route.target, opened.continuing);
  };

  /**
   * The negotiation a call joins (started once per call, reused if OpenAI retries the webhook).
   * Several counterparties: a listed counterparty's number continues their open negotiation; anyone
   * else joins the mandate's group as a walk-in, within the cap.
   */
  const sessionFor = async (callId: string, headers: SipHeader[], target: Extract<Resolved, { ok: true }>): Promise<{ ok: true; sessionId: string; continuing: boolean } | { ok: false; sip: number; reason: string; error: string }> => {
    const known = sessions.get(callId);
    if (known) return { ok: true, sessionId: known, continuing: false };
    const caller = callerNumber(headers, settings.countryCode);
    callers.set(callId, caller);
    const entry = caller && deps.groups ? (deps.library?.counterparties(target.source.mandateId) ?? []).find((e) => e.phone && normalizeNumber(e.phone, settings.countryCode) === caller) ?? null : null;
    const existing = entry && deps.groups ? await openSessionFor(deps.groups, target.source.mandateId, entry.id) : null;
    if (existing) {
      sessions.set(callId, existing);
      log({ kind: "phone_continues", callId, sessionId: existing });
      return { ok: true, sessionId: existing, continuing: true };
    }
    const started = await startNegotiation(deps.groups ?? null, record, { mandate: target.mandate, source: target.source, entryId: entry?.id ?? null, via: "phone" });
    if (!started.ok) return { ok: false, sip: started.error === "busy" ? 486 : started.error === "deal_concluded" ? 480 : 500, reason: `session_failed: ${started.error}`, error: started.error };
    sessions.set(callId, started.sessionId);
    return { ok: true, sessionId: started.sessionId, continuing: false };
  };

  // ---------- The shared line's front desk (listing codes) ----------

  /** Public names the line may say it answers for: the configured ones and the demo listings' own. */
  const answersFor = () => [...new Set([...(settings.answersFor ?? []), ...deps.listings.flatMap((l) => (l.publicPrincipalName?.trim() ? [l.publicPrincipalName.trim()] : []))])];

  /** Answers a call on a "code" route: no negotiation yet, the agent asks for the listing code. */
  const frontDesk = async (callId: string, headers: SipHeader[]): Promise<{ status: 200 | 500; body: Record<string, unknown> }> => {
    const live = deps.library?.list().filter((m) => m.state === "live" && m.listingCode) ?? [];
    if (live.length === 0) return reject(callId, 480, "no_live_listings");
    const line = { answersFor: answersFor() };
    const plan = acceptPlan(frontDeskSession(deps.realtime, line, { noiseReduction: settings.noiseReduction }), settings.acceptMode);
    const accepted = await acceptWithRetry(callId, plan.accept);
    if (!accepted.ok) {
      log({ kind: accepted.gone ? "phone_gone" : "phone_accept_failed", callId, frontDesk: true, error: accepted.error });
      await deps.connector.hangup(callId).catch(() => undefined);
      callers.delete(callId);
      return { status: 200, body: { ok: false, error: accepted.gone ? "call_gone" : "accept_failed" } };
    }
    log({ kind: "phone_accepted", callId, frontDesk: true, attempts: accepted.attempts, acceptMode: settings.acceptMode, liveListings: live.length });
    void openFrontDesk(callId, headers, plan.update, frontDeskInstructions(line));
    return { status: 200, body: { ok: true, frontDesk: true } };
  };

  const openFrontDesk = async (callId: string, headers: SipHeader[], sessionUpdate: Record<string, unknown> | null, instructions: string) => {
    connecting += 1;
    try {
      let link: RealtimeLink;
      try {
        await setupPause();
        link = await deps.connector.attach(callId);
      } catch (error) {
        log({ kind: "phone_attach_failed", callId, frontDesk: true, error: String(error) });
        await deps.connector.hangup(callId).catch(() => undefined);
        callers.delete(callId);
        return;
      }
      const desk: FrontDesk = new FrontDesk({
        callId,
        link,
        control: deps.connector,
        instructions,
        sessionUpdate,
        settings,
        log,
        trace: settings.trace,
        lookup: (digits) => lookupListing(callId, headers, digits),
        handOver: (h) => handOver(callId, link, desk, h),
        onEnded: () => {
          desks.delete(callId);
          callers.delete(callId);
          sessions.delete(callId);
        },
      });
      desks.set(callId, desk);
      desk.start();
    } finally {
      connecting -= 1;
    }
  };

  /** find_listing: the code's check digit, its mandate, and a negotiation to join. Only exact matches count. */
  const lookupListing = async (callId: string, headers: SipHeader[], digits: string): Promise<Lookup> => {
    if (digits.length !== 4) return { found: false, reason: "wrong_length" };
    if (!isListingCode(digits)) return { found: false, reason: "check_failed" };
    const mandateId = deps.library?.findByListingCode(digits) ?? null;
    if (!mandateId) return { found: false, reason: "not_found" };
    const target = resolve({ kind: "mandate", mandateId });
    if (!target.ok) return { found: false, reason: target.reason === "mandate_paused" ? "paused" : target.reason === "mandate_closed" ? "closed" : target.reason === "mandate_not_found" ? "not_found" : "unavailable" };
    // Each code is looked up afresh: a session kept for webhook retries never carries over to another code.
    sessions.delete(callId);
    const opened = await sessionFor(callId, headers, target);
    sessions.delete(callId);
    if (!opened.ok) return { found: false, reason: opened.error === "busy" ? "busy" : opened.error === "deal_concluded" ? "closed" : "unavailable" };
    const briefing = await engine.voiceBriefing(opened.sessionId);
    const waiting = opened.continuing && (briefing?.status === "awaiting_approval" || briefing?.status === "paused");
    if (!briefing || (briefing.status !== "active" && !waiting)) return { found: false, reason: "unavailable" };
    log({ kind: "phone_listing_found", callId, sessionId: opened.sessionId, mandateId, continuing: opened.continuing });
    return { found: true, sessionId: opened.sessionId, listing: { what: briefing.subject, for: briefing.principalName ?? `the ${briefing.principalRole}`, you_speak_for: briefing.principalRole, they_are: briefing.counterpartyRole } };
  };

  /**
   * The listing was found: the same realtime session switches to the negotiation's instructions at
   * once, what was said so far goes into the negotiation's record, and PhoneCall takes the call,
   * answering the caller's last words without a new greeting.
   */
  const handOver = async (callId: string, link: RealtimeLink, desk: FrontDesk, h: HandOver) => {
    const briefing = await engine.voiceBriefing(h.sessionId);
    if (!briefing) throw new Error("The negotiation for this call is missing.");
    const { model, ...update } = realtimeSession(deps.realtime, briefing, { noiseReduction: settings.noiseReduction, callStart: AFTER_FRONT_DESK });
    link.send({ type: "session.update", session: update });
    await recordFrontDesk(h.sessionId, h.history);
    desks.delete(callId);
    log({ kind: "phone_handed_over", callId, sessionId: h.sessionId, turns: h.history.length });
    const call = await run(callId, h.sessionId, link, null, null, { opening: "continue", seed: h.seed, contactNumber: callers.get(callId) ?? null });
    // The caller hung up while the call was being handed over.
    if (desk.lineClosed) await call.end("hung_up");
  };

  /** The front desk's conversation, recorded as voice turns of the negotiation so the engine sees the whole call. */
  const recordFrontDesk = async (sessionId: string, history: FrontDeskTurn[]) => {
    const heard: string[] = [];
    let heardItem: string | null = null;
    for (const turn of history) {
      if (turn.role === "caller") {
        heard.push(turn.text);
        heardItem ??= turn.itemId;
        continue;
      }
      const recorded = heard.length
        ? await engine.recordVoiceAnswer({ sessionId, buyerText: heard.join(" "), replyText: turn.text, messageId: `msg_fd_${(heardItem ?? crypto.randomUUID()).replace(/[^\w-]/g, "").slice(0, 90)}`, utteranceId: heardItem })
        : await engine.recordVoiceLine({ sessionId, text: turn.text, reason: "Answered the shared phone line before the listing was known." });
      if (!recorded.ok) log({ kind: "front_desk_not_recorded", sessionId, code: recorded.code });
      heard.length = 0;
      heardItem = null;
    }
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

  // ---------- Twilio: Kritva's number (inbound) ----------
  // The number's Voice URL (A call comes in → Webhook, HTTP POST). Every Twilio webhook is signed; a
  // request whose signature does not match is refused, and the URL it was checked against is logged.
  const twiml = (c: { body(data: string, status: 200 | 403, headers: Record<string, string>): Response }, body: string, status: 200 | 403 = 200) => c.body(body, status, { "Content-Type": "text/xml" });
  app.post("/api/phone/twilio/voice", async (c) => {
    const hook = await readTwilioWebhook(c, deps.twilio ?? null);
    if (!hook.ok) {
      log({ kind: "twilio_signature_mismatch", route: "voice", url: hook.url });
      return twiml(c, HANGUP_TWIML, 403);
    }
    const p = hook.params;
    const called = normalizeNumber(p.To ?? p.Called ?? "", settings.countryCode);
    const caller = normalizeNumber(p.From ?? p.Caller ?? "", settings.countryCode);
    log({ kind: "twilio_incoming", providerCallId: p.CallSid ?? null, called: /^\d{6,15}$/.test(called) ? called : null, caller: maskNumber(/^\d{6,15}$/.test(caller) ? caller : null) });
    // The dialled number routes the call (sip-headers.ts reads X-Kritva-Called); the caller's number
    // stays in memory for the live-call registry, never in the record.
    return twiml(c, dialSipTwiml({ sipUri: sipUri(settings), headers: { "X-Kritva-Called": /^\d{6,15}$/.test(called) ? called : null, "X-Kritva-Caller": /^\d{6,15}$/.test(caller) ? caller : null }, timeLimitSeconds: settings.maxCallMs / 1000 + 60, answerOnBridge: true }));
  });

  if (dialer) {
    // ---------- Twilio callbacks for outbound calls ----------
    // Signed by Twilio, and tied to a call by the per-call token in the path (18 random bytes).
    app.post("/api/phone/twilio/call/:token/answer", async (c) => {
      const hook = await readTwilioWebhook(c, deps.twilio ?? null);
      if (!hook.ok) {
        log({ kind: "twilio_signature_mismatch", route: "answer", url: hook.url });
        return twiml(c, HANGUP_TWIML, 403);
      }
      return twiml(c, (await dialer.answered(c.req.param("token"))) ?? HANGUP_TWIML);
    });
    app.post("/api/phone/twilio/call/:token/status", async (c) => {
      const hook = await readTwilioWebhook(c, deps.twilio ?? null);
      if (!hook.ok) {
        log({ kind: "twilio_signature_mismatch", route: "status", url: hook.url });
        return c.json({ error: "bad_signature" }, 403);
      }
      const status = (hook.params.CallStatus ?? "").toLowerCase();
      const token = c.req.param("token");
      if (status === "ringing") return c.json({ ok: dialer.ringing(token) });
      if (FINAL_STATUSES.has(status)) return c.json({ ok: dialer.hungUp(token, status) });
      return c.json({ ok: true });
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
      // The shared line, for showing next to a listing code.
      line: { number: lineNumber(settings), listingCodes: usesListingCodes(settings) },
      limits: { idleSeconds: settings.idleMs / 1000, maxMinutes: settings.maxCallMs / 60_000, maxCalls: settings.maxCalls },
      outbound: dialer ? { callerId: `+${dialer.settings.callerId}`, allow: dialer.settings.allow.map((n) => (n === "*" ? "*" : maskNumber(n))) } : null,
      calls: [...calls.values()].map((call) => ({ callId: call.callId, sessionId: call.sessionId, startedAt: call.startedAt.toISOString() })),
      frontDesk: [...desks.values()].map((desk) => ({ callId: desk.callId, startedAt: desk.startedAt.toISOString() })),
    }),
  );

  const endAll = async () => {
    await Promise.all([...calls.values()].map((call) => call.end("server")).concat([...desks.values()].map((desk) => desk.end("server"))));
  };

  if (deps.hangUpOnExit) {
    // A stopped or restarted server (node --watch restarts on every saved file) would otherwise
    // leave its calls connected to a voice nobody supervises. Hang them up first, for at most 3 s.
    const stop = (signal: NodeJS.Signals) => {
      if (calls.size + desks.size === 0) process.exit(0);
      log({ kind: "phone_shutdown", signal, calls: calls.size + desks.size });
      void Promise.race([endAll(), new Promise((r) => setTimeout(r, 3_000))]).finally(() => process.exit(0));
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }

  return { calls, desks, endAll, outbound: dialer };
}

/**
 * Phone settings for the running server, or null (with the reason logged) when phone calls are off.
 * Needs OPENAI_API_KEY with realtime voice on, OPENAI_WEBHOOK_SECRET and KRITVA_PHONE_ROUTES.
 */
export function phoneFromEnv(env: NodeJS.ProcessEnv = process.env, print: (line: string) => void = console.log): { settings: PhoneSettings; connector: RealtimeConnector & RealtimeCallControl; log: (entry: Record<string, unknown>) => void; hangUpOnExit: boolean; outbound: { telephony: OutboundTelephony; settings: OutboundSettings } | null; twilio: TwilioWebhookAuth | null } | null {
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
  print(`Phone calls: on. OpenAI SIP URI: ${sipUri(settings)}. OpenAI webhook: https://<public host>${WEBHOOK_PATH}`);
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
  // Twilio's webhooks are checked with the account's auth token against the public URL Twilio calls.
  const twilio = twilioFromEnv(env);
  const publicUrl = env.KRITVA_PUBLIC_URL?.trim().replace(/\/+$/, "") || null;
  const verify = env.TWILIO_VERIFY_SIGNATURE !== "off";
  const twilioAuth = twilio && publicUrl && verify ? { authToken: twilio.authToken, publicUrl } : null;
  print(twilioAuth ? `Twilio: number Voice URL ${publicUrl}/api/phone/twilio/voice (signatures checked).` : `Twilio: webhook signatures not checked (${!verify ? "TWILIO_VERIFY_SIGNATURE=off" : "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and KRITVA_PUBLIC_URL are needed"}).`);
  // Outbound calls (Kritva dials counterparties) need Twilio credentials, Kritva's number and a public URL.
  const out = outboundFromEnv(env, settings);
  const allowed = out.config ? (out.config.allow.includes("*") ? "any number" : `${out.config.allow.length} number(s)`) : "";
  if (out.config) print(`Outbound calls: on, from +${out.config.callerId}. ${out.config.allow.length ? `Allowed: ${allowed}.` : "No number is allowed yet (KRITVA_PHONE_OUTBOUND_ALLOW)."}`);
  else if (env.KRITVA_PHONE_CALLER_ID || env.KRITVA_PUBLIC_URL) print(`Outbound calls: off. ${out.problems.join(" ")}`);
  const outbound = out.config ? { telephony: new TwilioTelephony({ accountSid: out.config.accountSid, authToken: out.config.authToken }), settings: out.config } : null;
  return { settings, connector: new OpenAIRealtimeConnector(apiKey), log, hangUpOnExit: true, outbound, twilio: twilioAuth };
}
