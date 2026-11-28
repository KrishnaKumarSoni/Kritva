/**
 * HTTP API for the thin end-to-end slice.
 *
 * The route decides who is acting, never the request body:
 * - /api/buyer/...    counterparty actions and the counterparty's view (public events only)
 * - /api/operator/... the principal's console: full record, approvals, new sessions
 * The buyer chat and the scenario script call the same engine path.
 */
import { Hono } from "hono";
import { registerAuthRoutes, signedIn, type AuthSettings, type AuthStore } from "./auth.ts";
import { registerIntakeRoutes } from "./intake-routes.ts";
import { registerLibraryRoutes, type LibraryDeps } from "./library-routes.ts";
import type { ListingConfig } from "./main-helpers.ts";
import { registerVoiceRoutes } from "./voice-routes.ts";
import { registerRealtimeRoutes, realtimeSettingsFromEnv, type RealtimeCallControl, type RealtimeConnector, type RealtimeSettings } from "./realtime-voice.ts";
import type { PhoneSettings } from "./phone/config.ts";
import { registerPhoneRoutes, type LiveCallRegistry, type PhoneDeps } from "./phone/routes.ts";
import { isTwilioRecordingUrl, TwilioTelephony, type TwilioCredentials, type TwilioWebhookAuth } from "./phone/twilio.ts";
import type { OutboundDialer } from "./phone/outbound.ts";
import type { FollowUpCalls } from "./phone/follow-up.ts";
import { maskNumber } from "./phone/sip-headers.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Value as TermValue } from "@kritva/core";
import {
  formatValue,
  negotiationInsights,
  projectAllowance,
  orderTerms,
  numericValue,
  projectCounterparty,
  projectCommitments,
  noAgreementSummary,
  type CommitmentsModel,
  type SessionContext,
  type CounterpartyModel,
  type DraftView,
  type MandateRevisions,
  type MandateLibrary,
  type IntakeService,
  type SpeechProvider,
  type Value,
  type ConditionRef,
  type MandateView,
  type RuleRef,
  type TermKind,
  type NegotiationEngine,
  type NegotiationRecord,
  type NegotiationState,
  type OfferTerm,
  type RecordedEvent,
  type ValidConfirmedMandate,
  type DealGroups,
} from "@kritva/core";
import { registerGroupRoutes, startNegotiation, type Dialer } from "./group-routes.ts";
import { registerNegotiationLog } from "./negotiation-log.ts";
import type { LiveCalls } from "./live-calls.ts";

/** Where browser call recordings are kept: a folder on Node, an R2 bucket on Cloudflare. `file` is a relative path such as "<session>/<rec>.webm". */
export interface RecordingStore {
  put(file: string, audio: Uint8Array, contentType: string): Promise<void>;
  get(file: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** Recordings as files under a folder. */
export function folderRecordings(dir: string): RecordingStore {
  return {
    async put(file, audio) {
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), audio);
    },
    async get(file) {
      const audio = await readFile(join(dir, file)).catch(() => null);
      return audio ? new Uint8Array(audio) : null;
    },
  };
}

export interface MandateEntry {
  id: string;
  title: string;
  description: string | null;
  mandate: ValidConfirmedMandate;
}

export interface AppDeps {
  record: NegotiationRecord;
  engine: NegotiationEngine;
  revisions: MandateRevisions;
  mandates: MandateEntry[];
  locale: string;
  /** Epic 11: the principal's saved, case-level mandates. Optional so tests and scripts can omit it. */
  library?: MandateLibrary;
  examples?: LibraryDeps["examples"];
  /** The intake agent's conversations for creating and changing saved mandates. */
  intake?: IntakeService;
  /** Epic 13: speech provider for browser voice (server-side credentials only). */
  speech?: SpeechProvider | null;
  /** Epic 14: demo listings and the library mandates their calls use. */
  listings?: ListingConfig[];
  transcriptionPrompt?: string;
  /** Realtime voice (docs/Kritva_Realtime_Voice.md). Without a connector the browser uses turn-based voice. */
  realtime?: { connector: RealtimeConnector | null; settings?: RealtimeSettings; log?: (entry: Record<string, unknown>) => void } | null;
  /** Phone calls through a SIP trunk into OpenAI (docs/Kritva_Phone_Calls.md). Off when absent. */
  phone?: { settings: PhoneSettings; connector: RealtimeConnector & RealtimeCallControl; log?: (entry: Record<string, unknown>) => void; pollMs?: number; acceptBackoffMs?: number[]; hangUpOnExit?: boolean; outbound?: PhoneDeps["outbound"]; twilio?: TwilioWebhookAuth | null } | null;
  /** Call-backs after the principal decides, through Twilio. Off when absent: follow-ups then go to the chat. */
  followUps?: FollowUpCalls | null;
  /** Where browser call recordings are kept (a folder). Off when absent, unless `recordings` is given. */
  recordingsDir?: string | null;
  /** Where browser call recordings are kept, when not a folder (R2 on Cloudflare). Wins over recordingsDir. */
  recordings?: RecordingStore | null;
  /** Twilio credentials, to play a call-back's recording through the console. */
  twilio?: TwilioCredentials | null;
  /** Kritva's outbound dialer (phone/outbound.ts), built in main.ts with outboundDialer() and shared by the phone routes and the counterparties' board. */
  dialer?: OutboundDialer | null;
  /** Voice calls connected now (browser and phone), with the counterparty's number while each lasts; the engine's break-in uses it too. */
  liveCalls?: (LiveCallRegistry & Partial<Pick<LiveCalls, "sessions">>) | null;
  /** The access key for scripts and tools (Authorization: Bearer ...). In-process tools can call the app as the operator. */
  operatorKey?: string;
  /** Signing in with an emailed link (auth.ts). The console's way in; required by the network server. */
  auth?: { store: AuthStore; settings: AuthSettings; log?: (entry: Record<string, unknown>) => void } | null;
  /** Several counterparties per saved mandate (docs/Kritva_Multiple_Counterparties.md). Off when absent. */
  groups?: DealGroups | null;
  /** Whether the deal board may place calls (KRITVA_BOARD_CALLS=on). Off by default. */
  boardCalls?: boolean;
}

