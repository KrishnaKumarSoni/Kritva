/**
 * Phone calls on Vobiz with Sarvam speech (docs/Kritva_Phone_Calls.md, section 17).
 *
 *   Outbound: call({ sessionId, to })
 *     → Vobiz Make Call API (from Kritva's number)                      state: dialling
 *     → ring_url                                                          state: ringing
 *     → they answer; answer_url returns <Stream> to wss://…/api/phone/vobiz/stream?t=<token>
 *                                                                         state: answered
 *     → the media stream opens; a StreamCall runs the negotiation         state: connected
 *     → hangup_url, or the stream closing                                 state: ended, with an outcome
 *   Inbound: Kritva's Vobiz number's application posts answer_url without a token; the call starts a
 *   negotiation under KRITVA_VOBIZ_INBOUND (a listing or a saved mandate) and streams the same way.
 *
 * Every webhook's X-Vobiz-Signature-V3 is checked. The media stream's handshake carries no
 * credentials, so its URL holds a one-time token issued in the answer XML. Numbers live only in
 * memory and are masked in logs and views; the record gets voice_connection events, never a number.
 */
import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import type { DealGroups, MandateLibrary, NegotiationEngine, NegotiationRecord } from "@kritva/core";
import { startNegotiation, type CallView, type Dialer } from "../group-routes.ts";
import type { LiveCalls } from "../live-calls.ts";
import type { ListingConfig } from "../main-helpers.ts";
import type { RealtimeCall } from "../realtime-voice.ts";
import { resolveListing } from "../voice-routes.ts";
import { normalizeNumber } from "./config.ts";
import type { PhoneSpeech } from "./sarvam.ts";
import { maskNumber } from "./sip-headers.ts";
import { StreamCall, type CallSocket } from "./stream-call.ts";
import { hangupXml, streamXml, vobizSignatureValid, type VobizCalls, type VobizSettings } from "./vobiz.ts";

export const VOBIZ_STREAM_PATH = "/api/phone/vobiz/stream";

type State = CallView["state"];
type Outcome = NonNullable<CallView["outcome"]>;

interface Call {
  callId: string;
  token: string;
  sessionId: string;
  direction: "inbound" | "outbound";
  /** The counterparty's number (digits). */
  number: string | null;
  state: State;
  outcome: Outcome | null;
  callUuid: string | null;
  startedAt: Date;
  answeredAt: Date | null;
  connectedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  stream: StreamCall | null;
}

export interface VobizPhoneDeps {
  engine: NegotiationEngine;
  record: NegotiationRecord;
  library: MandateLibrary | null;
  listings: ListingConfig[];
  groups: DealGroups | null;
  liveCalls: LiveCalls | null;
  settings: VobizSettings;
  speech: PhoneSpeech;
  api: VobizCalls;
  log?: (entry: Record<string, unknown>) => void;
  /** Whether a number is on one of the principal's counterparty lists (board calls on): such numbers may be called too. */
  isListed?: (to: string) => boolean;
  /** Loudness that counts as speech on the line (KRITVA_VOBIZ_VAD_THRESHOLD). */
  vadThreshold?: number;
}

export class VobizPhone implements Dialer {
  readonly #d: VobizPhoneDeps;
  readonly #calls = new Map<string, Call>();
  readonly #byToken = new Map<string, Call>();
  readonly #byRequest = new Map<string, Promise<CallResult>>();

  constructor(deps: VobizPhoneDeps) {
    this.#d = deps;
  }

  get settings(): VobizSettings {
    return this.#d.settings;
  }

  // ---------- Dialer (the console and the deal board) ----------

