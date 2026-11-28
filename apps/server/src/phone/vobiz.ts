/**
 * Vobiz, the phone line for calls with Sarvam speech (docs/Kritva_Phone_Calls.md, section 17):
 * placing calls, the answer XML that streams a call's audio to Kritva, and checking that a webhook
 * came from Vobiz. https://www.vobiz.ai/docs
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeNumber, parseRoutes, type PhoneTarget } from "./config.ts";

export interface VobizSettings {
  authId: string;
  authToken: string;
  /** Kritva's Vobiz number, digits with country code ("918064264194"). Calls go out from it and come in on it. */
  number: string;
  /** This server's public https address; Vobiz's webhooks and the media stream use it. */
  publicUrl: string;
  /** Who an incoming call talks to: a listing (its case ID) or a saved mandate. Null: incoming calls are declined. */
  inbound: Exclude<PhoneTarget, { kind: "code" }> | null;
  /** Numbers Kritva may call (digits with country code), or ["*"] for any. */
  allow: string[];
  /** Calls at once (ringing or connected). */
  maxCalls: number;
  /** Silence before "still there?", and again before hanging up. */
  idleMs: number;
  /** Longest a call may run. */
  maxCallMs: number;
  countryCode: string;
  /** Check X-Vobiz-Signature-V3 on every webhook (VOBIZ_VERIFY_SIGNATURE=off to skip, for local tests). */
  verify: boolean;
}

/**
 * Vobiz calls with Sarvam speech, from the environment: VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, KRITVA_VOBIZ_NUMBER
 * and an https KRITVA_PUBLIC_URL. KRITVA_VOBIZ_INBOUND names what incoming calls reach (default: the
 * first listing). Null, with the reasons, when something is missing.
 */
