/** Starts the slice server: local SQLite record, confirmed mandates from cases/, OpenAI turn model. */
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createMappingLlmFromEnv, createSpeechFromEnv, createTurnLlmFromEnv, MandateLibrary, MandateRevisions, NegotiationEngine, NegotiationRecord, SqliteLibraryBackend, SqliteRecordBackend } from "@kritva/core";
import { createApp } from "./app.ts";
import { loadCaseGuidance, loadConfirmedMandates, loadExamples, loadListings } from "./main-helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

const dataDir = process.env.KRITVA_DATA_DIR ?? join(ROOT, "data");
mkdirSync(dataDir, { recursive: true });
const record = new NegotiationRecord(new SqliteRecordBackend(join(dataDir, "kritva.sqlite")));
const locale = process.env.KRITVA_LOCALE ?? "en-IN";
const mappingLlm = createMappingLlmFromEnv();
// Case-level mandates live in their own tables, so they exist before any session starts.
const library = new MandateLibrary({ backend: new SqliteLibraryBackend(join(dataDir, "kritva.sqlite")), mappingLlm });
const mandates = loadConfirmedMandates(join(ROOT, "cases"));
const examples = loadExamples(join(ROOT, "cases"));
const listings = loadListings(join(ROOT, "cases"), mandates, examples, library);
const subjectFacts = new Map(listings.flatMap((l) => l.subjectFactId ? [[l.caseId, l.subjectFactId] as const] : []));
const listingDetails = new Map(listings.map((listing) => [listing.caseId, listing]));
const engine = new NegotiationEngine({ record, llm: createTurnLlmFromEnv(), locale, guidanceByCase: loadCaseGuidance(ROOT), subjectFacts, listingDetails });
const revisions = new MandateRevisions({ record, engine, mappingLlm });
const configuredKey = process.env.KRITVA_OPERATOR_KEY?.trim();
const operatorKey = configuredKey || randomBytes(24).toString("base64url");
const app = createApp({
  record,
  engine,
  revisions,
  mandates,
  locale,
  library,
  examples,
  speech: createSpeechFromEnv(),
  listings,
  operatorKey,
  transcriptionPrompt: process.env.KRITVA_TRANSCRIPTION_PROMPT,
});
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port, hostname: process.env.KRITVA_HOST ?? "127.0.0.1" }, (info) => {
  console.log(`Kritva slice server listening on http://localhost:${info.port}`);
  if (!configuredKey) console.log(`Seller access key for this run: ${operatorKey}`);
});
