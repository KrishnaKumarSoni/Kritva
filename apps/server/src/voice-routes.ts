/**
 * Epic 13 (browser voice) and Epic 14 (demo listing) routes.
 *
 * Voice is a channel, not a second agent: an utterance is transcribed and handed to the same
 * engine path as a typed message (channel "voice"), and only messages the engine recorded, which
 * passed the outgoing checks, can be turned into audio. Provider credentials stay on the server.
 */
import type { Hono } from "hono";
import type { ConfirmedMandate, DealGroups, MandateLibrary, NegotiationEngine, NegotiationRecord, PayloadOf, SpeechProvider } from "@kritva/core";
import { startNegotiation } from "./group-routes.ts";
import { formatValue, newEventId, readMandate } from "@kritva/core";
import type { ListingConfig } from "./main-helpers.ts";

export interface VoiceDeps {
  record: NegotiationRecord;
  engine: NegotiationEngine;
  speech: SpeechProvider | null;
  library: MandateLibrary | null;
  listings: ListingConfig[];
  locale: string;
  /** Several counterparties per saved mandate: a listing call joins the mandate's group. */
  groups?: DealGroups | null;
  /** Optional hint for transcription (kept with the case, never in the core). */
  transcriptionPrompt?: string;
  buyerOutcome: (sessionId: string) => Promise<unknown>;
}

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

type ListingError = { status: 404 | 409; body: { error: "not_found" | "listing_paused" | "mandate_missing"; message: string } };

/**
 * Whether a listing can take a call, and the confirmed mandate revision it uses. Shared by the
 * listing's "Call Seller" button and phone calls (src/phone/), so both follow the same rules:
 * a paused or closed listing, or one without a confirmed mandate, starts nothing.
 */
export function resolveListing(listings: ListingConfig[], library: MandateLibrary | null, caseId: string) {
  const fail = (status: ListingError["status"], error: ListingError["body"]["error"], message: string) => ({ error: { status, body: { error, message } } as ListingError });
  const listing = listings.find((l) => l.caseId === caseId);
  if (!listing) return fail(404, "not_found", "That listing doesn't exist.");
  const detail = library?.get(listing.libraryId) ?? null;
  if (detail && !detail.deleted && detail.state !== "live" && detail.state !== "draft") return fail(409, "listing_paused", `The seller has ${detail.state === "paused" ? "paused" : "closed"} this listing. No call was started.`);
  const active = library?.active(listing.libraryId) ?? null;
  if (!active) return fail(409, "mandate_missing", "This listing isn't set up yet: the seller's mandate is missing or not confirmed. No call was started.");
  return { listing, active };
}

function transcriptionContext(mandate: ConfirmedMandate): string {
  const currencies = new Set(mandate.terms.flatMap((term) => term.disclosure === "public" && term.currency ? [term.currency] : []));
  const labels = new Intl.DisplayNames(["en"], { type: "currency" });
  const expected = [...currencies].map((code) => `${labels.of(code)} (${code})`).join(", ");
  return [
    "Transcribe the speaker's words and values faithfully. Preserve any corrections and currency they actually say. Do not insert a currency for a bare number.",
    expected ? `Currencies used in these terms include ${expected}.` : null,
  ].filter(Boolean).join(" ");
}

