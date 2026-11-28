/**
 * Builds the whole server (record, engine, library, intake, voice, phone, sign-in and routes) from the
 * environment. Two hosts run it, with the same wiring:
 * - Node (src/main.ts): a SQLite file, recordings in a folder, sign-in links in the log;
 * - Cloudflare (apps/worker): one Durable Object's SQLite storage, recordings in R2, sign-in links
 *   through Cloudflare Email Sending.
 * Settings are read from process.env (on Cloudflare, the Worker's vars and secrets).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createAgentFromEnv, createIntakeAgentFromEnv, createMappingLlmFromEnv, createSpeechFromEnv, createTurnLlmFromEnv, IntakeService, SqliteIntakeStore, DealGroups, MandateLibrary, MandateRevisions, NegotiationEngine, NegotiationRecord, SqliteLibraryBackend, SqliteRecordBackend, type SqlSource } from "@kritva/core";
import { createApp, type RecordingStore } from "./app.ts";
import { OpenAIRealtimeConnector, realtimeSettingsFromEnv } from "./realtime-voice.ts";
import { outboundDialer, phoneFromEnv } from "./phone/routes.ts";
import type { OutboundDialer } from "./phone/outbound.ts";
import { diskCaseFiles, loadCaseRuntime, maxCounterparties, type CaseFiles } from "./main-helpers.ts";
import { LiveCalls } from "./live-calls.ts";
import { hangUpPending } from "./group-routes.ts";
import { FollowUpCalls, followUpSettingsFromEnv } from "./phone/follow-up.ts";
import { normalizeNumber, sipUri, twilioFromEnv } from "./phone/config.ts";
import { AuthStore, authFromEnv, type EmailBinding } from "./auth.ts";

export interface ServerHost {
  /** The repository root: cases/ is read under it. */
  root: string;
  /** How cases/ is read. Default: from disk. */
  caseFiles?: CaseFiles;
  /** The database: a SQLite file path (Node) or an open database (a Durable Object's storage). */
  sql: SqlSource;
  /** Where browser call recordings are kept. Null: recording is off. */
  recordings: RecordingStore | null;
  /** Cloudflare Email Sending, when running on Cloudflare. */
  emailBinding?: EmailBinding | null;
}

