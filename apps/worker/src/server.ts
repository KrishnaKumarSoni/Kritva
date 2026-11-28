/**
 * The Kritva server inside one Durable Object: the same app as on Node (apps/server/src/compose.ts),
 * with the object's SQLite storage as the database, R2 for browser call recordings and Cloudflare
 * Email Sending for sign-in links. One object holds everything, so live calls, the deal board and the
 * record share memory exactly as they did in the single Node process.
 */
import { DurableObject } from "cloudflare:workers";
import type { Hono } from "hono";
import { bundledCases } from "./texts.ts";
import { durableSql } from "./durable-sql.ts";
import { composeServer } from "../../server/src/compose.ts";
import { snapshotCaseFiles } from "../../server/src/main-helpers.ts";
import type { RecordingStore } from "../../server/src/app.ts";
import type { EmailBinding } from "../../server/src/auth.ts";

export interface Env {
  KRITVA: DurableObjectNamespace;
  ASSETS: AssetsBinding;
  RECORDINGS?: R2Bucket;
  EMAIL?: EmailBinding;
  [key: string]: unknown;
}

/** Where the bundled cases/ appear to live; only used to build paths. */
const ROOT = "/kritva";

function r2Recordings(bucket: R2Bucket): RecordingStore {
  return {
    put: async (file, audio, contentType) => void (await bucket.put(`recordings/${file}`, audio, { httpMetadata: { contentType } })),
    get: async (file) => {
      const object = await bucket.get(`recordings/${file}`);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
  };
}

export class KritvaServer extends DurableObject<Env> {
  #app: Hono | null = null;

  #server(): Hono {
    if (this.#app) return this.#app;
    // The server reads its settings from process.env, as on Node: the Worker's vars and secrets.
    for (const [key, value] of Object.entries(this.env)) if (typeof value === "string") process.env[key] = value;
    const { app } = composeServer({
      root: ROOT,
      caseFiles: snapshotCaseFiles(ROOT, bundledCases),
      sql: durableSql(this.ctx.storage),
      recordings: this.env.RECORDINGS ? r2Recordings(this.env.RECORDINGS) : null,
      emailBinding: this.env.EMAIL ?? null,
    });
    this.#app = app;
    return app;
  }

  async fetch(request: Request): Promise<Response> {
    return this.#server().fetch(request);
  }
}