export function registerVoiceRoutes(app: Hono, deps: VoiceDeps): void {
  const { record, engine, speech } = deps;
  const voiceOff = { error: "voice_unavailable", message: "Voice isn't available right now. You can keep typing instead." };

  /** Kritva's opening line for a call. Introduces itself once; offers nothing. */
  app.post("/api/buyer/sessions/:id/voice/start", async (c) => {
    if (!speech) return c.json(voiceOff, 503);
    const id = c.req.param("id");
    if (!(await record.getSession(id))) return c.json({ error: "session_not_found" }, 404);
    const afterSeq = (await record.context(id)).events.at(-1)?.seq ?? 0;
    const greeted = await engine.greet({ sessionId: id, channel: "voice" });
    if (!greeted.ok) return c.json({ error: greeted.code, message: greeted.code === "not_pending" ? "This negotiation isn't active, so there's nothing to say yet." : greeted.message }, 409);
    const connected = await record.append(id, { id: newEventId(), type: "voice_connection", channel: "voice", payload: { status: "connected" } }, { kind: "system", partyId: null });
    if (!connected.ok) return c.json({ error: connected.error.code, message: "Voice couldn't connect. You can keep typing." }, 503);
    return c.json({ afterSeq, reply: greeted.reply ? { messageId: greeted.reply.messageId, text: greeted.reply.text } : null, outcome: await deps.buyerOutcome(id) });
  });

  app.post("/api/buyer/sessions/:id/voice/interruption", async (c) => {
    const result = await record.append(c.req.param("id"), { id: newEventId(), type: "voice_connection", channel: "voice", payload: { status: "interrupted" } }, { kind: "system", partyId: null });
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error.code }, 409);
  });

  /** One completed buyer utterance → transcript → the text negotiation path. */
  app.post("/api/buyer/sessions/:id/voice/utterances", async (c) => {
    if (!speech) return c.json(voiceOff, 503);
    const id = c.req.param("id");
    const { mandate } = await record.context(id);
    if (!mandate) return c.json({ error: "session_not_found" }, 404);
    const clientId = c.req.query("clientMessageId") ?? "";
    if (!/^[\w-]{8,100}$/.test(clientId)) return c.json({ error: "invalid_message", message: "Missing message ID." }, 400);
    const mime = c.req.header("content-type") ?? "audio/wav";
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.byteLength < 1_000) return c.json({ error: "no_speech", message: "I didn't catch anything. Could you say that again?" }, 422);
    if (audio.byteLength > MAX_AUDIO_BYTES) return c.json({ error: "too_long", message: "That was a bit long for me. Could you say it in shorter parts?" }, 413);
    const started = performance.now();
    let transcript: { text: string; ms: number };
    try {
      transcript = await speech.transcribe(audio, mime, { prompt: deps.transcriptionPrompt ?? transcriptionContext(mandate) });
    } catch {
      // Nothing was understood, so nothing is recorded and nothing is said.
      return c.json({ error: "transcription_failed", message: "I couldn't hear that clearly. Nothing was sent. Could you say it again?" }, 503);
    }
    const text = transcript.text.trim();
    if (text.length < 2) return c.json({ error: "no_speech", message: "I didn't catch anything. Could you say that again?" }, 422);
    const result = await engine.handleCounterpartyMessage({ sessionId: id, text: text.slice(0, 2_000), channel: "voice", messageId: `msg_${clientId}`, utteranceId: clientId });
    if (!result.ok) return c.json({ error: result.code, message: result.message, transcript: text }, result.code === "session_not_found" ? 404 : result.code === "model_unavailable" ? 503 : 400);
    return c.json({
      transcript: text,
      reply: result.reply ? { messageId: result.reply.messageId, text: result.reply.text } : null,
      outcome: await deps.buyerOutcome(id),
      timings: { transcribeMs: transcript.ms, turnMs: result.timings.totalMs, serverMs: Math.round(performance.now() - started) },
    });
  });

  /** Audio for one recorded agent message. Arbitrary text can never be spoken through this route. */
  app.get("/api/buyer/sessions/:id/voice/speech/:messageId", async (c) => {
    if (!speech) return c.json(voiceOff, 503);
    const id = c.req.param("id");
    const ctx = await record.context(id);
    const message = ctx.byId.get(c.req.param("messageId"));
    const payload = message && ctx.payloadOf(message.id, "message");
    if (message?.channel !== "voice" || payload?.direction !== "outbound") return c.json({ error: "not_found" }, 404);
    if (payload.offerIds.length > 0 && (ctx.status === "paused" || ctx.events.some((e) => e.seq > message.seq && (e.type === "mandate_revised" || (e.type === "status_changed" && (e.payload as PayloadOf<"status_changed">).to === "paused"))))) {
      return c.json({ error: "reply_superseded" }, 409);
    }
    try {
      const audio = await speech.speak(payload.text);
      return new Response(audio.body, { headers: { "content-type": audio.contentType, "cache-control": "no-store" } });
    } catch {
      return c.json({ error: "speech_failed", message: "Kritva's voice couldn't play. The reply is shown in the chat." }, 503);
    }
  });

  // ---------- Epic 14: the demo listing ----------

  const resolve = (caseId: string) => resolveListing(deps.listings, deps.library, caseId);

  /** Public listing content only: the confirmed mandate's public terms and facts. */
  app.get("/api/public/listings/:caseId", (c) => {
    const r = resolve(c.req.param("caseId"));
    if ("error" in r) return c.json(r.error!.body, r.error!.status);
    const view = readMandate(r.active.mandate);
    const terms = view.defaultPackage.map((t) => ({ termId: t.termId, name: view.terms.get(t.termId)?.name ?? t.termId, value: formatValue(t.value, deps.locale) }));
    const priceTermId = view.negotiable?.termId;
    const price = terms.find((t) => t.termId === priceTermId)?.value ?? null;
    return c.json({ caseId: r.listing.caseId, title: r.listing.title, location: r.listing.location, price, terms: terms.filter((t) => t.termId !== priceTermId), facts: view.publicFacts, sellerRole: view.principalRole });
  });

  /**
   * "Call Seller": a fresh session under the listing's confirmed mandate revision (a reset of the
   * previous demo session when one is given). A repeated click with the same call ID returns the
   * same session, so a double click never creates two negotiations.
   */
  const calls = new Map<string, Promise<{ status: number; body: unknown }>>();
  app.post("/api/public/listings/:caseId/call", async (c) => {
    const body = await c.req.json<{ clientCallId?: string; previousSessionId?: string | null }>().catch(() => ({}) as Record<string, never>);
    const callId = typeof body.clientCallId === "string" && /^[\w-]{8,100}$/.test(body.clientCallId) ? body.clientCallId : null;
    if (!callId) return c.json({ error: "invalid_call", message: "Missing call ID." }, 400);
    const caseId = c.req.param("caseId");
    const key = `${caseId}:${callId}`;
    if (!calls.has(key)) {
      calls.set(
        key,
        (async () => {
          const r = resolve(caseId);
          if ("error" in r) return { status: r.error!.status, body: r.error!.body };
          const previous = typeof body.previousSessionId === "string" && (await record.getSession(body.previousSessionId)) ? body.previousSessionId : null;
          const started = await startNegotiation(deps.groups ?? null, record, { mandate: r.active.mandate, source: { mandateId: r.listing.libraryId, revision: r.active.revision }, via: "listing", previousSessionId: previous });
          if (!started.ok) return { status: started.status, body: { error: started.error, message: started.message } };
          return { status: 201, body: { sessionId: started.sessionId, mandateRevision: r.active.revision } };
        })(),
      );
    }
    const result = await calls.get(key)!;
    if (result.status >= 400) calls.delete(key);
    return c.json(result.body as object, result.status as 201);
  });
}
