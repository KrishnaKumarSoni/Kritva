/** Starts the slice server on Node: local SQLite record, confirmed mandates from cases/, OpenAI turn model. On Cloudflare, apps/worker runs the same server (compose.ts). */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { folderRecordings } from "./app.ts";
import { composeServer, nodeDataPaths } from "./compose.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

const dataDir = process.env.KRITVA_DATA_DIR ?? resolve(ROOT, "data");
mkdirSync(dataDir, { recursive: true });
const paths = nodeDataPaths(dataDir);
const { app, operatorKey, operatorKeyConfigured, webUrl } = composeServer({ root: ROOT, sql: paths.sqlite, recordings: folderRecordings(paths.recordings) });
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port, hostname: process.env.KRITVA_HOST ?? "127.0.0.1" }, (info) => {
  console.log(`Kritva slice server listening on http://localhost:${info.port}`);
  console.log(`Console: sign in at ${webUrl ?? "http://localhost:5173"} with your email.`);
  if (!operatorKeyConfigured) console.log(`Access key for scripts this run: ${operatorKey}`);
});
