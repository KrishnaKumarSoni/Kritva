/**
 * Twilio, Kritva's phone provider (docs/Kritva_Phone_Calls.md).
 *
 * Twilio carries the phone leg; OpenAI's realtime SIP endpoint carries the voice. Kritva joins them
 * with TwiML `<Dial><Sip>`, which hands a Twilio call to OpenAI's SIP address, where it arrives as an
 * ordinary incoming realtime call (`realtime.call.incoming`, handled in routes.ts):
 *
 *   Inbound:  caller → Kritva's Twilio number → its Voice URL (POST /api/phone/twilio/voice)
 *             → TwiML <Dial><Sip> to OpenAI, with X-Kritva-Called / X-Kritva-Caller headers
 *   Outbound: Kritva → Calls API (to the counterparty, from Kritva's number) → they answer → Twilio asks
 *             the call's answer URL → TwiML <Dial><Sip> to OpenAI, tagged with X-Kritva-Call=<token>
 *
 * Twilio passes custom SIP headers given as `X-` query parameters on the `<Sip>` URI, and OpenAI's
 * webhook hands them back in `data.sip_headers`. Every Twilio webhook is signed (X-Twilio-Signature);
 * the routes check it with the account's auth token.
 * https://www.twilio.com/docs/voice/twiml/sip, https://www.twilio.com/docs/voice/api/call-resource,
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface PlaceCall {
  /** Kritva's Twilio number, E.164 ("+19125021960"). */
  from: string;
  /** The number to call, E.164. */
  to: string;
  /** Twilio fetches TwiML here when the call is answered. */
  answerUrl: string;
  /** Twilio posts the call's progress here (initiated, ringing, answered, completed). */
  statusUrl: string;
  /** Longest the answered call may run, in seconds. */
  timeLimitSeconds: number;
  /** How long it may ring before Twilio gives up (no-answer). Default 30. */
  ringSeconds?: number;
  /** Record the whole call and post the recording here when it is ready. Off when absent. */
  recordingUrl?: string | null;
}

/** The provider that places outbound calls. Tests pass a fake. */
export interface OutboundTelephony {
  /** Places the call; resolves with the provider's call ID once the provider has queued it (not answered). */
  placeCall(call: PlaceCall): Promise<{ providerCallId: string }>;
  /** Ends a call in any state. A call that already ended is not an error. */
  hangup(providerCallId: string): Promise<void>;
}

export class TwilioError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Twilio request failed (${status}): ${body.slice(0, 300)}`);
    this.status = status;
  }
}

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

/** Twilio's REST API, for placing and ending calls. */
export class TwilioTelephony implements OutboundTelephony {
  readonly #creds: TwilioCredentials;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(creds: TwilioCredentials, options: { base?: string; fetch?: typeof fetch } = {}) {
    this.#creds = creds;
    this.#base = options.base ?? "https://api.twilio.com/2010-04-01";
    this.#fetch = options.fetch ?? fetch;
  }

  async placeCall(call: PlaceCall) {
    const form = new URLSearchParams({
      To: call.to,
      From: call.from,
      Url: call.answerUrl,
      Method: "POST",
      StatusCallback: call.statusUrl,
      StatusCallbackMethod: "POST",
      Timeout: String(call.ringSeconds ?? 30),
      TimeLimit: String(Math.max(60, Math.round(call.timeLimitSeconds))),
    });
    for (const event of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", event);
    if (call.recordingUrl) {
      form.set("Record", "true");
      form.set("RecordingStatusCallback", call.recordingUrl);
      form.set("RecordingStatusCallbackMethod", "POST");
      form.set("RecordingStatusCallbackEvent", "completed");
    }
    const res = await this.#fetch(`${this.#base}/Accounts/${encodeURIComponent(this.#creds.accountSid)}/Calls.json`, { method: "POST", headers: this.#headers(), body: form, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new TwilioError(res.status, text);
    const sid = (JSON.parse(text) as { sid?: string }).sid;
    if (!sid) throw new TwilioError(res.status, `no call sid in ${text}`);
    return { providerCallId: sid };
  }

  /** Ends the call: "completed" hangs up a live call and cancels one still queued or ringing. */
  async hangup(providerCallId: string) {
    if (!providerCallId) return;
    const res = await this.#fetch(`${this.#base}/Accounts/${encodeURIComponent(this.#creds.accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`, { method: "POST", headers: this.#headers(), body: new URLSearchParams({ Status: "completed" }), signal: AbortSignal.timeout(10_000) });
    if (res.ok || res.status === 404) return;
    const text = await res.text();
    // 21220: the call already ended ("not in-progress"), which is what we wanted.
    if (/"code"\s*:\s*21220/.test(text)) return;
    throw new TwilioError(res.status, text);
  }

  /** Fetches a recording's audio (mp3) for the console. Null when Twilio has no such recording. */
  async recording(url: string): Promise<{ audio: Uint8Array<ArrayBuffer>; contentType: string } | null> {
    if (!isTwilioRecordingUrl(url)) return null;
    const res = await this.#fetch(/\.(mp3|wav)$/.test(url) ? url : `${url}.mp3`, { headers: { Authorization: this.#headers().Authorization }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res?.ok) return null;
    return { audio: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("Content-Type") ?? "audio/mpeg" };
  }

  #headers() {
    return { Authorization: `Basic ${Buffer.from(`${this.#creds.accountSid}:${this.#creds.authToken}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" };
  }
}