export function createApp(deps: AppDeps): Hono {
  const { record, engine, mandates, locale, revisions } = deps;
  const app = new Hono();
  const recordings = deps.recordings ?? (deps.recordingsDir ? folderRecordings(deps.recordingsDir) : null);

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "internal_error", message: "Something went wrong. Nothing further was recorded." }, 500);
  });

  // The deployed commit (KRITVA_COMMIT, set by scripts/deploy-cloudflare.sh), so what is live can be checked.
  app.get("/api/health", (c) => c.json({ ok: true, commit: process.env.KRITVA_COMMIT ?? null }));

  // ---------- Operator (principal) ----------

  // The console is for the signed-in principal (an emailed sign-in link, auth.ts). Scripts and tools
  // may still use the access key (Authorization: Bearer ...).
  if (deps.auth) registerAuthRoutes(app, { store: deps.auth.store, settings: deps.auth.settings, operatorKey: deps.operatorKey, log: deps.auth.log });
  if (deps.operatorKey || deps.auth) {
    app.use("/api/operator/*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      if (!signedIn(c, { store: deps.auth?.store ?? null, operatorKey: deps.operatorKey })) {
        return c.json({ error: "signed_out", message: "Sign in to open the console." }, 401);
      }
      await next();
    });
  }

  if (deps.library) registerLibraryRoutes(app, { library: deps.library, record, engine, locale, examples: deps.examples ?? [], groups: deps.groups ?? null });
  if (deps.library && deps.groups) registerGroupRoutes(app, { record, library: deps.library, groups: deps.groups, locale, liveCalls: deps.liveCalls?.sessions ? () => deps.liveCalls!.sessions!() : undefined, dialer: deps.dialer ?? null, boardCalls: deps.boardCalls === true, endSession: (sessionId) => engine.endNegotiation({ sessionId, reason: "The principal reset this mandate to start over." }) });
  if (deps.library && deps.intake) registerIntakeRoutes(app, { intake: deps.intake, library: deps.library, record, engine, locale });
  registerNegotiationLog(app, { record, library: deps.library ?? null, groups: deps.groups ?? null, mandates, liveCalls: deps.liveCalls?.sessions ? () => deps.liveCalls!.sessions!() : undefined });
  registerVoiceRoutes(app, {
    record,
    engine,
    speech: deps.speech ?? null,
    library: deps.library ?? null,
    listings: deps.listings ?? [],
    locale,
    groups: deps.groups ?? null,
    transcriptionPrompt: deps.transcriptionPrompt,
    buyerOutcome: async (id) => {
      const state = await engine.state(id);
      return buyerOutcome(state, await record.context(id), locale, engine.publicSubject(state.view));
    },
  });

  registerRealtimeRoutes(app, { record, engine, connector: deps.realtime?.connector ?? null, settings: deps.realtime?.settings ?? realtimeSettingsFromEnv(), log: deps.realtime?.log, liveCalls: deps.liveCalls ?? null });
  if (deps.phone) {
    registerPhoneRoutes(app, { record, engine, library: deps.library ?? null, groups: deps.groups ?? null, listings: deps.listings ?? [], connector: deps.phone.connector, settings: deps.phone.settings, realtime: deps.realtime?.settings ?? realtimeSettingsFromEnv(), log: deps.phone.log, pollMs: deps.phone.pollMs, acceptBackoffMs: deps.phone.acceptBackoffMs, hangUpOnExit: deps.phone.hangUpOnExit, outbound: deps.phone.outbound ?? null, twilio: deps.phone.twilio ?? null, dialer: deps.dialer ?? null, liveCalls: deps.liveCalls ?? null, followUps: deps.followUps ?? null });
  }
  deps.followUps?.register(app);

  /** A browser call's recording, uploaded by the buyer's page when the call ends. Kept for the principal. */
  app.post("/api/buyer/sessions/:id/voice/recording", async (c) => {
    const id = c.req.param("id");
    if (!recordings) return c.json({ error: "recording_off" }, 501);
    const ctx = await record.context(id).catch(() => null);
    if (!ctx?.mandate) return c.json({ error: "session_not_found" }, 404);
    // Only right after a call in this session, once per call.
    const calls = ctx.events.filter((e) => e.type === "voice_connection");
    const last = calls.at(-1);
    if (!last || Date.now() - Date.parse(last.recordedAt) > 10 * 60_000) return c.json({ error: "no_recent_call" }, 409);
    const type = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim();
    if (!/^audio\/(webm|ogg|mp4|mpeg|wav)$/.test(type)) return c.json({ error: "invalid_audio" }, 400);
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.byteLength === 0 || audio.byteLength > 40 * 1024 * 1024) return c.json({ error: "invalid_audio" }, 400);
    const callStart = [...calls].reverse().find((e) => (e.payload as { status: string }).status === "connected");
    const recId = `rec_${(callStart?.id ?? last.id).replace(/[^\w-]/g, "")}`.slice(0, 128);
    if (ctx.events.some((e) => e.id === recId)) return c.json({ ok: true, duplicate: true });
    const file = `${id.replace(/[^\w-]/g, "")}/${recId}.${type.split("/")[1]}`;
    await recordings.put(file, audio, type);
    const ms = Number(c.req.header("X-Duration-Ms"));
    const saved = await record.append(id, { id: recId, type: "recording_saved", channel: null, payload: { source: "browser", file, contentType: type, durationMs: Number.isFinite(ms) && ms >= 0 ? Math.min(Math.round(ms), 86_400_000) : null } }, { kind: "system", partyId: null });
    return saved.ok ? c.json({ ok: true }) : c.json({ error: saved.error.code }, 409);
  });

  /** Plays a recording for the principal: a stored browser recording, or a call-back's, fetched from Twilio. */
  app.get("/api/operator/sessions/:id/recordings/:recId", async (c) => {
    const state = await engine.state(c.req.param("id")).catch(() => null);
    const rec = state?.recordings.find((r) => r.id === c.req.param("recId"));
    if (!rec) return c.json({ error: "not_found" }, 404);
    if (rec.source === "browser") {
      if (!recordings || rec.file.includes("..")) return c.json({ error: "not_found" }, 404);
      const audio = await recordings.get(rec.file).catch(() => null);
      return audio ? c.body(audio, 200, { "Content-Type": rec.contentType, "Cache-Control": "no-store" }) : c.json({ error: "not_found" }, 404);
    }
    if (rec.source !== "twilio" || !isTwilioRecordingUrl(rec.file)) return c.json({ error: "not_found" }, 404);
    const audio = deps.twilio ? await new TwilioTelephony(deps.twilio).recording(rec.file) : null;
    if (!audio) return c.json({ error: "recording_unavailable", message: "The recording isn't available from the phone provider yet." }, 502);
    return c.body(audio.audio, 200, { "Content-Type": audio.contentType, "Cache-Control": "no-store" });
  });

  /** Prepared mandates from cases/, plus saved mandates with a confirmed revision. Unconfirmed drafts never appear. */
  app.get("/api/operator/mandates", (c) =>
    c.json([
      ...mandates.map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        caseId: m.mandate.caseId,
        confirmedAt: m.mandate.approval.confirmedAt,
      })),
      ...(deps.library?.list() ?? [])
        // Only live mandates start negotiations; paused, closed and draft ones stay in the library.
        .filter((m) => m.activeRevision !== null && m.state === "live")
        .map((m) => ({ id: `library:${m.mandateId}`, title: m.title, description: `Saved mandate, revision ${m.activeRevision}`, caseId: m.caseId, confirmedAt: deps.library!.get(m.mandateId)!.active!.confirmedAt })),
    ]),
  );

  app.get("/api/operator/sessions", async (c) => c.json(await record.listSessions()));

  /** Starts a session. With previousSessionId it is a reset: a new session, the old one kept. */
  app.post("/api/operator/sessions", async (c) => {
    const body = await c.req.json<{ mandateId?: string; previousSessionId?: string | null }>().catch(() => ({}) as Record<string, never>);
    // A saved mandate starts from its active confirmed revision, and the session records which one.
    let started;
    if (typeof body.mandateId === "string" && body.mandateId.startsWith("library:")) {
      const libraryId = body.mandateId.slice("library:".length);
      const detail = deps.library?.get(libraryId) ?? null;
      const active = detail && !detail.deleted ? (deps.library?.active(libraryId) ?? null) : null;
      if (!active) return c.json({ error: "not_confirmed", message: "Make this mandate live before starting a negotiation with it." }, 409);
      if (detail!.state !== "live") return c.json({ error: "not_live", message: `This mandate is ${detail!.state}. ${detail!.state === "paused" ? "Resume" : "Reopen"} it to start a negotiation.` }, 409);
      const r = await startNegotiation(deps.groups ?? null, record, { mandate: active.mandate, source: { mandateId: libraryId, revision: active.revision }, via: "console", previousSessionId: body.previousSessionId ?? null });
      if (!r.ok) return c.json({ error: r.error, message: r.message }, r.status);
      const session = await record.getSession(r.sessionId);
      return c.json({ session, state: operatorState(await engine.state(r.sessionId), locale) }, 201);
    } else {
      const entry = body.mandateId === undefined ? mandates[0] : mandates.find((m) => m.id === body.mandateId);
      if (!entry) return c.json({ error: "no_mandate", message: "No confirmed mandate is available." }, 400);
      started = await record.startSession({ mandate: entry.mandate, previousSessionId: body.previousSessionId ?? null });
    }
    if (!started.ok) return c.json({ error: started.error.code, message: started.error.message }, 400);
    return c.json({ session: started.session, state: operatorState(await engine.state(started.session.id), locale) }, 201);
  });

  app.get("/api/operator/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const session = await record.getSession(id);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const [state, events] = await Promise.all([engine.state(id), record.read(id, { viewer: "operator" })]);
    const ctx = await record.context(id);
    const source = (ctx.events[0]?.payload as { mandateSource?: { mandateId: string; revision: number } | null } | undefined)?.mandateSource ?? null;
    const latestSource = [...ctx.events].reverse().find((e) => e.type === "mandate_revised" && (e.payload as { mandateSource?: unknown }).mandateSource)?.payload as { mandateSource: { mandateId: string; revision: number } } | undefined;
    const model = projectCounterparty(ctx, state.view.negotiable?.termId ?? null);
    const guidance = engine.guidanceFor(state.view.mandate.caseId);
    const insights = negotiationInsights(state, model, guidance, projectAllowance(ctx, state.view, guidance));
    const mandateId = source ? `library:${source.mandateId}` : (mandates.find((m) => JSON.stringify(m.mandate) === JSON.stringify(ctx.events[0]?.payload && (ctx.events[0].payload as { mandate: unknown }).mandate))?.id ?? null);
    return c.json({
      session,
      mandateId,
      mandateSource: latestSource?.mandateSource ?? source,
      state: { ...operatorState(state, locale), subject: engine.publicSubject(state.view), voiceInterrupted: voiceInterrupted(ctx.events) },
      dealSpace: dealSpaceView(state, locale),
      principal: principalView(state, locale),
      counterparty: counterpartyView(model, state, locale),
      commitments: commitmentsView(ctx, state, locale, guidance.id),
      roles: rolesOf(state.view),
      // Private numbers for the console: limit, target, the counterparty's estimated maximum, the zone and the strategy's room.
      insights: insights ? { ...insights, locale } : null,
      drafts: (await revisions.drafts(id)).map((d) => draftView(d, locale)),
      events: events.map((e) => describeEvent(e, state.view, locale)),
    });
  });

  app.post("/api/operator/sessions/:id/approvals/:requestId", async (c) => {
    const body = await c.req.json<{ decision?: string; note?: string; message?: string; counterTerms?: unknown; offerId?: string; mandateRevision?: number }>().catch(() => ({}) as Record<string, never>);
    const decision = body.decision;
    if (decision !== "approved" && decision !== "rejected" && decision !== "countered" && decision !== "declined") return c.json({ error: "invalid_decision" }, 400);
    if (typeof body.offerId !== "string" || !body.offerId || typeof body.mandateRevision !== "number" || !Number.isInteger(body.mandateRevision) || body.mandateRevision < 1) {
      return c.json({ error: "approval_version_required", message: "Review the current offer and instruction revision before deciding." }, 400);
    }
    // A counter's terms are typed values for mandate terms; the engine checks them against the mandate.
    let counterTerms: OfferTerm[] | null = null;
    if (decision === "countered") {
      const raw = Array.isArray(body.counterTerms) ? body.counterTerms.slice(0, 50) : [];
      counterTerms = [];
      for (const item of raw) {
        const termId = (item as { termId?: unknown })?.termId;
        const value = TermValue.safeParse((item as { value?: unknown })?.value);
        if (typeof termId !== "string" || !value.success) return c.json({ error: "invalid_counter", message: "Each counter term needs a term and a value." }, 400);
        counterTerms.push({ termId, value: value.data });
      }
    }
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 500) : null;
    const sessionId = c.req.param("id");
    // The decision names the offer version and mandate revision the principal reviewed; a mismatch is refused.
    const result = await engine.respondToApproval({ sessionId, requestId: c.req.param("requestId"), decision, note: body.note ?? null, message, counterTerms, expected: { offerId: body.offerId, mandateRevision: body.mandateRevision } });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "not_pending" || result.code === "reserved_elsewhere" ? 409 : 400);
    let reply = result.reply;
    let via: "text" | "voice" | "call" = result.followUp.via;
    if (via === "call" && result.followUp.phone) {
      const placed = deps.followUps ? await deps.followUps.start(sessionId, result.followUp.phone) : { ok: false };
      // Without call-backs set up (or when the call can't be placed), the follow-up goes to the chat instead.
      if (!placed.ok && !deps.followUps) {
        const sent = await engine.followUp({ sessionId, channel: "text", callBack: false });
        reply = sent.ok ? sent.reply : null;
        via = "text";
      }
    }
    return c.json({ reply, followUp: { via }, state: operatorState(await engine.state(sessionId), locale) });
  });

  /** End without agreement. Records who stopped and why; an agreement already recorded cannot be ended. */
  app.post("/api/operator/sessions/:id/end", async (c) => {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as Record<string, never>);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;
    const result = await engine.endNegotiation({ sessionId: c.req.param("id"), reason });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "not_pending" ? 409 : 400);
    return c.json({ reply: result.reply, state: operatorState(result.state, locale) });
  });

  /** Pause or resume. While paused, no negotiation content reaches the counterparty. */
  app.post("/api/operator/sessions/:id/pause", async (c) => {
    const body = await c.req.json<{ paused?: boolean }>().catch(() => ({}) as Record<string, never>);
    const result = await engine.setPaused({ sessionId: c.req.param("id"), paused: body.paused === true });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, 409);
    return c.json({ state: operatorState(result.state, locale) });
  });

  app.get("/api/operator/sessions/:id/instructions", async (c) => c.json({ instructions: await revisions.currentInstructions(c.req.param("id")) }));

  /** Maps changed instructions into a draft. The draft has no authority until confirmed. */
  app.post("/api/operator/sessions/:id/drafts", async (c) => {
    const body = await c.req.json<{ instructions?: string }>().catch(() => ({}) as Record<string, never>);
    const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
    if (instructions.length === 0 || instructions.length > 5_000) return c.json({ error: "invalid_instructions", message: "Write your instructions (up to 5,000 characters)." }, 400);
    const result = await revisions.propose({ sessionId: c.req.param("id"), instructions });
    if (!result.ok) return c.json({ error: result.error.code, message: "The instructions could not be turned into a draft. Your current mandate is unchanged." }, 422);
    return c.json({ draft: draftView(result.draft, locale) }, 201);
  });

  /** Only this principal control confirms a draft. */
  app.post("/api/operator/sessions/:id/drafts/:draftId/confirm", async (c) => {
    const body = await c.req.json<{ acknowledgedIssueIds?: string[] }>().catch(() => ({}) as Record<string, never>);
    const result = await revisions.confirm({ sessionId: c.req.param("id"), draftId: c.req.param("draftId"), acknowledgedIssueIds: Array.isArray(body.acknowledgedIssueIds) ? body.acknowledgedIssueIds : [] });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, 409);
    return c.json({ state: operatorState(result.state, locale) });
  });

  app.post("/api/operator/sessions/:id/drafts/:draftId/reject", async (c) => {
    const result = await revisions.reject({ sessionId: c.req.param("id"), draftId: c.req.param("draftId") });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, 409);
    return c.json({ ok: true });
  });

  // ---------- Buyer (counterparty) ----------

  app.get("/api/buyer/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await record.getSession(id))) return c.json({ error: "session_not_found" }, 404);
    const [state, events] = await Promise.all([engine.state(id), record.read(id, { viewer: "counterparty" })]);
    return c.json({
      // Public listing content only: the principal's public package and public facts.
      listing: { terms: termsView(state.view, state.view.defaultPackage, locale) ?? [], facts: state.view.publicFacts },
      roles: rolesOf(state.view),
      messages: buyerMessages(events),
      paused: state.status === "paused",
      outcome: buyerOutcome(state, await record.context(id), locale, engine.publicSubject(state.view)),
    });
  });

  app.post("/api/buyer/sessions/:id/messages", async (c) => {
    const body = await c.req.json<{ text?: string; clientMessageId?: string }>().catch(() => ({}) as Record<string, never>);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length === 0 || text.length > 2_000) return c.json({ error: "invalid_message", message: "Messages must be 1 to 2,000 characters." }, 400);
    const result = await engine.handleCounterpartyMessage({
      sessionId: c.req.param("id"),
      text,
      channel: "text",
      messageId: typeof body.clientMessageId === "string" && /^[\w-]{8,100}$/.test(body.clientMessageId) ? `msg_${body.clientMessageId}` : undefined,
    });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "session_not_found" ? 404 : result.code === "model_unavailable" ? 503 : 400);
    return c.json({
      reply: result.reply ? { messageId: result.reply.messageId, text: result.reply.text } : null,
      outcome: buyerOutcome(result.state, await record.context(c.req.param("id")), locale, engine.publicSubject(result.state.view)),
      timings: result.timings,
    });
  });

  /** The buyer's chat reports that a reply was displayed. Only then is its offer communicated. */
  app.post("/api/buyer/sessions/:id/deliveries", async (c) => {
    const body = await c.req.json<{ messageId?: string; channel?: string; status?: string; deliveredText?: string; audioStartMs?: number }>().catch(() => ({}) as Record<string, never>);
    if (typeof body.messageId !== "string") return c.json({ error: "invalid_delivery" }, 400);
    // Text: shown on screen. Voice: played to the end ("delivered") or cut off ("interrupted", with what was spoken).
    const channel = body.channel === "voice" ? "voice" : "text";
    if (channel === "voice" && body.status !== "interrupted" && body.status !== "delivered" && body.status !== "failed") {
      return c.json({ error: "invalid_delivery" }, 400);
    }
    const status = channel === "voice" && (body.status === "interrupted" || body.status === "failed") ? body.status : "delivered";
    const result = await engine.reportDelivery({
      sessionId: c.req.param("id"),
      messageId: body.messageId,
      channel,
      status,
      deliveredText: status === "interrupted" && typeof body.deliveredText === "string" ? body.deliveredText.slice(0, 10_000) : null,
      audioStartMs: channel === "voice" && typeof body.audioStartMs === "number" && body.audioStartMs >= 0 ? Math.round(body.audioStartMs) : null,
    });
    if ("ok" in result && result.ok === false) return c.json({ error: result.code, message: result.message }, 400);
    return c.json({ ok: true });
  });

  return app;
}

