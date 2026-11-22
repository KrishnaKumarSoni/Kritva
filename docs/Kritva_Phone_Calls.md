# Kritva phone calls

Engineering design and setup for taking real phone calls with Kritva's realtime voice, through a Vobiz SIP trunk into OpenAI's realtime SIP endpoint. Written 2026-11-22. The browser call this builds on is described in `docs/Kritva_Realtime_Voice.md`; read that first.

Interaction design (what Kritva says when, how a declined call sounds, whether a call ends itself after a deal) is deliberately left open. Where this document makes a placeholder choice, it says so (section 12).

## 1. What it does

A buyer dials a Vobiz number. The call reaches Kritva's realtime voice, which talks with them exactly as in a browser call: the realtime model is Kritva's ears and voice, the negotiation engine decides every deal move, and every reply is checked and recorded. The seller sees the call in the console as a voice session.

```
Caller → Vobiz DID → Vobiz inbound SIP trunk (TLS signalling, SRTP audio)
       → OpenAI SIP, India edge: sip:proj_...@sip-in.api.openai.com:5061
                │  webhook: realtime.call.incoming
                ▼
Kritva server  POST /api/webhooks/openai
  verify signature → route the dialled number → start a session → accept the call
  → join it over the sideband WebSocket → PhoneCall: RealtimeCall + server-side delivery
```

Audio never passes through Kritva's server. Vobiz and OpenAI exchange it directly; the server answers the webhook, controls the call over REST and handles its events over the sideband WebSocket, as it already does for a browser call.

## 2. What stays exactly as it is

- **The engine decides every move**, through the same `negotiate` tool and `engine.handleCounterpartyMessage`. Nothing in the engine's negotiation logic changed.
- **The call controller** (`RealtimeCall` in `apps/server/src/realtime-voice.ts`) is reused unchanged: routing of conversation and deal turns, verbatim speech, the checks on the voice model's own words, corrections, and engine-initiated messages. It gained two read-only getters (`language`, `textOf`).
- **Session settings**: a phone call is accepted with the same `realtimeSession(...)` as a browser call (model, instructions, tools, language hints, semantic turn-taking, reasoning). Only noise reduction is the phone's own setting, and no audio format is set (SIP negotiates the codec).
- **Listing rules**: a phone call checks a listing with the same function as the listing's "Call Seller" button (`resolveListing` in `voice-routes.ts`).
- **Delivery rule**: an offer counts only once heard in full; an interruption records the approximate part heard.

## 3. How a call works

1. **Ring.** Vobiz sends the call's SIP INVITE to OpenAI. OpenAI posts `realtime.call.incoming` to the project's webhook, with the call ID and the INVITE's SIP headers.
2. **Verify.** The server checks the Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`; HMAC-SHA256 with the `whsec_` secret; five-minute window). An unsigned or altered request gets 400 and nothing happens. Other event types, and the dashboard's empty test event, get 200 and are ignored.
3. **Route.** The dialled number is read from the SIP headers (section 4) and matched to `KRITVA_PHONE_ROUTES`. The route names a listing or a saved mandate.
4. **Check and start.** The listing (or mandate) must be live with a confirmed mandate, and fewer than `KRITVA_PHONE_MAX_CALLS` calls may be in progress. A new negotiation session starts under the confirmed revision, recording its source, as "Call Seller" does.
5. **Accept.** `POST /v1/realtime/calls/{call_id}/accept` with the flat session body. The webhook answers 200 once the accept succeeds.
6. **Join and run.** The server opens `wss://api.openai.com/v1/realtime?call_id=...` and starts a `PhoneCall`, which records `voice_connection` (connected, transport phone) and greets: the engine writes the opening line and the voice speaks it word for word. From here every turn works as in a browser call.
7. **End.** The caller hanging up closes the sideband. A long silence or the time limit makes Kritva say a closing line and hang up. Either way the call is hung up at OpenAI, anything still playing is recorded interrupted, and `voice_connection` (ended, with the reason) closes the call in the record.

