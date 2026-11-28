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
import { VOBIZ_STREAM_PATH, type VobizPhone } from "../../server/src/phone/vobiz-phone.ts";
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
  #vobiz: VobizPhone | null = null;

  #server(): Hono {
    if (this.#app) return this.#app;
    // The server reads its settings from process.env, as on Node: the Worker's vars and secrets.
    for (const [key, value] of Object.entries(this.env)) if (typeof value === "string") process.env[key] = value;
    const { app, vobiz } = composeServer({
      root: ROOT,
      caseFiles: snapshotCaseFiles(ROOT, bundledCases),
      sql: durableSql(this.ctx.storage),
      recordings: this.env.RECORDINGS ? r2Recordings(this.env.RECORDINGS) : null,
      emailBinding: this.env.EMAIL ?? null,
    });
    this.#app = app;
    this.#vobiz = vobiz;
    return app;
  }

  async fetch(request: Request): Promise<Response> {
    const app = this.#server();
    const url = new URL(request.url);
    if (url.pathname === VOBIZ_STREAM_PATH && request.headers.get("Upgrade")?.toLowerCase() === "websocket") return this.#phoneStream(url.searchParams.get("t"));
    return app.fetch(request);
  }

  /**
   * A phone call's media stream (Vobiz, phone/vobiz-phone.ts). The socket is accepted here, without
   * hibernation, so the object stays in memory for the whole call and the call's state with it.
   */
  #phoneStream(token: string | null): Response {
    if (!this.#vobiz) return new Response("phone calls are off", { status: 404 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const handlers = this.#vobiz.acceptStream(token, { send: (text) => server.send(text), close: () => server.close(1000, "call ended") });
    if (!handlers) return new Response("unknown call", { status: 403 });
    server.accept();
    server.addEventListener("message", (event) => handlers.message(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)));
    server.addEventListener("close", () => handlers.closed());
    server.addEventListener("error", () => handlers.closed());
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WorkerWebSocket });
  }
}