export function vobizSettingsFromEnv(env: NodeJS.ProcessEnv, fallbackListing: string | null): { settings: VobizSettings | null; problems: string[] } {
  const problems: string[] = [];
  const countryCode = (env.KRITVA_PHONE_COUNTRY_CODE ?? "91").replace(/\D/g, "") || "91";
  const authId = env.VOBIZ_AUTH_ID?.trim() ?? "";
  const authToken = env.VOBIZ_AUTH_TOKEN?.trim() ?? "";
  const number = normalizeNumber(env.KRITVA_VOBIZ_NUMBER ?? "", countryCode);
  const publicUrl = env.KRITVA_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  if (!authId || !authToken) problems.push("VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN are needed.");
  if (!/^\d{10,15}$/.test(number)) problems.push("KRITVA_VOBIZ_NUMBER (Kritva's Vobiz number, +91...) is needed.");
  if (!/^https:\/\//.test(publicUrl)) problems.push("KRITVA_PUBLIC_URL (this server's https address) is needed.");
  const inboundRaw = env.KRITVA_VOBIZ_INBOUND?.trim() || fallbackListing;
  let inbound: VobizSettings["inbound"] = null;
  if (inboundRaw && inboundRaw !== "off") {
    const target = parseRoutes(`*=${inboundRaw}`, countryCode).routes[0]?.target;
    if (target && target.kind !== "code") inbound = target;
    else problems.push("KRITVA_VOBIZ_INBOUND must name a listing (bed-sale) or a mandate (mandate:man_...); incoming calls are declined.");
  }
  const allow = (env.KRITVA_PHONE_OUTBOUND_ALLOW ?? "").split(",").map((n) => n.trim()).filter(Boolean).map((n) => (n === "*" ? "*" : normalizeNumber(n, countryCode)));
  const int = (raw: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  if (!authId || !authToken || !/^\d{10,15}$/.test(number) || !/^https:\/\//.test(publicUrl)) return { settings: null, problems };
  return {
    settings: {
      authId,
      authToken,
      number,
      publicUrl,
      inbound,
      allow,
      maxCalls: int(env.KRITVA_PHONE_MAX_CALLS, 3, 1, 20),
      idleMs: int(env.KRITVA_PHONE_IDLE_SECONDS, 30, 10, 300) * 1000,
      maxCallMs: int(env.KRITVA_PHONE_MAX_MINUTES, 10, 1, 60) * 60_000,
      countryCode,
      verify: env.VOBIZ_VERIFY_SIGNATURE !== "off",
    },
    problems,
  };
}

export class VobizError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Vobiz request failed (${status}): ${body.slice(0, 300)}`);
    this.status = status;
  }
}

/** Vobiz's REST API (the calls Kritva needs). Tests pass a fake. */
export interface VobizCalls {
  /** Rings a number; resolves with Vobiz's call ID once the call is queued (not answered). */
  placeCall(call: { from: string; to: string; answerUrl: string; ringUrl: string; hangupUrl: string; timeLimitSeconds: number }): Promise<{ callUuid: string }>;
  /** Ends a call in any state. A call that already ended is not an error. */
  hangup(callUuid: string): Promise<void>;
}

export class VobizApi implements VobizCalls {
  readonly #authId: string;
  readonly #authToken: string;
  readonly #base: string;

  constructor(authId: string, authToken: string, base = "https://api.vobiz.ai/api/v1") {
    this.#authId = authId;
    this.#authToken = authToken;
    this.#base = base;
  }

  async placeCall(call: { from: string; to: string; answerUrl: string; ringUrl: string; hangupUrl: string; timeLimitSeconds: number }) {
    // The Account segment is PascalCase and needs the trailing slash (Vobiz answers 401 otherwise).
    const res = await fetch(`${this.#base}/Account/${encodeURIComponent(this.#authId)}/Call/`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ from: call.from, to: call.to, answer_url: call.answerUrl, answer_method: "POST", ring_url: call.ringUrl, ring_method: "POST", hangup_url: call.hangupUrl, hangup_method: "POST", time_limit: call.timeLimitSeconds }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new VobizError(res.status, text);
    const body = JSON.parse(text) as { request_uuid?: string; call_uuid?: string };
    const callUuid = body.request_uuid ?? body.call_uuid;
    if (!callUuid) throw new VobizError(res.status, `no request_uuid in ${text}`);
    return { callUuid };
  }

  async hangup(callUuid: string) {
    const res = await fetch(`${this.#base}/Account/${encodeURIComponent(this.#authId)}/Call/${encodeURIComponent(callUuid)}/`, { method: "DELETE", headers: this.#headers(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok && res.status !== 404) throw new VobizError(res.status, await res.text());
  }

  #headers() {
    return { "X-Auth-ID": this.#authId, "X-Auth-Token": this.#authToken, "Content-Type": "application/json" };
  }
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inbound caller audio Kritva asks for: 16-bit PCM at 8 kHz, a phone line's own rate. */
export const STREAM_SAMPLE_RATE = 8000;

/**
 * The answer XML: stream the call's audio both ways over a WebSocket to Kritva, and keep the call up
 * while the stream lasts. The token in the URL says which call it is (the handshake carries no other
 * credentials). When Kritva sends "stop", there is no next element, so Vobiz hangs up.
 */
export function streamXml(streamUrl: string, maxSeconds: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" audioTrack="inbound" keepCallAlive="true" contentType="audio/x-l16;rate=${STREAM_SAMPLE_RATE}" streamTimeout="${Math.round(maxSeconds)}">${xmlEscape(streamUrl)}</Stream>
</Response>`;
}

/** Declines a call: Vobiz hangs up with nothing said. */
export const hangupXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;

/**
 * Whether a webhook came from Vobiz: X-Vobiz-Signature-V3 is base64(HMAC-SHA256(auth token,
 * baseUrl + "." + nonce)), and V2 the same without the dot. The base URL is the address Vobiz called
 * without its query string, rebuilt on KRITVA_PUBLIC_URL (a proxy may change the host the server sees).
 * https://www.vobiz.ai/docs/concepts/validating-callbacks
 */
export function vobizSignatureValid(input: { publicUrl: string; requestUrl: string; authToken: string; header: (name: string) => string | undefined }): boolean {
  const path = new URL(input.requestUrl).pathname;
  const base = `${input.publicUrl.replace(/\/+$/, "")}${path}`;
  const check = (signature: string | undefined, message: string) => {
    if (!signature) return false;
    const expected = createHmac("sha256", input.authToken).update(message).digest("base64");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const v3 = input.header("x-vobiz-signature-v3");
  const v3Nonce = input.header("x-vobiz-signature-v3-nonce");
  if (v3 && v3Nonce) return check(v3, `${base}.${v3Nonce}`);
  const v2 = input.header("x-vobiz-signature-v2");
  const v2Nonce = input.header("x-vobiz-signature-v2-nonce");
  return Boolean(v2 && v2Nonce) && check(v2, `${base}${v2Nonce}`);
}