A retried webhook for the same call answers it once. A failed accept is retried twice within the webhook (after 0.3 s and 0.9 s; each attempt times out after 4 s). OpenAI answers an accept for a call that no longer exists with 503 and an empty body (measured on 2026-11-22), the same as an outage, so a 503 is always retried and only a 404 is final. If the accept still fails, the server hangs the call up, in case an accept went through unseen and left the caller with an unsupervised voice. It then acknowledges the webhook with 200, because a webhook retry would come after the caller stopped waiting. A webhook that fails inside Kritva gets 500, and OpenAI's retry reuses the session already started.

## 4. Which number was dialled

OpenAI passes the INVITE's headers as untrusted `{ name, value }` pairs. Vobiz does not document which header carries the dialled number, so the server looks in the usual places, most specific first, and takes the first number that has a route:

1. a provider header whose name mentions the DID, called, dialled, destination or original-to number (for example `X-...-DID`);
2. `To`, then `P-Called-Party-ID`, `Diversion` and `History-Info`.

Numbers are compared as digits with the country code (`+91 80 7123 4567`, `080 7123 4567` and `8071234567` are the same number). A `*` route takes every call no other route matched, which also covers a provider that rewrites the headers. Every incoming call is logged with the header names it carried and the numbers found, so the first real call shows exactly what Vobiz sends. The caller's number is only ever logged masked (`91******3210`) and is not recorded in the negotiation.

## 5. When a call is declined

The call is rejected at OpenAI with a SIP status, so the caller hears their network's tone or message, and no session starts:

| SIP | When |
|---|---|
| 404 | The dialled number has no route (and there is no `*` route). |
| 480 | The listing is paused or closed, its mandate is missing or not confirmed, or a routed saved mandate is not live. |
| 486 | `KRITVA_PHONE_MAX_CALLS` calls are already in progress. |
| 500 | A session could not be started. |

## 6. Delivery without a browser

In a browser call the page hears its own audio and reports each reply as finished or cut off. A phone call has no page, so the server decides from the call's events (`apps/server/src/phone/playback.ts`, `ServerPlayback`). It reports exactly what the browser would, one report per recorded message Kritva speaks, through `engine.reportDelivery`.

**The rule.** When the evidence is unclear, a reply is reported interrupted, never delivered.

1. **Playback events decide when OpenAI sends them.** OpenAI documents them for WebRTC and SIP calls.
   - `output_audio_buffer.started`: the reply's audio began playing to the caller.
   - `output_audio_buffer.stopped`: it played to the end. **Delivered.**
   - `output_audio_buffer.cleared`, or `response.done` with any status other than "completed" (the caller talked over it, or the audio was cleared): **interrupted.**
   - A reply that started but reports no end within twice its expected length plus 10 s: **interrupted.**
2. **Timing decides only while a call has shown no playback events at all**, a fallback in case the sideband does not carry them. The reply's audio starts with its first audio or transcript event and is expected to last its length at 11 characters a second plus 1 s. Speech runs at about 14 a second, so this window outlasts the real audio.
   - The caller starts speaking (`input_audio_buffer.speech_started`) inside the window: **interrupted.**
   - The window passes with no speech and the response completed: **delivered.**
3. **The call ending** (hang-up, silence, time limit) while a reply is playing or queued: **interrupted.**

**The part heard.** On WebRTC and SIP calls OpenAI trims unplayed audio itself and reports how much played (`conversation.item.truncated`, `audio_end_ms`). Without that, the time since the audio started is used. Either becomes characters at 14 a second, cut back to a whole word, as the browser does. A reply cut before any audio played was heard as "".

`audioStartMs`, the time from the end of their speech to the start of the reply's audio, is reported as the browser reports it. Each call's end is logged with `deliveryFrom` ("playback_events" or "estimate"), so it is clear which path decided.

## 7. Silence, time limit and the end of a call

