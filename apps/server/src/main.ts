/** Starts the slice server: local SQLite record, confirmed mandates from cases/, OpenAI turn model. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createMappingLlmFromEnv, createSpeechFromEnv, createTurnLlmFromEnv, MandateLibrary, MandateRevisions, NegotiationEngine, NegotiationRecord, SqliteLibraryBackend, SqliteRecordBackend } from "@kritva/core";
import { createApp } from "./app.ts";
import { loadConfirmedMandates, loadExamples, loadGuidance, loadListings } from "./main-helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

const dataDir = process.env.KRITVA_DATA_DIR ?? join(ROOT, "data");
mkdirSync(dataDir, { recursive: true });
const record = new NegotiationRecord(new SqliteRecordBackend(join(dataDir, "kritva.sqlite")));
const locale = process.env.KRITVA_LOCALE ?? "en-IN";
const engine = new NegotiationEngine({ record, llm: createTurnLlmFromEnv(), locale, guidance: loadGuidance(ROOT), voiceWording: process.env.KRITVA_VOICE_WORDING === "template" ? "template" : "composed" });
const mappingLlm = createMappingLlmFromEnv();
const revisions = new MandateRevisions({ record, engine, mappingLlm });
// Case-level mandates live in their own tables, so they exist before any session starts.
const library = new MandateLibrary({ backend: new SqliteLibraryBackend(join(dataDir, "kritva.sqlite")), mappingLlm });
const mandates = loadConfirmedMandates(join(ROOT, "cases"));
const examples = loadExamples(join(ROOT, "cases"));
const listings = loadListings(join(ROOT, "cases"), mandates, examples, library);
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
  transcriptionPrompt: process.env.KRITVA_TRANSCRIPTION_PROMPT ?? "A buyer in India talking to a seller's assistant about price, pickup and terms. Amounts are in Indian rupees (₹), for example ₹18,000 or ₹19,500. Never use dollars.",
});
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Kritva slice server listening on http://localhost:${info.port}`);
});
