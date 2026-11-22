/**
 * Vobiz's call API, for outbound calls (docs/Kritva_Phone_Calls.md, "Outbound calls").
 *
 * Kritva places a call with Vobiz's Make Call API. When the person answers, Vobiz fetches the
 * answer URL, and Kritva's XML there bridges the call to OpenAI's SIP address, where it arrives as
 * an ordinary incoming realtime call. Ringing and hang-up are reported to the ring and hang-up URLs.
 * https://www.vobiz.ai/docs/call/make-call, https://www.vobiz.ai/docs/xml/dial
 */

export interface PlaceCall {
  /** Kritva's Vobiz number, E.164 ("+918064264194"). */
  from: string;
  /** The number to call, E.164. */
  to: string;
  answerUrl: string;
  ringUrl: string;
  hangupUrl: string;
  /** Longest the answered call may run, in seconds. */
  timeLimitSeconds: number;
}

/** The provider that places outbound calls. Tests pass a fake. */
export interface OutboundTelephony {
  /** Places the call; resolves with the provider's call ID once the provider has queued it (not answered). */
  placeCall(call: PlaceCall): Promise<{ providerCallId: string }>;
  /** Ends a call in any state. A call that already ended is not an error. */
  hangup(providerCallId: string): Promise<void>;
}

export class VobizError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Vobiz request failed (${status}): ${body.slice(0, 300)}`);
    this.status = status;
  }
}

export class VobizTelephony implements OutboundTelephony {
  readonly #authId: string;
  readonly #authToken: string;
  readonly #base: string;

  constructor(authId: string, authToken: string, base = "https://api.vobiz.ai/api/v1") {
    this.#authId = authId;
    this.#authToken = authToken;
    this.#base = base;
  }

  async placeCall(call: PlaceCall) {
    // The Account path segment is PascalCase and needs the trailing slash (Vobiz answers 401 otherwise).
    const res = await fetch(`${this.#base}/Account/${encodeURIComponent(this.#authId)}/Call/`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({
        from: call.from,
        to: call.to,
        answer_url: call.answerUrl,
        answer_method: "POST",
        ring_url: call.ringUrl,
        ring_method: "POST",
        hangup_url: call.hangupUrl,
        hangup_method: "POST",
        time_limit: call.timeLimitSeconds,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new VobizError(res.status, text);
    const body = JSON.parse(text) as { request_uuid?: string; call_uuid?: string };
    const providerCallId = body.request_uuid ?? body.call_uuid;
    if (!providerCallId) throw new VobizError(res.status, `no request_uuid in ${text}`);
    return { providerCallId };
  }

  async hangup(providerCallId: string) {
    const res = await fetch(`${this.#base}/Account/${encodeURIComponent(this.#authId)}/Call/${encodeURIComponent(providerCallId)}/`, { method: "DELETE", headers: this.#headers(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok && res.status !== 404) throw new VobizError(res.status, await res.text());
  }

  #headers() {
    return { "X-Auth-ID": this.#authId, "X-Auth-Token": this.#authToken, "Content-Type": "application/json" };
  }
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The answer XML: bridge the answered call to OpenAI's SIP address over TLS, tagged with the call's
 * token as a SIP header (Vobiz sends `sipHeaders` on the dialled leg, with its own `X-` prefix), so
 * the incoming-call webhook can tell which outbound call it is.
 */
export function bridgeXml(input: { callerId: string; sipUri: string; token: string; timeLimitSeconds: number }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${xmlEscape(input.callerId)}" timeout="30" timeLimit="${Math.round(input.timeLimitSeconds)}">
    <User sipHeaders="kritva_call=${xmlEscape(input.token)}">${xmlEscape(input.sipUri)}</User>
  </Dial>
</Response>`;
}