- **Silence.** After `KRITVA_PHONE_IDLE_SECONDS` (default 30) with nothing said, decided or played, Kritva asks whether they are still there. After the same again, it says goodbye, waits for that line to be heard (at most 15 s) and hangs up. Anything the caller says resets the timer and the check. The realtime model's own idle timeout only works with `server_vad`, and Kritva uses `semantic_vad`, so the server keeps this timer.
- **Time limit.** At `KRITVA_PHONE_MAX_MINUTES` (default 15) Kritva lets a deal turn in progress finish (up to 20 s), says a closing line and hangs up.
- **Hang-up.** OpenAI's sideband "lives for the life of the SIP call", so its closing means the caller hung up or the line dropped (the two look the same, reason `hung_up`). Kritva also calls `/hangup` in that case, so a call can never stay connected to a voice nobody supervises; a call that is already gone answers 404, which is expected.
- **The record.** `voice_connection` gained `status: "ended"`, `transport` ("browser" or "phone") and `reason` (`hung_up`, `idle`, `max_duration`, `server`, `error`). Older events read as before. The console shows "Phone call connected" and "Phone call ended" with the reason, and its "voice interrupted" flag still finds a reply cut off by a hang-up.

The lines Kritva says itself here (still there, goodbye, time up) are recorded through `engine.recordVoiceLine`, pass the same outgoing check as every voice line, and exist in English, Hindi and Tamil.

## 8. Configuration

Phone calls are on when `OPENAI_API_KEY` is set with realtime voice on (`KRITVA_VOICE_MODE` unset or `realtime`) and both `OPENAI_WEBHOOK_SECRET` and `KRITVA_PHONE_ROUTES` are set. The server prints whether they are on, and why not.

| Setting | Default | Meaning |
|---|---|---|
| `OPENAI_WEBHOOK_SECRET` | (required) | The project webhook's signing secret, `whsec_...`. |
| `KRITVA_PHONE_ROUTES` | (required) | `number=target` pairs, comma-separated. Target: a listing's case ID (`bed-sale` or `listing:bed-sale`) or a saved mandate (`mandate:man_...`). `*` matches any number. Example: `+918071234567=bed-sale`. |
| `OPENAI_PROJECT_ID` | (none) | `proj_...`; only used to print the SIP URI for the trunk. |
| `KRITVA_PHONE_SIP_HOST` | `sip-in.api.openai.com` | OpenAI's SIP host; the India edge by default. |
| `KRITVA_PHONE_NOISE_REDUCTION` | `near_field` | `near_field` (a handset held to the ear), `far_field` (speakerphone or a room) or `off`. |
| `KRITVA_PHONE_IDLE_SECONDS` | `30` | Silence before the "still there?" check, and again before hanging up (10 to 300). |
| `KRITVA_PHONE_MAX_MINUTES` | `15` | Longest call (1 to 120). |
| `KRITVA_PHONE_MAX_CALLS` | `5` | Calls at once; more are declined as busy. Keep the Vobiz trunk's concurrent-call limit at least this high. |
| `KRITVA_PHONE_COUNTRY_CODE` | `91` | Assumed for numbers written without one. |

The realtime settings (`KRITVA_REALTIME_*`, `KRITVA_VOICE_LANGUAGES`) apply to phone calls too.

## 9. Setup (steps that need your accounts)

These steps use your OpenAI and Vobiz accounts and cost money (a Vobiz number and per-minute charges), so they are yours to do. The code needs nothing else.

### 9.1 OpenAI

1. Use the same OpenAI project as `OPENAI_API_KEY`. In the platform's project settings, copy the **Project ID** (`proj_...`) into `.env` as `OPENAI_PROJECT_ID`.
2. In the project's **Webhooks** settings, create a webhook:
   - URL: `https://<public host>/api/webhooks/openai` (section 9.3 gives a public host for local testing);
   - event: `realtime.call.incoming`.
3. Copy its signing secret (shown once) into `.env` as `OPENAI_WEBHOOK_SECRET`.

### 9.2 Vobiz

In the Vobiz console (console.vobiz.ai), following Vobiz's OpenAI guide (https://www.vobiz.ai/docs/integrations/openai-realtime):