// ---------- Views ----------

const KIND_LABEL: Record<TermKind, string> = {
  range: "Negotiable range",
  options: "Options",
  fixed: "Fixed",
  restricted: "Restricted",
  stated: "Stated by you",
  linked: "Condition detail",
  descriptive: "Description",
  unresolved: "Unresolved",
};

/** Operator-only view of the deal space: term status, the rules behind it, and the latest buyer check. */
function dealSpaceView(state: NegotiationState, locale: string) {
  const space = state.space;
  const nameOf = (id: string | null) => (id ? (space.terms.find((t) => t.termId === id)?.name ?? id) : "");
  const conditionText = (c: ConditionRef) =>
    c.checkable && c.value ? `${nameOf(c.termId)} ${OPERATOR_TEXT[c.operator!]} ${formatValue(c.value, locale)}` : `${c.description} (cannot be checked automatically)`;
  const ruleText = (r: RuleRef) => {
    const value = formatValue(r.value, locale);
    const base =
      r.kind === "minimum" ? `Minimum ${value}` :
      r.kind === "maximum" ? `Maximum ${value}` :
      r.kind === "must_equal" ? `Only ${value}` :
      r.kind === "must_not_equal" ? `Not ${value}` :
      r.kind === "allowed_value" ? `Allowed: ${value}` :
      `${value}`;
    return r.conditions.length > 0 ? `${base}, only if ${r.conditions.map(conditionText).join(" and ")}` : base;
  };
  const last = state.lastCounterpartyCheck;
  return {
    terms: space.terms.map((t) => ({
      termId: t.termId,
      name: t.name,
      kind: t.kind,
      kindLabel: KIND_LABEL[t.kind],
      value: t.principalValue ? formatValue(t.principalValue.value, locale) : null,
      valueIsPrivate: t.principalValue?.disclosure === "private",
      rules: t.rules.map((r) => ({ id: r.id, text: ruleText(r), private: r.disclosure === "private", conditional: r.conditions.length > 0 })),
      inconsistent: t.inconsistent,
      openIssues: t.issueIds.length,
    })),
    facts: space.facts.map((f) => ({ id: f.id, statement: f.statement, private: f.disclosure === "private" })),
    requested: state.requestedTerms.map((r) => ({ id: r.id, name: r.name, value: r.value ? formatValue(r.value, locale) : null })),
    lastBuyerCheck: last
      ? {
          result: last.result,
          terms: last.checkedTerms.map((t) => `${nameOf(t.termId)}: ${formatValue(t.value, locale)}`),
          findings: last.findings.filter((f) => f.status !== "fits").map((f) => ({ term: f.termName, status: f.status, detail: f.detail })),
        }
      : null,
  };
}

