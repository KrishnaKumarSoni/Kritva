/** Starts the slice server: local SQLite record, confirmed mandates from cases/, OpenAI turn model. */
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createAgentFromEnv, createIntakeAgentFromEnv, createMappingLlmFromEnv, createSpeechFromEnv, createTurnLlmFromEnv, IntakeService, SqliteIntakeStore, DealGroups, MandateLibrary, MandateRevisions, NegotiationEngine, NegotiationRecord, SqliteLibraryBackend, SqliteRecordBackend } from "@kritva/core";
import { createApp } from "./app.ts";
import { OpenAIRealtimeConnector, realtimeSettingsFromEnv } from "./realtime-voice.ts";
import { phoneFromEnv } from "./phone/routes.ts";
import { loadCaseRuntime, maxCounterparties } from "./main-helpers.ts";
import { LiveCalls } from "./live-calls.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

const dataDir = process.env.KRITVA_DATA_DIR ?? join(ROOT, "data");
mkdirSync(dataDir, { recursive: true });
const record = new NegotiationRecord(new SqliteRecordBackend(join(dataDir, "kritva.sqlite")));
const locale = process.env.KRITVA_LOCALE ?? "en-IN";
// Several counterparties per saved mandate. The cap limits each mandate's counterparty list and its
// open negotiations at once, so a mistake can't run up model use (docs/Kritva_Multiple_Counterparties.md).
const groups = new DealGroups(record, { maxOpen: maxCounterparties(process.env.KRITVA_MAX_COUNTERPARTIES) });
const liveCalls = new LiveCalls();
const mappingLlm = createMappingLlmFromEnv();
// Case-level mandates live in their own tables, so they exist before any session starts.
// The library maps the intake agent's plain-prose brief, which low reasoning effort handles as well as the
// default in the live mapping suite at about half the time. Mid-negotiation changes keep mappingLlm.
const libraryMappingLlm = createMappingLlmFromEnv({ ...process.env, KRITVA_MAPPING_REASONING_EFFORT: process.env.KRITVA_INTAKE_MAPPING_REASONING_EFFORT ?? "low" });
const library = new MandateLibrary({ backend: new SqliteLibraryBackend(join(dataDir, "kritva.sqlite")), mappingLlm: libraryMappingLlm });
const { mandates, examples, listings, guidanceByCase, defaultGuidance, subjectFacts, listingDetails } = loadCaseRuntime(ROOT, library);
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
  onSessionClosedElsewhere: (sessionId) => liveCalls.breakIn(sessionId),
  contactFor: (sessionId) => liveCalls.contactFor(sessionId),
  onDealConcluded: ({ mandateId }) => {
    const closed = library.setLifecycle(mandateId, "closed");
    console.log(`[deal] concluded for ${mandateId}; listing ${closed.ok ? "closed" : `not closed (${closed.message})`}`);
  },
});
const revisions = new MandateRevisions({ record, engine, mappingLlm });
// The intake agent: a separate chat agent that gathers a new or changed mandate before any negotiation.
const intake = new IntakeService({ store: new SqliteIntakeStore(join(dataDir, "kritva.sqlite")), agent: createIntakeAgentFromEnv(), library, defaultCurrency: process.env.KRITVA_DEFAULT_CURRENCY ?? "Indian rupees (₹)" });
const configuredKey = process.env.KRITVA_OPERATOR_KEY?.trim();
const operatorKey = configuredKey || randomBytes(24).toString("base64url");
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
  transcriptionPrompt: process.env.KRITVA_TRANSCRIPTION_PROMPT,
  // Live voice by default; KRITVA_VOICE_MODE=turns keeps the turn-based pipeline.
  realtime:
    process.env.OPENAI_API_KEY && (process.env.KRITVA_VOICE_MODE ?? "realtime") === "realtime"
      ? { connector: new OpenAIRealtimeConnector(process.env.OPENAI_API_KEY), settings: realtimeSettingsFromEnv(), log: (entry) => console.log("[voice]", JSON.stringify(entry)) }
      : null,
  // Phone calls (docs/Kritva_Phone_Calls.md): on when OPENAI_WEBHOOK_SECRET and KRITVA_PHONE_ROUTES are set.
  phone: phoneFromEnv(),
  groups,
  liveCalls,
});
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port, hostname: process.env.KRITVA_HOST ?? "127.0.0.1" }, (info) => {
  console.log(`Kritva slice server listening on http://localhost:${info.port}`);
  if (!configuredKey) console.log(`Seller access key for this run: ${operatorKey}`);
});
