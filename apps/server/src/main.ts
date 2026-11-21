/** Starts the slice server: local SQLite record, confirmed mandates from cases/, OpenAI turn model. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createMappingLlmFromEnv, createTurnLlmFromEnv, MandateRevisions, NegotiationEngine, NegotiationRecord, SqliteRecordBackend } from "@kritva/core";
import { createApp } from "./app.ts";
import { loadConfirmedMandates, loadGuidance } from "./main-helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

const dataDir = process.env.KRITVA_DATA_DIR ?? join(ROOT, "data");
mkdirSync(dataDir, { recursive: true });
const record = new NegotiationRecord(new SqliteRecordBackend(join(dataDir, "kritva.sqlite")));
const locale = process.env.KRITVA_LOCALE ?? "en-IN";
const engine = new NegotiationEngine({ record, llm: createTurnLlmFromEnv(), locale, guidance: loadGuidance(ROOT) });
const revisions = new MandateRevisions({ record, engine, mappingLlm: createMappingLlmFromEnv() });
const app = createApp({ record, engine, revisions, mandates: loadConfirmedMandates(join(ROOT, "cases")), locale });
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Kritva slice server listening on http://localhost:${info.port}`);
});