/** One mandate rule in words, for the operator. */
function ruleText(state: NegotiationState, ruleId: string, locale: string): string {
  for (const t of state.space.terms) {
    const r = t.rules.find((x) => x.id === ruleId);
    if (!r) continue;
    const value = formatValue(r.value, locale);
    const label = r.kind === "minimum" ? `Minimum ${value}` : r.kind === "maximum" ? `Maximum ${value}` : r.kind === "must_equal" ? `Only ${value}` : r.kind === "must_not_equal" ? `Not ${value}` : `${value}`;
    return `${t.name}: ${label}`;
  }
  return ruleId;
}

const MODE_LABEL: Record<string, string> = {
  autonomous: "Kritva may do this",
  requires_approval: "Needs your approval",
  prohibited: "Not allowed",
  unresolved: "Unresolved: clarify first",
};

/** The active mandate as the principal set it: goals, targets, preferences, alternatives, limits, permissions. */
function principalView(state: NegotiationState, locale: string) {
  const m = state.view.mandate;
  const principalId = state.view.principalId;
  const nameOf = (id: string) => m.terms.find((t) => t.id === id)?.name ?? id;
  const val = (v: Value | null) => (v ? formatValue(v, locale) : "unknown");
  const mine = <T extends { partyId: string }>(xs: T[]) => xs.filter((x) => x.partyId === principalId);
  const authority = state.view.authority;
  return {
    revision: state.mandateRevision,
    goals: mine(m.goals).map((g) => ({ id: g.id, kind: g.kind, text: g.description, priority: g.priority, terms: g.termIds.map(nameOf), private: g.disclosure === "private" })),
    targets: mine(m.targets).map((t) => ({ id: t.id, text: `${nameOf(t.termId)}: ${val(t.value)}`, private: t.disclosure === "private" })),
    preferences: mine(m.preferences).map((p) => ({ id: p.id, text: `${nameOf(p.termId)}: ${val(p.value)} (${p.strength})`, private: p.disclosure === "private" })),
    alternatives: mine(m.alternatives).map((a) => ({ id: a.id, text: a.description, value: a.value ? val(a.value) : null, private: a.disclosure === "private" })),
    limits: mine(m.limits).map((l) => ({
      id: l.id,
      text: ruleText(state, l.id, locale),
      conditional: l.conditionIds.length > 0,
      exception: authority.exceptionFor(l.id) === "with_approval" ? "Exception possible with your approval" : l.exception === "not_allowed" ? "No exceptions" : "No exception path given",
    })),
    permissions: [
      ...[...new Set(m.positions.filter((p) => p.partyId === principalId).map((p) => p.termId))].map((termId) => ({ action: `Change ${nameOf(termId)}`, mode: MODE_LABEL[authority.propose(termId)] })),
      { action: "Accept an agreement", mode: MODE_LABEL[authority.accept()] },
      { action: "Disclose private details", mode: MODE_LABEL[authority.disclose(null)] },
    ],
    unresolved: [...authority.unresolvedTerms].map(([termId, reason]) => ({ term: nameOf(termId), reason })),
    issues: m.issues.map((i) => ({ id: i.id, kind: i.kind, message: i.message })),
  };
}