  canDial(rawTo: string): { ok: true } | { ok: false; code: string; message: string } {
    const s = this.#d.settings;
    const to = normalizeNumber(rawTo ?? "", s.countryCode);
    if (!/^\d{10,15}$/.test(to)) return { ok: false, code: "invalid_number", message: "That doesn't look like a phone number. Use the full number, for example +91 98765 43210." };
    if (!s.allow.includes("*") && !s.allow.includes(to) && !this.#d.isListed?.(to)) return { ok: false, code: "not_allowed", message: "Calling this number isn't allowed yet. Add it to KRITVA_PHONE_OUTBOUND_ALLOW once calling it is approved." };
    return { ok: true };
  }

  /** Places a call for a session. A repeated clientRequestId returns the first call, so a double click calls once. */
  call(input: { sessionId: string; to: string; clientRequestId?: string | null }): Promise<CallResult> {
    const key = input.clientRequestId ? `${input.sessionId}:${input.clientRequestId}` : null;
    if (key && this.#byRequest.has(key)) return this.#byRequest.get(key)!;
    const result = this.#place(input.sessionId, input.to);
    if (key) {
      this.#byRequest.set(key, result);
      void result.then((r) => {
        if (!r.ok) this.#byRequest.delete(key);
      });
    }
    return result;
  }

  listForSession(sessionId: string): CallView[] {
    return [...this.#calls.values()].filter((c) => c.sessionId === sessionId).map(view);
  }

  get(callId: string): CallView | null {
    const call = this.#calls.get(callId);
    return call ? view(call) : null;
  }

  /** Ends a call in any state. False when it was not in progress. */
  async hangup(callId: string): Promise<boolean> {
    const call = this.#calls.get(callId);
    if (!call || call.state === "ended") return false;
    if (call.stream) await call.stream.end("server");
    else if (call.callUuid) await this.#d.api.hangup(call.callUuid).catch((error) => this.#log({ kind: "vobiz_hangup_failed", callId, error: String(error).slice(0, 200) }));
    this.#end(call, call.connectedAt ? "completed" : "cancelled", "Kritva hung up.");
    return true;
  }

  async #place(sessionId: string, rawTo: string): Promise<CallResult> {
    const s = this.#d.settings;
    const dialable = this.canDial(rawTo);
    if (!dialable.ok) return dialable;
    const briefing = await this.#d.engine.voiceBriefing(sessionId);
    if (!briefing || briefing.status !== "active") return { ok: false, code: "session_not_active", message: "This negotiation isn't active, so Kritva can't call about it." };
    if (this.#lines() >= s.maxCalls) return { ok: false, code: "busy", message: `Kritva is already on ${s.maxCalls} calls. Try again when one ends.` };
    const call = this.#newCall(sessionId, "outbound", normalizeNumber(rawTo, s.countryCode));
    call.state = "dialling";
    const base = s.publicUrl.replace(/\/+$/, "");
    try {
      const placed = await this.#d.api.placeCall({
        from: `+${s.number}`,
        to: `+${call.number}`,
        answerUrl: `${base}/api/phone/vobiz/answer?t=${call.token}`,
        ringUrl: `${base}/api/phone/vobiz/ring?t=${call.token}`,
        hangupUrl: `${base}/api/phone/vobiz/hangup?t=${call.token}`,
        timeLimitSeconds: Math.round(s.maxCallMs / 1000) + 30,
      });
      call.callUuid = placed.callUuid;
    } catch (error) {
      this.#end(call, "failed", `provider: ${String(error).slice(0, 200)}`);
      return { ok: false, code: "provider_error", message: "The call couldn't be placed. Nothing was dialled." };
    }
    this.#log({ kind: "vobiz_outbound_placed", callId: call.callId, sessionId, to: maskNumber(call.number), callUuid: call.callUuid });
    return { ok: true, call: view(call) };
  }

  // ---------- Webhooks and the media stream ----------

  register(app: Hono): void {
    const s = this.#d.settings;
    const signed = (c: Context) => !s.verify || vobizSignatureValid({ publicUrl: s.publicUrl, requestUrl: c.req.url, authToken: s.authToken, header: (name) => c.req.header(name) });
    const form = async (c: Context) => Object.fromEntries(Object.entries(await c.req.parseBody().catch(() => ({}))).map(([k, v]) => [k, String(v)]));
    const xml = (c: Context, body: string) => c.body(body, 200, { "Content-Type": "application/xml" });

    /** Vobiz asks what to do with an answered call (Kritva's own) or a new incoming one. */
    app.post("/api/phone/vobiz/answer", async (c) => {
      if (!signed(c)) {
        this.#log({ kind: "vobiz_signature_mismatch", route: "answer" });
        return c.text("bad signature", 403);
      }
      const params = await form(c);
      const token = c.req.query("t");
      let call: Call | null = null;
      if (token) {
        call = this.#byToken.get(token) ?? null;
        if (!call || call.state === "ended") {
          this.#log({ kind: "vobiz_answer_unknown", callUuid: params.CallUUID ?? null });
          return xml(c, hangupXml);
        }
        call.state = "answered";
        call.answeredAt = new Date();
        call.callUuid ??= params.CallUUID ?? null;
      } else {
        call = await this.#inbound(params);
        if (!call) return xml(c, hangupXml);
      }
      const streamUrl = `${s.publicUrl.replace(/^http/, "ws").replace(/\/+$/, "")}${VOBIZ_STREAM_PATH}?t=${call.token}`;
      this.#log({ kind: "vobiz_answered", callId: call.callId, direction: call.direction, sessionId: call.sessionId });
      return xml(c, streamXml(streamUrl, s.maxCallMs / 1000 + 60));
    });

    app.post("/api/phone/vobiz/ring", async (c) => {
      if (!signed(c)) return c.text("bad signature", 403);
      const call = this.#byToken.get(c.req.query("t") ?? "");
      if (call && (call.state === "dialling" || call.state === "queued")) call.state = "ringing";
      return c.json({ ok: true });
    });

    /** The authoritative end of a call, whoever ended it. */
    app.post("/api/phone/vobiz/hangup", async (c) => {
      if (!signed(c)) return c.text("bad signature", 403);
      const params = await form(c);
      const call = this.#byToken.get(c.req.query("t") ?? "") ?? [...this.#calls.values()].find((x) => x.callUuid && x.callUuid === params.CallUUID) ?? null;
      this.#log({ kind: "vobiz_hangup", callId: call?.callId ?? null, status: params.CallStatus ?? null, cause: params.HangupCause ?? params.HangupCauseName ?? null });
      if (call && call.state !== "ended") {
        if (call.stream) await call.stream.end("hung_up", { hangUp: false });
        this.#end(call, outcomeOf(call, params), params.HangupCause ?? params.HangupCauseName ?? null);
      }
      return c.json({ ok: true });
    });

    // The stream itself is a WebSocket, opened by the host (apps/worker); here it can only be refused.
    app.get(VOBIZ_STREAM_PATH, (c) => c.json({ error: "upgrade_required", message: "The media stream is a WebSocket, served on Cloudflare." }, 426));

    // ---------- Operator: place and follow calls (the same routes and shapes as before) ----------
    app.post("/api/operator/sessions/:id/calls", async (c) => {
      const body = await c.req.json<{ to?: string; clientRequestId?: string }>().catch(() => ({}) as { to?: string; clientRequestId?: string });
      const clientRequestId = typeof body.clientRequestId === "string" && /^[\w-]{8,100}$/.test(body.clientRequestId) ? body.clientRequestId : null;
      const result = await this.call({ sessionId: c.req.param("id"), to: String(body.to ?? ""), clientRequestId });
      if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "invalid_number" ? 400 : result.code === "provider_error" ? 502 : 409);
      return c.json(result.call, 202);
    });
    app.get("/api/operator/sessions/:id/calls", (c) => c.json(this.listForSession(c.req.param("id"))));
    app.get("/api/operator/calls/:callId", (c) => {
      const call = this.get(c.req.param("callId"));
      return call ? c.json(call) : c.json({ error: "not_found" }, 404);
    });
    app.post("/api/operator/calls/:callId/hangup", async (c) => {
      const ended = await this.hangup(c.req.param("callId"));
      return ended ? c.json(this.get(c.req.param("callId"))) : c.json({ error: "not_active", message: "That call isn't in progress." }, 409);
    });
    app.get("/api/operator/phone", (c) =>
      c.json({
        enabled: true,
        provider: "vobiz",
        speech: "sarvam",
        routes: s.inbound ? [{ number: `+${s.number}`, target: s.inbound }] : [],
        line: { number: `+${s.number}`, listingCodes: false },
        limits: { idleSeconds: s.idleMs / 1000, maxMinutes: s.maxCallMs / 60_000, maxCalls: s.maxCalls },
        outbound: { callerId: `+${s.number}`, allow: s.allow.map((n) => (n === "*" ? "*" : maskNumber(n))) },
        calls: [...this.#calls.values()].filter((x) => x.state !== "ended").map((x) => ({ callId: x.callId, sessionId: x.sessionId, startedAt: x.startedAt.toISOString() })),
        frontDesk: [],
      }),
    );
  }

  /**
   * The media stream for a call, opened by Vobiz with the token from the answer XML. Returns the
   * handlers for the socket's messages and close, or null to refuse the upgrade.
   */
  acceptStream(token: string | null, socket: CallSocket): { message(raw: string): void; closed(): void } | null {
    const call = token ? this.#byToken.get(token) : undefined;
    if (!call || call.state === "ended" || call.stream) {
      this.#log({ kind: "vobiz_stream_refused", known: Boolean(call) });
      return null;
    }
    const stream = new StreamCall({
      engine: this.#d.engine,
      record: this.#d.record,
      sessionId: call.sessionId,
      speech: this.#d.speech,
      socket,
      direction: call.direction,
      settings: { idleMs: this.#d.settings.idleMs, maxCallMs: this.#d.settings.maxCallMs },
      contactNumber: call.number,
      log: (entry) => this.#log({ callId: call.callId, ...entry }),
      vad: this.#d.vadThreshold ? { threshold: this.#d.vadThreshold } : undefined,
      onConnected: () => {
        call.state = "connected";
        call.connectedAt = new Date();
        this.#d.liveCalls?.register(call.sessionId, stream as unknown as RealtimeCall, call.number);
      },
      onEnded: (reason) => {
        this.#d.liveCalls?.unregister(call.sessionId, stream as unknown as RealtimeCall);
        this.#end(call, "completed", reason);
      },
    });
    call.stream = stream;
    return { message: (raw) => void stream.message(raw).catch((error) => this.#log({ kind: "vobiz_stream_error", error: String(error).slice(0, 300) })), closed: () => stream.closedByLine() };
  }

  async #inbound(params: Record<string, string>): Promise<Call | null> {
    const s = this.#d.settings;
    const from = params.From ? normalizeNumber(params.From, s.countryCode) : null;
    if (!s.inbound) {
      this.#log({ kind: "vobiz_inbound_declined", reason: "inbound_off", from: maskNumber(from) });
      return null;
    }
    if (this.#lines() >= s.maxCalls) {
      this.#log({ kind: "vobiz_inbound_declined", reason: "busy", from: maskNumber(from) });
      return null;
    }
    const target = s.inbound;
    let mandate, source;
    if (target.kind === "listing") {
      const r = resolveListing(this.#d.listings, this.#d.library, target.caseId);
      if ("error" in r) {
        this.#log({ kind: "vobiz_inbound_declined", reason: r.error!.body.error });
        return null;
      }
      mandate = r.active.mandate;
      source = { mandateId: r.listing.libraryId, revision: r.active.revision };
    } else {
      const detail = this.#d.library?.get(target.mandateId) ?? null;
      const active = detail && !detail.deleted && detail.state === "live" ? this.#d.library!.active(target.mandateId) : null;
      if (!active) {
        this.#log({ kind: "vobiz_inbound_declined", reason: "mandate_not_live" });
        return null;
      }
      mandate = active.mandate;
      source = { mandateId: target.mandateId, revision: active.revision };
    }
    const started = await startNegotiation(this.#d.groups, this.#d.record, { mandate, source, via: "phone" });
    if (!started.ok) {
      this.#log({ kind: "vobiz_inbound_declined", reason: started.error });
      return null;
    }
    const call = this.#newCall(started.sessionId, "inbound", from);
    call.state = "answered";
    call.answeredAt = new Date();
    call.callUuid = params.CallUUID ?? null;
    this.#log({ kind: "vobiz_inbound", callId: call.callId, sessionId: call.sessionId, from: maskNumber(from) });
    return call;
  }

  #newCall(sessionId: string, direction: Call["direction"], number: string | null): Call {
    // Calls that ended hours ago are forgotten here, not by a timer: a pending timer would keep the server object in memory.
    const old = Date.now() - 6 * 3_600_000;
    for (const ended of [...this.#calls.values()].filter((c) => c.endedAt && c.endedAt.getTime() < old)) {
      this.#calls.delete(ended.callId);
      this.#byToken.delete(ended.token);
    }
    const call: Call = { callId: `vc_${randomBytes(9).toString("base64url")}`, token: randomBytes(18).toString("base64url"), sessionId, direction, number, state: "queued", outcome: null, callUuid: null, startedAt: new Date(), answeredAt: null, connectedAt: null, endedAt: null, endReason: null, stream: null };
    this.#calls.set(call.callId, call);
    this.#byToken.set(call.token, call);
    return call;
  }

  #lines(): number {
    return [...this.#calls.values()].filter((c) => c.state !== "ended" && c.state !== "queued").length;
  }

  #end(call: Call, outcome: Outcome, reason: string | null) {
    if (call.state === "ended") return;
    call.state = "ended";
    call.outcome = outcome;
    call.endedAt = new Date();
    call.endReason = reason;
    call.stream = null;
    this.#log({ kind: "vobiz_call_over", callId: call.callId, direction: call.direction, outcome, reason });
  }

  #log(entry: Record<string, unknown>) {
    this.#d.log?.(entry);
  }
}

type CallResult = { ok: true; call: CallView } | { ok: false; code: string; message: string };

function view(call: Call): CallView {
  return {
    callId: call.callId,
    sessionId: call.sessionId,
    to: maskNumber(call.number) ?? "unknown",
    state: call.state,
    outcome: call.outcome,
    startedAt: call.startedAt.toISOString(),
    answeredAt: call.answeredAt?.toISOString() ?? null,
    connectedAt: call.connectedAt?.toISOString() ?? null,
    endedAt: call.endedAt?.toISOString() ?? null,
    endReason: call.endReason,
  };
}

/** How a call that ended before (or without) a stream went, from Vobiz's hangup fields. */
function outcomeOf(call: Call, params: Record<string, string>): Outcome {
  if (call.connectedAt) return "completed";
  const said = `${params.CallStatus ?? ""} ${params.HangupCause ?? ""} ${params.HangupCauseName ?? ""}`.toLowerCase();
  if (/busy/.test(said)) return "busy";
  if (/no.?answer|timeout|not.?answered|unanswered/.test(said)) return "no_answer";
  if (/cancel/.test(said)) return "cancelled";
  if (/reject|fail|invalid|unallocated|congestion/.test(said)) return "failed";
  return call.answeredAt ? "completed" : "no_answer";
}