/** Recording URLs Kritva will fetch with the account's credentials: Twilio's API host only. */
export const isTwilioRecordingUrl = (url: string) => /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC\w+\/Recordings\/RE\w+(\.mp3|\.wav)?$/.test(url);

// ---------- TwiML ----------

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** TwiML that ends the call. Twilio needs a TwiML answer even when there is nothing to do. */
export const HANGUP_TWIML = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>`;

/**
 * TwiML that hands the call to OpenAI's SIP address with custom SIP headers.
 * - `sipUri`: "sip:proj_...@sip.api.openai.com;transport=tls".
 * - `headers`: sent as `X-` headers on the INVITE (names must start with "X-"; values here are
 *   numbers and tokens, which need no escaping beyond URL encoding).
 * - `answerOnBridge`: an inbound caller hears ringing until Kritva's voice answers, instead of silence.
 * - `action`: where Twilio posts the dial's result (optional).
 */
export function dialSipTwiml(input: { sipUri: string; headers: Record<string, string | null | undefined>; timeLimitSeconds: number; answerOnBridge?: boolean; action?: string | null; callerId?: string | null }): string {
  const params = Object.entries(input.headers)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0)
    .map(([name, value]) => {
      if (!/^X-[\w-]+$/i.test(name)) throw new Error(`SIP header names must start with X-: ${name}`);
      return `${name}=${encodeURIComponent(value)}`;
    });
  const uri = params.length ? `${input.sipUri}?${params.join("&")}` : input.sipUri;
  const attrs = [`timeLimit="${Math.max(60, Math.round(input.timeLimitSeconds))}"`, input.answerOnBridge ? `answerOnBridge="true"` : "", input.callerId ? `callerId="${xmlEscape(input.callerId)}"` : "", input.action ? `action="${xmlEscape(input.action)}" method="POST"` : ""].filter(Boolean).join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial ${attrs}>
    <Sip>${xmlEscape(uri)}</Sip>
  </Dial>
</Response>`;
}

// ---------- Webhook signatures ----------

/**
 * Twilio's webhook signature: base64(HMAC-SHA1(auth token, URL + each POST field's name and value,
 * sorted by name)). The URL is the one Twilio requested, query string included, so the server
 * rebuilds it from KRITVA_PUBLIC_URL (a proxy or tunnel changes the host it sees).
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | null | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** What the routes need to check Twilio's webhooks: the auth token and the public base URL Twilio calls. */
export interface TwilioWebhookAuth {
  authToken: string;
  publicUrl: string;
}

type FormRequest = { req: { url: string; header(name: string): string | undefined; parseBody(): Promise<Record<string, unknown>> } };

/**
 * Reads a Twilio webhook's form fields and checks its signature. Without `auth` (tests, or a server
 * with no Twilio credentials) the fields are returned unchecked.
 */
export async function readTwilioWebhook(c: FormRequest, auth: TwilioWebhookAuth | null): Promise<{ ok: true; params: Record<string, string> } | { ok: false; url: string }> {
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) if (typeof value === "string") params[key] = value;
  if (!auth) return { ok: true, params };
  const seen = new URL(c.req.url);
  const url = `${auth.publicUrl.replace(/\/+$/, "")}${seen.pathname}${seen.search}`;
  return verifyTwilioSignature(auth.authToken, url, params, c.req.header("x-twilio-signature")) ? { ok: true, params } : { ok: false, url };
}

/**
 * Twilio's final call statuses mapped to why a call that never connected ended
 * (https://www.twilio.com/docs/voice/api/call-resource#call-status-values).
 */
export function unansweredOutcome(status: string | null): "busy" | "no_answer" | "failed" | "cancelled" {
  switch ((status ?? "").toLowerCase()) {
    case "busy":
      return "busy";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return "no_answer";
  }
}

/** Statuses after which Twilio sends nothing more for the call. */
export const FINAL_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);