function draftView(d: DraftView, locale: string) {
  const m = d.draft;
  const nameOf = (id: string) => m.terms.find((t) => t.id === id)?.name ?? id;
  const val = (v: Value | null) => (v ? formatValue(v, locale) : "unknown");
  const principalId = m.parties.find((p) => p.isPrincipal)?.id;
  return {
    draftId: d.draftId,
    status: d.status,
    basedOnRevision: d.basedOnRevision,
    instructions: d.instructions,
    createdAt: d.createdAt,
    rules: [
      ...m.limits.filter((l) => l.partyId === principalId).map((l) => `${nameOf(l.termId)}: ${l.kind.replace("_", " ")} ${val(l.value)}${l.conditionIds.length ? " (conditional)" : ""}${l.exception === "with_approval" ? ", exception with your approval" : l.exception === "not_allowed" ? ", no exceptions" : ""}`),
      ...m.targets.filter((t) => t.partyId === principalId).map((t) => `Target ${nameOf(t.termId)}: ${val(t.value)}`),
      ...m.preferences.filter((p) => p.partyId === principalId).map((p) => `${p.strength === "avoid" ? "Avoid" : p.strength === "preferred" ? "Prefer" : "Acceptable"} ${nameOf(p.termId)}: ${val(p.value)}`),
      ...m.alternatives.filter((a) => a.partyId === principalId).map((a) => `If no deal: ${a.description}`),
      ...m.goals.filter((g) => g.partyId === principalId).map((g) => `${g.kind === "need" ? "Need" : g.kind === "reason" ? "Reason" : "Goal"}: ${g.description}`),
      ...m.permissions.map((p) => `${p.action.replace(/_/g, " ")}: ${p.mode.replace("_", " ")}${p.conditionIds.length ? " (conditional)" : ""}`),
    ],
    readiness: d.readiness,
    issues: m.issues.map((i) => ({ id: i.id, kind: i.kind, message: i.message })),
  };
}