1. **Number.** Rent an Indian DID under Phone Numbers.
2. **Origination URI** (SIP → Inbound → Origination URIs): URI `proj_YOUR_PROJECT_ID@sip-in.api.openai.com:5061`, transport **TLS**, active. The `:5061` is required: without it Vobiz dials port 5060 and the call is refused (the CDR shows `send_refuse`). Transport can only be chosen in the console, not through Vobiz's API.
3. **Trunk** (SIP → Inbound → Trunks): direction inbound, the origination URI above, transport TLS, **Secure (SRTP) on**, enabled. Without SRTP the call connects and bills but has no audio. Set the concurrent-call limit to at least `KRITVA_PHONE_MAX_CALLS`.
4. **Assign the number** to the trunk.
5. Put the number in `.env`: `KRITVA_PHONE_ROUTES=+91XXXXXXXXXX=bed-sale`.

`node --env-file=.env apps/server/scripts/phone-check.ts` prints the exact origination URI from your settings.

Vobiz's guide lists OpenAI's global host (`sip.api.openai.com`) and its EU host; OpenAI's own guide adds the India edge used here. If calls fail at the SIP stage with the India edge, set `KRITVA_PHONE_SIP_HOST=sip.api.openai.com` and the origination URI to match (the global host is GeoIP-routed).

### 9.3 A public URL for local testing

OpenAI must reach the webhook over HTTPS. Both tunnels are installed on this Mac; the server listens on port 8787.

```bash
cloudflared tunnel --url http://localhost:8787
```

It prints `https://<random>.trycloudflare.com`; that host changes on every run, so update the OpenAI webhook URL each time. `ngrok http 8787` works the same way, with a fixed domain on a paid plan.

### 9.4 Run and check

1. Start the server: `npm run dev -w @kritva/server`. It prints `Phone calls: on`, the SIP URI and the webhook path.
2. Check the tunnel and the secret:

   ```bash
   node --env-file=.env apps/server/scripts/phone-check.ts --url https://<random>.trycloudflare.com
   ```

   Expect `200`. A 400 means the secret differs between the script's `.env` and the server; a 404 means phone calls are off on that server. Adding `--ring +91XXXXXXXXXX` sends a made-up call to that number: the server routes it, starts a session and tries to answer, and OpenAI refuses because the call does not exist. Expect `200` with `"error":"accept_failed"` for a routed number, or `"rejected":404` for one with no route. The server log shows the `phone_incoming` line with the route, and one empty session is left in the record.
3. Call the number. In the server log (`[phone]` lines), check:
   - `phone_incoming`: `dialled` has your number and `route` is set. If `dialled` is empty, Vobiz did not put the number in a header Kritva reads; `headerNames` shows what it sent. Add `*=bed-sale` as a route, or a header rule in `sip-headers.ts`.
   - `phone_delivery` for the greeting, and `phone_ended` with `deliveryFrom: "playback_events"`. If it says `"estimate"`, the sideband did not carry playback events and the timing fallback decided (safe, but stricter).
4. The seller console shows the session, with "Phone call connected" and, after hanging up, "Phone call ended".

### 9.5 Troubleshooting

| Symptom | Likely cause |
|---|---|
| Call refused at the carrier, CDR `send_refuse` | `:5061` missing from the origination URI. |
| Call connects and bills, but no audio | Trunk Secure (SRTP) off. |
| No webhook arrives | The project ID in the URI is not the webhook's project, the number is not assigned to the trunk, or the tunnel URL changed. |
| Webhook answered 400 | Wrong `OPENAI_WEBHOOK_SECRET`, or the server's clock is more than five minutes off. |
| Caller hears a busy or unavailable tone | Declined on purpose: see section 5 and the `phone_rejected` log line. |
| Call drops right after it is answered | `phone_attach_failed`: the sideband could not open (API key or network). The call is hung up at once. |

## 10. Latency and deployment

