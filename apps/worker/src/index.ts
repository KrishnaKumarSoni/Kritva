/**
 * Kritva on Cloudflare (docs/Kritva_Cloudflare.md). The web app is static assets; every /api request
 * goes to the one KritvaServer Durable Object, placed near OpenAI (the server's calls to OpenAI are
 * on every turn's path; the browser and phone audio go to OpenAI directly).
 */
import "./texts.ts";
import type { Env } from "./server.ts";

export { KritvaServer } from "./server.ts";

/** The object's name. Changing it starts an empty database. */
const SERVER = "kritva";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const hint = typeof env.KRITVA_LOCATION_HINT === "string" ? env.KRITVA_LOCATION_HINT : "enam";
      return env.KRITVA.get(env.KRITVA.idFromName(SERVER), { locationHint: hint }).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