/** The parties' roles in the mandate's own words ("seller" and "buyer", "shipper" and "carrier"). */
function rolesOf(view: MandateView): { principal: string; counterparty: string } {
  const counterparty = view.mandate.parties.find((p) => p.id === view.counterpartyId)?.role ?? "other party";
  return { principal: view.principalRole || "principal", counterparty };
}

/** What the counterparty said, the estimate of their limit with its basis, and open questions. */
function counterpartyView(model: CounterpartyModel, state: NegotiationState, locale: string) {
  const n = state.view.negotiable;
  const money = (amount: number | null) => (amount === null || !n ? null : formatValue(numericValue(n, amount), locale));
  const nameOf = (id: string) => state.space.terms.find((t) => t.termId === id)?.name ?? id;
  return {
    items: model.items.map((i) => ({ id: i.id, kind: i.kind, quote: i.quote, summary: i.summary, term: i.termId ? nameOf(i.termId) : null, value: i.value ? formatValue(i.value, locale) : null, condition: i.condition, basis: i.basis })),
    estimates: model.estimates.map((e) => ({
      package: e.packageTerms.map((t) => `${nameOf(t.termId)}: ${formatValue(t.value, locale)}`).join(" · ") || "Your listed terms",
      highestOffer: e.highestOffer ? money(e.highestOffer.amount) : null,
      statedBudget: e.statedMaximum?.value ? formatValue(e.statedMaximum.value, locale) : null,
      finalStatements: e.finalStatements.map((f) => f.quote),
      maximum:
        e.maximum.status === "unknown"
          ? { status: "unknown", text: `Maximum unknown. ${e.maximum.reason}` }
          : e.maximum.status === "contradicted"
            ? { status: "contradicted", text: e.maximum.reason }
            : { status: "working_estimate", text: `Working estimate (low confidence): ${e.maximum.atLeast !== null ? `at least ${money(e.maximum.atLeast)}, ` : ""}at most ${money(e.maximum.atMost)}. Assumes: ${e.maximum.assumptions.join(" ")}` },
    })),
    contradictions: model.contradictions.map((c) => c.detail),
    questions: model.questions.map((q) => ({ id: q.id, kind: q.issueKind, text: q.text, purpose: q.purpose, status: q.status })),
    failedMessages: model.failedMessages.length,
  };
}

const OPERATOR_TEXT: Record<NonNullable<ConditionRef["operator"]>, string> = {
  equals: "is",
  not_equals: "is not",
  at_least: "is at least",
  at_most: "is at most",
  includes: "includes",
};

const RESULT_LABEL = { fits: "fits known constraints", conflicts: "conflicts", needs_clarification: "needs clarification" } as const;

function buyerMessages(events: RecordedEvent[]) {
  return events
    .filter((e) => e.type === "message")
    .map((e) => {
      const p = e.payload as { direction: "inbound" | "outbound"; text: string };
      return { id: e.id, seq: e.seq, from: p.direction === "inbound" ? "buyer" : "agent", text: p.text, at: e.recordedAt, channel: e.channel };
    });
}

function termsView(view: MandateView, terms: OfferTerm[] | null, locale: string) {
  if (!terms) return null;
  return orderTerms(view, terms).map((t) => ({ termId: t.termId, name: view.terms.get(t.termId)?.name ?? t.termId, value: formatValue(t.value, locale) }));
}

/** What the buyer may see about the outcome: the kind and the stated terms. Nothing internal. */
/**
 * What the counterparty may see about the outcome: the agreed terms and what is still to happen,
 * or, without agreement, each side's last offer the counterparty already saw. Never a private limit.
 */
function buyerOutcome(state: NegotiationState, ctx: SessionContext, locale: string, subject: string | null) {
  const model = commitmentsFor(ctx, state, locale);
  const options = commitmentOptions(state, locale);
  const ended = model.outcome === "no_agreement";
  return {
    kind: state.outcome.kind,
    subject,
    terms: termsView(state.view, state.outcome.terms, locale),
    obligations: model.agreement ? model.agreement.obligations.map((o) => o.description) : [],
    noAgreement: ended ? { ...noAgreementSummary(model, options), endedBy: model.stopped?.by ?? null } : null,
  };
}

function commitmentOptions(state: NegotiationState, locale: string) {
  return {
    negotiableTermId: state.view.negotiable?.termId ?? null,
    termName: (id: string) => state.space.terms.find((t) => t.termId === id)?.name ?? id,
    format: (v: Value) => formatValue(v, locale),
  };
}

/** Commitments with each offer's terms in the listing's order, so every view reads the same way. */
function commitmentsFor(ctx: SessionContext, state: NegotiationState, locale: string): CommitmentsModel {
  const model = projectCommitments(ctx, commitmentOptions(state, locale));
  for (const o of model.offers) o.terms = orderTerms(state.view, o.terms);
  return model;
}

const STATUS_LABEL: Record<string, string> = {
  enquiry: "Enquiry",
  interest: "Interest only",
  proposed: "Open offer",
  pending_clarification: "Needs clarification",
  internal: "Internal, not sent",
  awaiting_approval: "Awaiting your approval",
  delivered: "Delivered, open",
  accepted: "Accepted",
  agreed: "Agreed",
  rejected: "Rejected",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
  corrected: "Corrected by them",
  expired: "Expired",
};