- **Audio** goes caller → Vobiz (Mumbai origination in Vobiz's CDRs) → OpenAI's India SIP edge → the realtime model. Kritva's server is not in that path.
- **Control** (the webhook, accept, the sideband and the engine's own model calls) goes between Kritva's server and `api.openai.com`. Deal turns wait on this path, so deploy the server close to it and to the users. With the target users in Bangalore, AWS `ap-south-1` (Mumbai) is the natural region; measure `api.openai.com` round trips from there before deciding.
- The webhook must answer within a few seconds. It does local work (a session start) and one accept call before answering; the join and greeting run after it.
- Cost per minute is the browser call's realtime cost (`docs/Kritva_Realtime_Voice.md`, section 8) plus Vobiz's per-minute charge and number rental.

## 11. Code map

| File | What it holds |
|---|---|
| `apps/server/src/phone/routes.ts` | The webhook route, routing to a listing or mandate, decline codes, accept, join, the call registry, `GET /api/operator/phone` (setup values and calls in progress, no secrets) and `phoneFromEnv` for `main.ts`. |
| `apps/server/src/phone/phone-call.ts` | `PhoneCall`: wraps `RealtimeCall`, feeds `ServerPlayback`, the silence and time-limit timers, hang-up and the call-end record, and the lines it says itself. |
| `apps/server/src/phone/playback.ts` | `ServerPlayback`: the delivery rule of section 6. Pure, with an injectable clock. |
| `apps/server/src/phone/sip-headers.ts` | Reading the dialled and calling numbers from SIP headers; masking numbers for logs. |
| `apps/server/src/phone/config.ts` | Settings from the environment, number routes, the SIP URI. |
| `apps/server/src/phone/webhook-signature.ts` | Standard Webhooks verification (checked against OpenAI's SDK) and signing for tests and the check script. |
| `apps/server/src/realtime-voice.ts` | `RealtimeCallControl` (accept, reject, hangup) on `OpenAIRealtimeConnector`; `realtimeSession(..., { noiseReduction })`. |
| `apps/server/src/voice-routes.ts` | `resolveListing`, shared with "Call Seller". |
| `packages/core/src/record/events.ts` | `voice_connection` with `ended`, `transport` and `reason`. |
| `apps/server/scripts/phone-check.ts` | The setup check of section 9.4. |
| `apps/server/test/phone.test.ts` | The tests of section 13. |

## 12. Open decisions and known limits

Placeholders, for the interaction design:

- The lines for silence and the time limit, and the 30 s and 15 minute defaults.
- A declined call is a SIP rejection, so the caller hears their network's tone. Answering and explaining ("the seller has paused this listing") is the alternative.
- Each call starts a new negotiation. Continuing a caller's earlier negotiation would need their number stored with it, which is a product and privacy decision; today the caller's number is not recorded.
- The call stays open after an agreement or a refusal; the silence timer ends it. Hanging up after the engine's closing message is the alternative.

To confirm on the first live call (the logs show both):

- Which SIP headers Vobiz sends, and whether `To` carries the dialled number (section 4).
- Whether the sideband carries `output_audio_buffer.*` for SIP calls (section 6). OpenAI documents them for WebRTC and SIP; if they are missing, the fallback decides.

Known limits:

- A hang-up and a dropped line look the same.
- If the accept succeeds but OpenAI never connects the call, the session stays empty in the console.
- Inherited from the browser call: when an interrupted reply's partial transcript lacks one of its amounts, the controller's fidelity check says the whole reply again once after the interruption. That is the controller's existing behaviour (`#checkFidelity`), unchanged here; it may deserve its own look.
- Inbound calls only. Calling a buyer back (outbound SIP) is not built.

## 13. Tests

`apps/server/test/phone.test.ts`, with a fake OpenAI connection (no network):

- settings and routes, number normalisation, SIP header reading, caller masking;
- webhook signatures: valid, several, altered body, wrong secret, replay outside five minutes, missing headers;
- the delivery rule with a manual clock: delivered and interrupted by playback events, the heard part from `audio_end_ms` and from playback time, cancelled before audio, no end event, the timing fallback both ways, the call ending mid-reply, and the voice model's own words being ignored;
- whole calls: unsigned webhook, ignored events, no route (404), paused listing and missing mandate (480), busy (486), a call gone while ringing, the accept body (flat, no audio format, phone noise reduction, no private amounts), the greeting, the recorded connection, a retried webhook, the setup route, a deal turn through the engine with delivery, an interruption with the part heard, a hang-up mid-reply, the silence check and goodbye, a reset by speech, and the time limit.

Run them with the rest of the server tests: `npx vitest run --testTimeout=30000` in `apps/server`.