export function composeServer(host: ServerHost) {
  const env = process.env;
  const caseFiles = host.caseFiles ?? diskCaseFiles;
  const record = new NegotiationRecord(new SqliteRecordBackend(host.sql));
  const locale = env.KRITVA_LOCALE ?? "en-IN";
  // Several counterparties per saved mandate. The cap limits each mandate's counterparty list and its
  // open negotiations at once, so a mistake can't run up model use (docs/Kritva_Multiple_Counterparties.md).
  const groups = new DealGroups(record, { maxOpen: maxCounterparties(env.KRITVA_MAX_COUNTERPARTIES) });
  const liveCalls = new LiveCalls();
  // Kritva calling counterparties (src/phone/outbound.ts): set once the phone setup is read, below.
  let dialer: OutboundDialer | null = null;
  const mappingLlm = createMappingLlmFromEnv();
  // Case-level mandates live in their own tables, so they exist before any session starts.
  // The library maps the intake agent's plain-prose brief, which low reasoning effort handles as well as the
  // default in the live mapping suite at about half the time. Mid-negotiation changes keep mappingLlm.
  const libraryMappingLlm = createMappingLlmFromEnv({ ...env, KRITVA_MAPPING_REASONING_EFFORT: env.KRITVA_INTAKE_MAPPING_REASONING_EFFORT ?? "low" });
  const library = new MandateLibrary({ backend: new SqliteLibraryBackend(host.sql), mappingLlm: libraryMappingLlm });
  const { mandates, examples, listings, guidanceByCase, defaultGuidance, subjectFacts, listingDetails } = loadCaseRuntime(host.root, library, caseFiles);
  // Every live mandate has the listing code callers give on the shared phone line; mandates saved before codes existed get one now.
  const coded = library.ensureListingCodes();
  if (coded) console.log(`Listing codes: gave ${coded} saved mandate(s) their code.`);
  // Kritva runs each turn as an agent (OpenAI Agents SDK); the turn model reviews its wording.
  const engine = new NegotiationEngine({
    record,
    llm: createTurnLlmFromEnv(),
    ...createAgentFromEnv(),
    locale,
    guidance: defaultGuidance,
    guidanceByCase,
    subjectFacts,
    listingDetails,
    // Several counterparties: the deal group, breaking into live calls, and closing the listing once agreed.
    groups,
    onSessionClosedElsewhere: (sessionId) => {
      liveCalls.breakIn(sessionId);
      void hangUpPending(dialer, sessionId);
    },
    contactFor: (sessionId) => liveCalls.contactFor(sessionId),
    onDealConcluded: ({ mandateId }) => {
      const closed = library.setLifecycle(mandateId, "closed");
      console.log(`[deal] concluded for ${mandateId}; listing ${closed.ok ? "closed" : `not closed (${closed.message})`}`);
    },
  });
  const revisions = new MandateRevisions({ record, engine, mappingLlm });
  // The intake agent: a separate chat agent that gathers a new or changed mandate before any negotiation.
  const intake = new IntakeService({ store: new SqliteIntakeStore(host.sql), agent: createIntakeAgentFromEnv(), library, defaultCurrency: env.KRITVA_DEFAULT_CURRENCY ?? "Indian rupees (₹)", counterpartyCap: maxCounterparties(env.KRITVA_MAX_COUNTERPARTIES) });
  // Phone calls (docs/Kritva_Phone_Calls.md), and Kritva's outbound dialer, shared by the phone routes and the counterparties' board.
  const phone = phoneFromEnv();
  // With board calls on, numbers on the principal's counterparty lists may be called too (besides KRITVA_PHONE_OUTBOUND_ALLOW).
  const boardCalls = env.KRITVA_BOARD_CALLS === "on";
  const listedNumber = (to: string) => library.list().some((m) => library.counterparties(m.mandateId).some((e) => e.phone && normalizeNumber(e.phone, phone?.settings.countryCode) === to));
  dialer = outboundDialer(phone, engine, boardCalls ? listedNumber : undefined);
  if (dialer && boardCalls) console.log("Board calls: on. Numbers on counterparty lists may be called.");
  // Call-backs after the principal decides (Twilio). Without them, every follow-up goes to the counterparty's chat.
  const followUpConfig = followUpSettingsFromEnv(env, phone ? sipUri(phone.settings) : null);
  const followUps = phone && followUpConfig.settings ? new FollowUpCalls({ record, engine, settings: followUpConfig.settings, twilio: phone.twilio, log: (entry) => console.log("[follow-up]", JSON.stringify(entry)) }) : null;
  console.log(followUps ? "Call-backs: on (Twilio)." : `Call-backs: off${phone ? `. ${followUpConfig.problems.join(" ")}` : " (phone calls are off)"}. Follow-ups go to the buyer's chat.`);
  const configuredKey = env.KRITVA_OPERATOR_KEY?.trim();
  // The access key is for scripts and tools; people sign in to the console with an emailed link.
  const operatorKey = configuredKey || randomBytes(24).toString("base64url");
  const signIn = authFromEnv(env, { emailBinding: host.emailBinding ?? null });
  for (const note of signIn.notes) console.log(note);
  const app = createApp({
    record,
    engine,
    revisions,
    mandates,
    locale,
    library,
    intake,
    examples,
    speech: createSpeechFromEnv(),
    listings,
    operatorKey,
    auth: { store: new AuthStore(host.sql), settings: signIn.settings, log: (entry) => console.log("[sign-in]", JSON.stringify(entry)) },
    transcriptionPrompt: env.KRITVA_TRANSCRIPTION_PROMPT,
    // Live voice by default; KRITVA_VOICE_MODE=turns keeps the turn-based pipeline.
    realtime:
      env.OPENAI_API_KEY && (env.KRITVA_VOICE_MODE ?? "realtime") === "realtime"
        ? { connector: new OpenAIRealtimeConnector(env.OPENAI_API_KEY), settings: realtimeSettingsFromEnv(), log: (entry) => console.log("[voice]", JSON.stringify(entry)) }
        : null,
    // Phone calls: on when OPENAI_WEBHOOK_SECRET and KRITVA_PHONE_ROUTES are set; outbound when Twilio is configured too.
    phone,
    groups,
    liveCalls,
    dialer,
    // The deal board places calls only when KRITVA_BOARD_CALLS=on.
    boardCalls,
    followUps,
    recordings: host.recordings,
    twilio: twilioFromEnv(env),
  });
  return { app, operatorKey, operatorKeyConfigured: Boolean(configuredKey), webUrl: signIn.settings.webUrl };
}

/** The data folder of a Node run, for the default paths. */
export function nodeDataPaths(dataDir: string) {
  return { sqlite: join(dataDir, "kritva.sqlite"), recordings: join(dataDir, "recordings") };
}