const ACTION_LABEL: Record<string, string> = {
  ask: "Ask",
  clarify: "Clarify",
  propose: "Propose terms",
  counter: "Counter",
  accept: "Accept",
  decline: "Decline",
  request_approval: "Request approval",
  pause: "Pause",
  end: "End",
  wait: "Wait",
  answer: "Answer",
};

/** Operator view of commitments: every offer version and status, the outcome, and the strategy's recorded actions. */
function commitmentsView(ctx: SessionContext, state: NegotiationState, locale: string, guidanceId: string) {
  const model = commitmentsFor(ctx, state, locale);
  const options = commitmentOptions(state, locale);
  const line = (t: OfferTerm) => `${options.termName(t.termId)}: ${formatValue(t.value, locale)}`;
  const offer = (o: CommitmentsModel["offers"][number]) => ({
    offerId: o.offerId,
    party: o.party,
    kind: o.kind,
    version: o.version,
    status: o.status,
    statusLabel: STATUS_LABEL[o.status] ?? o.status,
    blocked: o.blocked,
    approval: o.approval,
    terms: orderTerms(state.view, o.terms).map(line),
    conditions: o.conditions,
    mandateRevision: o.mandateRevision,
    at: o.at,
  });
  const decisions = ctx.events
    .filter((e) => e.type === "decision")
    .map((e) => {
      const p = e.payload as { kind: string; reason: string; action: string | null; assessment: { verdict: string; drivers: string[] } | null; mandateRevision: number | null; guidance: string | null };
      return { id: e.id, at: e.recordedAt, action: p.action, actionLabel: p.action ? (ACTION_LABEL[p.action] ?? p.action) : null, reason: p.reason, assessment: p.assessment, mandateRevision: p.mandateRevision, guidance: p.guidance };
    })
    .reverse()
    .slice(0, 30);
  return {
    guidance: guidanceId,
    outcome: model.outcome,
    stopped: model.stopped,
    currentCounterpartyOffer: model.currentCounterpartyOffer ? offer(model.currentCounterpartyOffer) : null,
    currentPrincipalOffer: model.currentPrincipalOffer ? offer(model.currentPrincipalOffer) : null,
    offers: [...model.offers].reverse().map(offer),
    agreement: model.agreement ? { terms: orderTerms(state.view, model.agreement.terms).map(line), approved: model.agreement.approvalId !== null, obligations: model.agreement.obligations.map((o) => o.description) } : null,
    noAgreement: model.outcome === "no_agreement" ? noAgreementSummary(model, options) : null,
    decisions,
  };
}

/** The last reply was cut off mid-speech and the buyer has not spoken since (a voice interruption or a dropped call). */
function voiceInterrupted(events: RecordedEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type === "voice_connection") {
      // A call ending says nothing by itself: look at the reply before it (a hang-up mid-reply reports that reply interrupted).
      if ((e.payload as { status: string }).status === "ended") continue;
      return (e.payload as { status: string }).status === "interrupted";
    }
    if (e.type === "message") {
      const p = e.payload as { direction: string };
      if (p.direction === "inbound") return false;
      return events.some((d) => d.type === "delivery_reported" && (d.payload as { messageId: string; status: string }).messageId === e.id && (d.payload as { status: string }).status === "interrupted");
    }
  }
  return false;
}

/** The principal's console view: includes private limits and authority, for the operator only. */
function operatorState(state: NegotiationState, locale: string) {
  const n = state.view.negotiable;
  const money = (amount: number | null) => (amount === null || !n ? null : formatValue(n.valueType === "money" ? { type: "money", amount, currency: n.currency } : { type: "quantity", amount, unit: n.unit }, locale));
  return {
    status: state.status,
    mandateRevision: state.mandateRevision,
    outcome: { ...state.outcome, terms: termsView(state.view, state.outcome.terms, locale) },
    pendingApproval: state.pendingApproval
      ? {
          requestId: state.pendingApproval.requestId,
          offerId: state.pendingApproval.offerId,
          mandateRevision: state.mandateRevision,
          purpose: state.pendingApproval.purpose,
          requestedAction: state.pendingApproval.requestedAction,
          breachedRules: state.pendingApproval.breachedRuleIds.map((id) => ruleText(state, id, locale)),
          // The exact terms under review: the pending offer itself, not the buyer-facing outcome.
          terms: termsView(state.view, pendingTerms(state), locale),
          // The same terms as typed values, for a counter the principal edits.
          editable: orderTerms(state.view, pendingTerms(state) ?? []).map((t) => ({ termId: t.termId, name: state.view.terms.get(t.termId)?.name ?? t.termId, value: t.value, negotiated: t.termId === state.view.negotiable?.termId })),
        }
      : null,
    paused: state.status === "paused",
    negotiable: n
      ? { name: n.name, opening: money(n.opening), limit: money(n.limit), limitKind: n.direction === "up" ? "minimum" : "maximum", currentAsk: money(state.currentAsk), canConcede: n.canConcede }
      : null,
    acceptRequiresApproval: state.view.acceptRequiresApproval,
    counterpartyOffers: state.counterpartyAmounts.map((a) => money(a)),
    followUp: followUpView(state, locale),
    recordings: state.recordings.map((r) => ({ id: r.id, source: r.source, durationMs: r.durationMs, recordedAt: r.recordedAt })),
  };
}

/** The terms waiting on the principal: the pending offer itself. */
function pendingTerms(state: NegotiationState): OfferTerm[] | null {
  const p = state.pendingApproval;
  if (!p) return null;
  if (state.lastProposed?.offerId === p.offerId) return state.lastProposed.terms;
  return state.outcome.termsHash === p.termsHash ? state.outcome.terms : null;
}

/**
 * What the approval card shows besides the terms: how long the offer stands, how to reach the
 * counterparty, the principal's decision and where the follow-up is. The number is shown masked.
 */
function followUpView(state: NegotiationState, locale: string) {
  const f = state.followUp;
  // How long their offer stands carries over from an earlier round (after a counter).
  const validFor = f.validity !== null || f.validUntil !== null;
  const lastAttempt = f.attempts.at(-1) ?? null;
  const status = !f.decision
    ? null
    : state.status === "agreed"
      ? "agreed"
      : state.status === "no_agreement" && (lastAttempt?.outcome === "no_answer" || lastAttempt?.outcome === "failed")
        ? "lapsed"
        : state.status === "no_agreement" && f.decision.decision !== "declined"
          ? "ended"
          : f.decision.decision === "declined"
          ? "declined"
          : lastAttempt?.outcome === "calling"
            ? "calling"
            : lastAttempt?.outcome === "no_answer" || lastAttempt?.outcome === "failed"
              ? "retrying"
              : f.followedUp
                ? "waiting_for_yes"
                : "following_up";
  return {
    validUntil: validFor ? f.validUntil : null,
    validity: validFor ? f.validity : null,
    contact: f.contact,
    phone: maskNumber(f.phone),
    bestTime: f.bestTime,
    keepContact: f.keepContact,
    channel: state.callConnected ? "voice" : null,
    supersededTerms: state.pendingApproval && state.supersededApproval ? termsView(state.view, state.supersededApproval.terms, locale) : null,
    decision: f.decision ? { decision: f.decision.decision, at: f.decision.recordedAt, message: f.decision.messageToCounterparty } : null,
    status,
    attempts: f.attempts.map((a) => ({ attempt: a.attempt, outcome: a.outcome, channel: a.channel, at: a.recordedAt })),
  };
}

/** Why a phone call ended (voice_connection "ended"), as the console shows it. */
const CALL_END_LABEL: Record<string, string> = {
  hung_up: "The caller hung up, or the line dropped.",
  idle: "Kritva ended the call after a long silence.",
  max_duration: "Kritva ended the call at its time limit.",
  server: "Kritva ended the call.",
  error: "The call failed to connect.",
};

/** One event as the console shows it: a short title, a one-line summary, and the raw payload. */
function describeEvent(e: RecordedEvent, view: MandateView, locale: string) {
  // The other side in the mandate's own word ("Vendor", "Buyer"); the console is the principal's view, so the principal is "you".
  const role = rolesOf(view).counterparty;
  const them = role.charAt(0).toUpperCase() + role.slice(1);
  const p = e.payload as Record<string, unknown>;
  const terms = (t: unknown) => termsView(view, t as OfferTerm[], locale)?.map((x) => `${x.name}: ${x.value}`).join(" · ") ?? "";
  let title = e.type.replace(/_/g, " ");
  let summary = "";
  switch (e.type) {
    case "session_started":
      title = "Session started";
      summary = `Confirmed mandate, revision ${p.mandateRevision}${p.previousSessionId ? " (reset)" : ""}`;
      break;
    case "message":
      title = p.direction === "inbound" ? `${them} message` : "Agent reply";
      summary = String(p.text);
      break;
    case "offer_extracted":
      title = "Offer extracted";
      summary = terms(p.terms);
      break;
    case "offer_proposed":
      title = p.basis === "final_terms" ? "Final terms proposed" : "Counteroffer proposed";
      summary = terms(p.terms);
      break;
    case "decision":
      title = p.action ? `Decision: ${ACTION_LABEL[String(p.action)] ?? String(p.action)}` : `Decision: ${String(p.kind).replace(/_/g, " ")}`;
      summary = String(p.reason);
      break;
    case "reply_blocked":
      title = "Reply blocked";
      summary = (p.violations as Array<{ detail: string }>).map((v) => v.detail).join(" ");
      break;
    case "delivery_reported":
      title = `Delivery ${p.status}`;
      summary = "";
      break;
    case "voice_connection": {
      const phone = p.transport === "phone";
      const call = p.direction === "outbound" ? "Kritva's call" : "Phone call";
      title = p.status === "interrupted" ? "Voice connection interrupted" : p.status === "ended" ? (phone ? `${call} ended` : "Voice call ended") : phone ? `${call} connected` : "Voice connected";
      if (p.status === "ended") summary = CALL_END_LABEL[String(p.reason)] ?? "";
      break;
    }
    case "acceptance_recorded":
      title = `${them} accepted stated terms`;
      break;
    case "approval_requested":
      title = "Approval requested";
      break;
    case "approval_responded":
      title = p.decision === "approved" ? "You approved" : "You rejected";
      break;
    case "agreement_recorded":
      title = "Agreement recorded";
      summary = terms(p.terms);
      break;
    case "status_changed":
      title = `Status: ${String(p.to).replace(/_/g, " ")}`;
      summary = String(p.reason);
      break;
    case "correction":
      title = "Correction";
      summary = String(p.reason);
      break;
    case "term_requested":
      title = `${them} requested a new term`;
      summary = `${p.name}${p.description ? `: ${p.description}` : ""}`;
      break;
    case "proposal_checked": {
      const findings = (p.findings as Array<{ status: string; termName: string; detail: string }>).filter((f) => f.status !== "fits");
      title = `Check: ${RESULT_LABEL[p.result as keyof typeof RESULT_LABEL]}`;
      summary = findings.length > 0 ? findings.map((f) => `${f.termName}: ${f.detail}`).join(" ") : `Mandate revision ${p.mandateRevision}. ${terms(p.checkedTerms)}`;
      break;
    }
    case "mandate_revised":
      title = "Mandate revised";
      summary = `Revision ${p.mandateRevision}: ${p.reason}`;
      break;
    case "mandate_draft_proposed":
      title = "Mandate draft prepared";
      summary = `Based on revision ${p.basedOnRevision}. Not in force until you confirm it.`;
      break;
    case "mandate_draft_rejected":
      title = "Mandate draft rejected";
      summary = String(p.reason);
      break;
    case "action_checked": {
      const reasons = p.reasons as Array<{ rule: string; detail: string }>;
      title = `Gate (${p.phase}): ${String(p.decision).replace("_", " ")}`;
      summary = reasons.length > 0 ? reasons.map((r) => `${r.rule}: ${r.detail}`).join(" ") : `Move ${p.move}, mandate revision ${p.mandateRevision}.`;
      break;
    }
    case "counterparty_noted": {
      const items = p.items as Array<{ kind: string; quote: string }>;
      title = p.failed ? "Could not read their message" : `${them} context noted`;
      summary = p.failed ? "Earlier context is unchanged." : items.map((i) => `${i.kind.replace("_", " ")}: “${i.quote}”`).join(" · ");
      break;
    }
    case "question_prepared":
      title = "Question prepared";
      summary = `${p.text} (${p.purpose})`;
      break;
    case "question_asked":
      title = "Question asked";
      break;
    case "question_answered":
      title = `Question ${p.resolution}`;
      summary = p.quote ? `“${p.quote}”` : "";
      break;
  }
  return {
    id: e.id,
    seq: e.seq,
    at: e.recordedAt,
    type: e.type,
    actor: e.actor.kind,
    channel: e.channel,
    visibility: e.visibility,
    title,
    summary,
    payload: e.type === "session_started" || e.type === "mandate_revised" ? { mandateRevision: p.mandateRevision, previousSessionId: p.previousSessionId ?? null } : p,
  };
}
