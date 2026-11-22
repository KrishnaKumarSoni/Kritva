# Kritva phone calls

Engineering design and setup for taking real phone calls with Kritva's realtime voice, through a Vobiz SIP trunk into OpenAI's realtime SIP endpoint. Written 2026-11-22 and updated the same day after the first live calls (section 10). The browser call this builds on is described in `docs/Kritva_Realtime_Voice.md`; read that first.

Interaction design (what Kritva says when, how a declined call sounds, whether a call ends itself after a deal) is deliberately left open. Where this document makes a placeholder choice, it says so (section 13).

## 1. What it does

A counterparty dials a Vobiz number. The call reaches Kritva's realtime voice, which talks with them exactly as in a browser call: the realtime model is Kritva's ears and voice, the negotiation engine decides every deal move, and every reply is checked and recorded. The principal (whoever Kritva represents, seller or buyer) sees the call in the console as a voice session.

```
Caller → Vobiz DID → Vobiz inbound SIP trunk (TLS signalling, SRTP setting on)
       → OpenAI SIP: sip:proj_...@sip.api.openai.com:5061 (routed by the caller's location)
                │  webhook: realtime.call.incoming
                ▼
Kritva server  POST /api/webhooks/openai
  verify signature → route the call → start a session → accept (model, instructions, voice)
  → join over the sideband WebSocket → session.update (the full session) → PhoneCall greets
```

Kritva can also place the call itself (section 15): Vobiz dials the counterparty and, once they answer, bridges the call to the same OpenAI address, where it arrives as an incoming call into the negotiation it was placed for.

Audio never passes through Kritva's server. Vobiz and OpenAI exchange it directly; the server answers the webhook, controls the call over REST and handles its events over the sideband WebSocket, as it already does for a browser call.

## 2. What stays exactly as it is

- **The engine decides every move**, through the same `negotiate` tool and `engine.handleCounterpartyMessage`. Nothing in the engine's negotiation logic changed.
- **The call controller** (`RealtimeCall` in `apps/server/src/realtime-voice.ts`) is shared with the browser: routing of conversation and deal turns, verbatim speech, the checks on the voice model's own words, corrections, engine-initiated messages and the fillers during waits. Phone calls added only two read-only getters (`language`, `textOf`).
- **Session settings**: a phone call gets the same `realtimeSession(...)` as a browser call (model, instructions, tools, language hints, semantic turn-taking, reasoning), applied in two steps (section 3, step 5). Only noise reduction is the phone's own setting, and no audio format is set (SIP negotiates the codec; the live calls used PCMA).
- **Listing rules**: a phone call checks a listing with the same function as the bed demo listing's "Call Seller" button (`resolveListing` in `voice-routes.ts`).
- **Delivery rule**: an offer counts only once heard in full; an interruption records the approximate part heard.

## 3. How a call works

1. **Ring.** Vobiz sends the call's SIP INVITE to OpenAI. OpenAI posts `realtime.call.incoming` to the project's webhook, with the call ID, the INVITE's SIP headers and `sip_media_security`.
2. **Verify.** The server checks the Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`; HMAC-SHA256 with the `whsec_` secret; five-minute window). An unsigned or altered request gets 400 and nothing happens. Other event types, and the dashboard's empty test event, get 200 and are ignored.
3. **Route.** The dialled number is read from the SIP headers and matched to `KRITVA_PHONE_ROUTES` (section 4; with Vobiz, the `*` route). The route names a listing or a saved mandate.
4. **Check and start.** The listing (or mandate) must be live with a confirmed mandate, and fewer than `KRITVA_PHONE_MAX_CALLS` calls may be in progress. A new negotiation session starts under the confirmed revision, recording its source, as "Call Seller" does.
5. **Accept, then configure.** `POST /v1/realtime/calls/{call_id}/accept` carries only `type`, `model`, `instructions` and the output voice. After joining (step 6), the server sends the rest of the session as `session.update` before anything is said. This is how Vobiz's working sample does it, and it is what made audio flow (section 10): with the whole session in the accept, OpenAI answered 200 but the call had no audio either way and no error was reported. A field OpenAI rejects in `session.update` arrives as an `error` event in the log instead. `KRITVA_PHONE_ACCEPT=full` restores the single accept, for comparison only.
6. **Join and run.** The server opens `wss://api.openai.com/v1/realtime?call_id=...`, sends the `session.update`, and starts a `PhoneCall`, which records `voice_connection` (connected, transport phone) and greets: the engine writes the opening line and the voice speaks it word for word. From here every turn works as in a browser call.
7. **End.** The caller hanging up closes the sideband. Kritva ends the call itself when the conversation is over: it says a short goodbye, calls `end_call`, and hangs up once the goodbye has played (`docs/Kritva_Realtime_Voice.md`, section 6b). A long silence or the time limit also makes Kritva say a closing line and hang up. Either way the call is hung up at OpenAI, anything still playing is recorded interrupted, and `voice_connection` (ended, with the reason) closes the call in the record.

A retried webhook for the same call answers it once. A failed accept is retried twice within the webhook (after 0.3 s and 0.9 s; each attempt times out after 4 s). OpenAI answers an accept for a call that no longer exists with 503 and an empty body (measured on 2026-11-22), the same as an outage, so a 503 is always retried and only a 404 is final. If the accept still fails, the server hangs the call up, in case an accept went through unseen and left the caller with an unsupervised voice. It then acknowledges the webhook with 200, because a webhook retry would come after the caller stopped waiting. A webhook that fails inside Kritva gets 500, and OpenAI's retry reuses the session already started.

## 4. Which number was dialled

OpenAI passes the INVITE's headers as untrusted `{ name, value }` pairs. The server looks for the dialled number in the usual places, most specific first, and takes the first number that has a route:

1. a provider header whose name mentions the DID, called, dialled, destination or original-to number (for example `X-...-DID`);
2. `To`, then `P-Called-Party-ID`, `Diversion` and `History-Info`.

**Vobiz sends no dialled number** (measured on the first live calls). Its INVITE carries `Record-Route`, `Via`, `From`, `To`, `Call-ID`, `CSeq`, `Contact`, `User-Agent: Vobiz`, `Allow`, `Supported`, `Allow-Events`, `Content-*` and `Remote-Party-ID`. `To` is the origination URI (`sip:proj_...@sip.api.openai.com:5061`), and the caller is in `From` and `Remote-Party-ID`. So with Vobiz every call needs the `*` route, and all numbers on one OpenAI project reach the same listing. Separate listings per number would need separate OpenAI projects (each with its own webhook), or a Vobiz feature that adds the dialled number as a header.

Numbers are compared as digits with the country code (`+91 80 7123 4567`, `080 7123 4567` and `8071234567` are the same number). Every incoming call is logged with the header names it carried and the numbers found. The caller's number is only ever logged masked (`91******3210`) and is not recorded in the negotiation.

## 5. When a call is declined

The call is rejected at OpenAI with a SIP status, so the caller hears their network's tone or message, and no session starts:

| SIP | When |
|---|---|
| 404 | The dialled number has no route (and there is no `*` route). |
| 480 | The listing is paused or closed, its mandate is missing or not confirmed, or a routed saved mandate is not live. |
| 486 | `KRITVA_PHONE_MAX_CALLS` calls are already in progress. |
| 500 | A session could not be started. |

## 6. Delivery without a browser

In a browser call the page hears its own audio and reports each reply as finished or cut off. A phone call has no page, so the server decides from the call's events (`apps/server/src/phone/playback.ts`, `ServerPlayback`). It reports exactly what the browser would, one report per recorded message Kritva speaks, through `engine.reportDelivery`. Fillers and the voice model's own answers are not recorded messages and get no report.

**The rule.** When the evidence is unclear, a reply is reported interrupted, never delivered.

1. **Playback events decide.** OpenAI sends them on the sideband for SIP calls (confirmed on the first working call):
   - `output_audio_buffer.started`: the reply's audio began playing to the caller.
   - `output_audio_buffer.stopped`: it played to the end. **Delivered.**
   - `output_audio_buffer.cleared`, or `response.done` with any status other than "completed" (the caller talked over it, or the audio was cleared): **interrupted.**
   - A reply that started but reports no end within twice its expected length plus 10 s: **interrupted.**
2. **Timing decides only while a call has shown no playback events at all**, a fallback. The reply's audio starts with its first audio or transcript event and is expected to last its length at 11 characters a second plus 1 s. Speech runs at about 14 a second, so this window outlasts the real audio.
   - The caller starts speaking (`input_audio_buffer.speech_started`) inside the window: **interrupted.**
   - The window passes with no speech and the response completed: **delivered**, but only once the caller has been heard at least once on the call, which proves the audio path works. Until then the reply waits: the caller's first words make it delivered, and the call ending first makes it **interrupted** with nothing heard (`no_caller_audio`). The silent calls of section 10 are why: there, OpenAI sent no playback events and the window passed, so without this proof a greeting nobody heard counted as heard.
3. **The call ending** (hang-up, silence, time limit, a server restart) while a reply is playing or queued: **interrupted.**

**The part heard.** On WebRTC and SIP calls OpenAI trims unplayed audio itself and reports how much played (`conversation.item.truncated`, `audio_end_ms`). Without that, the time since the audio started is used. Either becomes characters at 14 a second, cut back to a whole word, as the browser does. A reply cut before any audio played was heard as "".

`audioStartMs`, the time from the end of their speech to the start of the reply's audio, is reported as the browser reports it. Each call's end is logged with `deliveryFrom` ("playback_events" or "estimate") and a count of every event type the sideband sent, so it is clear what decided.

## 7. Silence, time limit and the end of a call

- **Silence.** After `KRITVA_PHONE_IDLE_SECONDS` (default 30) with nothing said, decided or played, Kritva asks whether they are still there. After the same again, it says goodbye, waits for that line to be heard (at most 15 s) and hangs up. Anything the caller says resets the timer and the check. The realtime model's own idle timeout only works with `server_vad`, and Kritva uses `semantic_vad`, so the server keeps this timer.
- **Time limit.** At `KRITVA_PHONE_MAX_MINUTES` (default 15) Kritva lets a deal turn in progress finish (up to 20 s), says a closing line and hangs up.
- **Hang-up.** OpenAI's sideband "lives for the life of the SIP call", so its closing means the caller hung up or the line dropped (the two look the same, reason `hung_up`). Kritva also calls `/hangup` in that case, so a call can never stay connected to a voice nobody supervises; after a hang-up OpenAI answers that slowly or not at all, which is expected and not logged.
- **A stopped or restarted server.** The running server hangs up its live calls on SIGTERM or SIGINT (at most 3 s) before exiting. This matters in development: `node --watch` restarts the server on every saved file, and before this a restart left a live call connected with nothing supervising it.
- **The record.** `voice_connection` gained `status: "ended"`, `transport` ("browser" or "phone") and `reason` (`hung_up`, `idle`, `max_duration`, `server`, `error`). Older events read as before. The console shows "Phone call connected" and "Phone call ended" with the reason, and its "voice interrupted" flag still finds a reply cut off by a hang-up.

The lines Kritva says itself here (still there, goodbye, time up) are recorded through `engine.recordVoiceLine`, pass the same outgoing check as every voice line, and exist in English, Hindi and Tamil.

## 8. Configuration

Phone calls are on when `OPENAI_API_KEY` is set with realtime voice on (`KRITVA_VOICE_MODE` unset or `realtime`) and both `OPENAI_WEBHOOK_SECRET` and `KRITVA_PHONE_ROUTES` are set. The server prints whether they are on, and why not.

| Setting | Default | Meaning |
|---|---|---|
| `OPENAI_WEBHOOK_SECRET` | (required) | The project webhook's signing secret, `whsec_...`. |
| `KRITVA_PHONE_ROUTES` | (required) | `number=target` pairs, comma-separated. Target: a listing's case ID (`bed-sale` or `listing:bed-sale`) or a saved mandate (`mandate:man_...`). `*` matches any number; Vobiz needs it (section 4). Example: `+918064264194=bed-sale,*=bed-sale`. |
| `OPENAI_PROJECT_ID` | (none) | `proj_...`; only used to print the SIP URI for the trunk. |
| `KRITVA_PHONE_SIP_HOST` | `sip.api.openai.com` | OpenAI's SIP host, routed by location. `sip-in.api.openai.com` is the India edge, not yet tested since the accept fix (section 10). |
| `KRITVA_PHONE_NOISE_REDUCTION` | `near_field` | `near_field` (a handset held to the ear), `far_field` (speakerphone or a room) or `off`. |
| `KRITVA_PHONE_IDLE_SECONDS` | `30` | Silence before the "still there?" check, and again before hanging up (10 to 300). |
| `KRITVA_PHONE_MAX_MINUTES` | `15` | Longest call (1 to 120). |
| `KRITVA_PHONE_MAX_CALLS` | `5` | Calls at once; more are declined as busy. Keep the Vobiz trunk's concurrent-call limit at least this high. |
| `KRITVA_PHONE_COUNTRY_CODE` | `91` | Assumed for numbers written without one. |
| `KRITVA_PHONE_ACCEPT` | `minimal` | `minimal`: accept with model, instructions and voice, then `session.update` (section 3). `full`: everything in the accept (left silent calls with Vobiz). |
| `KRITVA_PHONE_TRACE` | off | `1` logs every sideband event type with its time and IDs (never audio), the masked SIP headers and `sip_media_security`. For diagnosing a call. |
| `KRITVA_PHONE_LOG_FILE` | (none) | Also append every `[phone]` log line to this file (for example `data/phone-calls.log`), to follow calls outside the server's console. |
| `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` | (none) | Vobiz's API credentials: for outbound calls (section 15) and `scripts/vobiz-trunk.ts`. |
| `VOBIZ_TRUNK_ID` | (none) | Only for `scripts/vobiz-trunk.ts` (section 9.2). |
| `KRITVA_PHONE_CALLER_ID` | (none) | Outbound: Kritva's Vobiz number, the caller ID. |
| `KRITVA_PUBLIC_URL` | (none) | Outbound: the public `https://` base URL Vobiz calls back (the tunnel or the deployed host). |
| `KRITVA_PHONE_BRIDGE` | `number` | Outbound: how an answered call reaches OpenAI. `number` forwards it to Kritva's own Vobiz number (through the inbound trunk); `sip` dials OpenAI's SIP address directly, tagged. Both were silent on 2026-11-22 (section 15.4). |
| `KRITVA_PHONE_OUTBOUND_CODEC` | (none) | Outbound: declare `pcmu` or `pcma` to OpenAI for calls Kritva placed. Declaring PCMU did not help on 2026-11-22. |
| `KRITVA_PHONE_OUTBOUND_ALLOW` | (none) | Outbound: the only numbers Kritva may call, comma-separated, or `*`. Empty means nothing can be dialled. |

The realtime settings (`KRITVA_REALTIME_*`, `KRITVA_VOICE_LANGUAGES`) apply to phone calls too.

## 9. Setup (steps that need your accounts)

These steps use your OpenAI and Vobiz accounts and cost money, so they are yours to do or approve. The code needs nothing else. The current setup (section 9.6) was made this way on 2026-11-22.

### 9.1 OpenAI

1. Use the same OpenAI project as `OPENAI_API_KEY`. Its ID comes back in the `openai-project` header of any API response, or from the platform's project settings. Put it in `.env` as `OPENAI_PROJECT_ID`.
2. In the project's **Webhooks** settings, create a webhook:
   - URL: `https://<public host>/api/webhooks/openai` (section 9.3 gives a public host for local testing);
   - event: `realtime.call.incoming`.
3. Copy its signing secret (shown once) into `.env` as `OPENAI_WEBHOOK_SECRET`.

### 9.2 Vobiz

In the Vobiz console (console.vobiz.ai), following Vobiz's OpenAI guide (https://www.vobiz.ai/docs/integrations/openai-realtime):

1. **Origination URI** (SIP Trunk → Inbound Trunks → Origination URIs → Add): URI `proj_YOUR_PROJECT_ID@sip.api.openai.com:5061` (no `sip:` prefix), transport **TLS**. The console warns "Invalid host" because of the `proj_...@` part; choose **Save anyway**, as Vobiz's own guide uses this form. The `:5061` is required: without it Vobiz dials port 5060 and the call is refused (the CDR shows `send_refuse`).
2. **Trunk** (Inbound Trunks → Create trunk): a name and the origination URI above. Leave call recording off.
3. **SRTP.** Vobiz's guide requires `secure: true` on the trunk, and the console has no switch for it, on create or edit. Put `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` (console dashboard) and `VOBIZ_TRUNK_ID` in `.env` and run:

   ```bash
   node --env-file=.env apps/server/scripts/vobiz-trunk.ts --secure
   ```

   It sets `transport: tls` and `secure: true` through Vobiz's API and prints the result. (OpenAI's webhook still reported `sip_media_security: "rtp"` on the working call; audio works either way.)
4. **Number** (Numbers → Buy new number). Vobiz takes the setup fee and first month from the wallet at purchase and refuses if the wallet cannot cover both. The cheapest Indian numbers were Karnataka (080) at ₹500 a month plus ₹100 setup; giving a number back costs a ₹700 release fee. Wallet top-ups have a ₹500 minimum plus 18% GST. Any Indian number can be called from anywhere in India, so the city does not matter.
5. **Link the number** to the trunk (the purchase panel offers it: Inbound Trunk → the trunk → Link & Finish).
6. Put the routes in `.env`: `KRITVA_PHONE_ROUTES=+91XXXXXXXXXX=bed-sale,*=bed-sale` (the `*` route is the one that matches; section 4).

`node --env-file=.env apps/server/scripts/phone-check.ts` prints the exact origination URI from your settings.

**Dialling.** A Vobiz 080 number is a Bangalore landline number. From an Indian mobile, dial `08064264194` or `+918064264194`; dialling the ten digits alone gives "number is invalid" because the network reads it as a mobile number.

### 9.3 A public URL for local testing

OpenAI must reach the webhook over HTTPS. Both tunnels are installed on this Mac; the server listens on port 8787.

```bash
cloudflared tunnel --no-autoupdate --url http://localhost:8787
```

It prints `https://<random>.trycloudflare.com`; that host changes on every run, so update the OpenAI webhook URL each time. `ngrok http 8787` works the same way, with a fixed domain on a paid plan. While the tunnel runs, the whole local API is reachable from the internet; the principal's console routes still need the access key.

### 9.4 Run and check

1. Start the server: `npm run dev -w @kritva/server`. It prints `Phone calls: on`, the SIP URI and the webhook path.
2. Check the tunnel and the secret:

   ```bash
   node --env-file=.env apps/server/scripts/phone-check.ts --url https://<random>.trycloudflare.com
   ```

   Expect `200`. A 400 means the secret differs between the script's `.env` and the server; a 404 means phone calls are off on that server. Adding `--ring +91XXXXXXXXXX` sends a made-up call: the server routes it, starts a session and tries to answer, and OpenAI refuses because the call does not exist. Expect `200` with `"error":"accept_failed"`. This leaves one empty session in the record.
3. Call the number, with `KRITVA_PHONE_TRACE=1` and `KRITVA_PHONE_LOG_FILE` set for the first calls. In the log, a healthy call shows `phone_incoming`, `phone_accepted`, `session.updated`, `input_audio_buffer.speech_started` when you speak, `output_audio_buffer.started` and `.stopped` around each reply, and `phone_ended` with `deliveryFrom: "playback_events"`.
4. The principal's console shows the session, with "Phone call connected" and, after hanging up, "Phone call ended".

### 9.5 Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Number is invalid" from the caller's network, and nothing in Vobiz's call logs | Dialled without `0` or `+91` (section 9.2). |
| Call refused at the carrier, CDR `send_refuse` | `:5061` missing from the origination URI. |
| Call answered, greeting generated, but silence both ways; the trace has no `input_audio_buffer.*` events and no `output_audio_buffer.*`; Vobiz shows jitter 0 | The full session was sent in the accept (`KRITVA_PHONE_ACCEPT=full`). Use the default `minimal`. If it persists, check SRTP (section 9.2, step 3). |
| No webhook arrives | The project ID in the URI is not the webhook's project, the number is not linked to the trunk, or the tunnel URL changed. |
| Webhook answered 400 | Wrong `OPENAI_WEBHOOK_SECRET`, or the server's clock is more than five minutes off. |
| Caller hears a busy or unavailable tone | Declined on purpose: see section 5 and the `phone_rejected` log line. |
| Call drops right after it is answered | `phone_attach_failed`: the sideband could not open (API key or network). The call is hung up at once. |
| Call drops mid-conversation in development | A saved file restarted the `--watch` server, which hangs up live calls (`phone_shutdown` in the log). |

### 9.6 The current setup (2026-11-22)

- OpenAI project "Tinkering" (`proj_whvrXH1lLvXn3OwPSbX5qkBV`), webhook "Kritva phone calls (local tunnel)" for `realtime.call.incoming`, pointing at a cloudflared quick tunnel (the URL changes when the tunnel restarts).
- Vobiz origination URI "OpenAI Realtime global" (`proj_whvrXH1lLvXn3OwPSbX5qkBV@sip.api.openai.com:5061`, TLS), trunk "Kritva phone OpenAI realtime" (`8553ee4d-7b76-45e8-8715-5364168f7e54`, TLS, secure), number +91 80 6426 4194 linked to it.
- `.env`: the settings above with `*=bed-sale`, `KRITVA_PHONE_SIP_HOST=sip.api.openai.com`, `KRITVA_PHONE_LOG_FILE=data/phone-calls.log` and, while testing, `KRITVA_PHONE_TRACE=1`.

## 10. What the first live calls showed (2026-11-22)

- **Calls 1 to 3 were silent both ways.** OpenAI's webhook arrived, the accept returned 200, the sideband joined and the model wrote the greeting, but the caller heard nothing and the model heard nothing (no `input_audio_buffer.*` events; Vobiz reported jitter 0 and some packet loss). The caller's hang-up never reached Kritva either: Kritva's silence timer ended the call. Moving the origination URI from the India edge to the global host did not change this.
- **Call 4 worked** after one change: the accept carried only model, instructions and voice, and the full session followed as `session.update` (section 3, step 5), as in Vobiz's sample. Audio flowed both ways, OpenAI sent `session.updated` with no error, the caller's speech started turns, playback events decided every delivery, and the hang-up closed the sideband and was recorded. The global host served it from the same OpenAI region as the India-edge calls (call IDs `rtc_u7_...`). Which field of the full accept broke the audio is not known; the trace shows no error for it.
- **Call 1 was also cut off by a dev server restart** (`node --watch` reloading after another session saved a file). The server now hangs up live calls on shutdown (section 7).
- Vobiz puts no dialled number in the INVITE (section 4), and OpenAI reported `sip_media_security: "rtp"` with the trunk's SRTP setting on.
- On call 4 the voice model answered "Can you repeat that?" and a Hindi request to repeat with the same English introduction three times. That is the voice model's conversation behaviour, not the phone path, and was passed to the session working on Kritva's tone.

## 11. Latency and deployment

- **Audio** goes caller → Vobiz (Mumbai origination in Vobiz's CDRs) → OpenAI's SIP host, routed by location → the realtime model. Kritva's server is not in that path. On call 4, the reply's audio started 0.7 to 0.9 s after the caller stopped speaking on conversation turns.
- **Control** (the webhook, accept, the sideband and the engine's own model calls) goes between Kritva's server and `api.openai.com`. Deal turns wait on this path, so deploy the server close to it and to the users. With the target users in Bangalore, AWS `ap-south-1` (Mumbai) is the natural region; measure `api.openai.com` round trips from there before deciding.
- The webhook must answer within a few seconds. It does local work (a session start) and one accept call before answering; the join and greeting run after it. On the live calls, the time from the webhook arriving to the accept succeeding was 0.5 to 2.8 s.
- Cost: Vobiz charged ₹0.38 for each short test call, plus the number's rental; OpenAI's realtime cost per minute is as in `docs/Kritva_Realtime_Voice.md`, section 8.

## 12. Code map

| File | What it holds |
|---|---|
| `apps/server/src/phone/routes.ts` | The webhook route, routing to a listing or mandate, decline codes, the accept plan (`acceptPlan`) and retries, join, the call registry, hang-up on shutdown, `GET /api/operator/phone` (setup values and calls in progress, no secrets) and `phoneFromEnv` for `main.ts`. |
| `apps/server/src/phone/phone-call.ts` | `PhoneCall`: wraps `RealtimeCall`, sends the `session.update`, feeds `ServerPlayback`, the silence and time-limit timers, hang-up, the call-end record, event counts and the trace, and the lines it says itself. |
| `apps/server/src/phone/playback.ts` | `ServerPlayback`: the delivery rule of section 6. Pure, with an injectable clock. |
| `apps/server/src/phone/sip-headers.ts` | Reading the dialled and calling numbers from SIP headers; masking numbers for logs. |
| `apps/server/src/phone/config.ts` | Settings from the environment, number routes, the SIP URI. |
| `apps/server/src/phone/webhook-signature.ts` | Standard Webhooks verification (checked against OpenAI's SDK) and signing for tests and the check script. |
| `apps/server/src/realtime-voice.ts` | `RealtimeCallControl` (accept, reject, hangup) on `OpenAIRealtimeConnector`; `realtimeSession(..., { noiseReduction })`. |
| `apps/server/src/voice-routes.ts` | `resolveListing`, shared with "Call Seller". |
| `packages/core/src/record/events.ts` | `voice_connection` with `ended`, `transport` and `reason`. |
| `apps/server/scripts/phone-check.ts` | The setup check of section 9.4. |
| `apps/server/scripts/vobiz-trunk.ts` | Shows a Vobiz trunk and turns SRTP on (section 9.2, step 3). |
| `apps/server/src/phone/outbound.ts` | `OutboundDialer`: places calls, follows their state, matches the bridged call to its session (section 15). |
| `apps/server/src/phone/vobiz.ts` | Vobiz's Make Call and hang-up API, and the answer XML that bridges to OpenAI. |
| `apps/server/test/phone.test.ts` | The tests of section 14. |

## 13. Open decisions and known limits

Placeholders, for the interaction design:

- The lines for silence and the time limit, and the 30 s and 15 minute defaults.
- A declined call is a SIP rejection, so the caller hears their network's tone. Answering and explaining ("this negotiation is paused for now") is the alternative.
- Each call starts a new negotiation. Continuing a caller's earlier negotiation would need their number stored with it, which is a product and privacy decision; today the caller's number is not recorded.
- The call stays open after an agreement or a refusal; the silence timer ends it. Hanging up after the engine's closing message is the alternative.

Known limits:

- With Vobiz, all numbers on one OpenAI project reach the same listing (section 4).
- The India edge (`sip-in.api.openai.com`) has not been tried since the accept fix.
- A hang-up and a dropped line look the same.
- If the accept succeeds but OpenAI never connects the call, the session stays empty in the console.
- Inherited from the browser call: when an interrupted reply's partial transcript lacks one of its amounts, the controller's fidelity check says the whole reply again once after the interruption. That is the controller's existing behaviour (`#checkFidelity`), unchanged here; it may deserve its own look.
- Outbound calls are built but not yet tried on a real call (section 15).

## 14. Tests

`apps/server/test/phone.test.ts`, with a fake OpenAI connection (no network):

- settings and routes, number normalisation, SIP header reading, caller masking;
- webhook signatures: valid, several, altered body, wrong secret, replay outside five minutes, missing headers;
- the delivery rule with a manual clock: delivered and interrupted by playback events, the heard part from `audio_end_ms` and from playback time, cancelled before audio, no end event, the timing fallback both ways, waiting for proof of caller audio, a call whose audio never connected, the call ending mid-reply, and the voice model's own words being ignored;
- whole calls: unsigned webhook, ignored events, no route (404), paused listing and missing mandate (480), busy (486), a call gone while ringing, accept retries, the minimal accept and the `session.update` before the greeting (no audio format, phone noise reduction, no private amounts), the full accept mode, the recorded connection, a retried webhook, the setup route, a deal turn through the engine with delivery, an interruption with the part heard, a hang-up mid-reply with the event counts, the silence check and goodbye, a reset by speech, and the time limit.

- outbound calls: settings and the empty default allowlist, placing a call with tokened callback URLs and no number in the record, refusals (allowlist, malformed number, inactive session), one call per repeated request ID, a provider failure, the answer XML, the bridged call joining its own session with direction "outbound", the Vobiz leg hung up when the realtime side ends, no answer and busy, a late answer after the end, matching without the tag, cancelling a ringing call, and the setup view.

Run them with the rest of the server tests: `npx vitest run --testTimeout=30000` in `apps/server`.

## 15. Outbound calls (Kritva dials the counterparty)

For negotiations where the principal gives Kritva numbers to call (the multiple-counterparties work decides how those are organised). Built on 2026-11-22. **Live calls connect end to end but are silent: audio does not cross the second leg Vobiz's dialling servers place (section 15.4).**

### 15.1 How a call works

OpenAI's Realtime API cannot dial out: its outbound SIP calling exists only in the separate Live API (`POST /v1/live/sessions`, model `gpt-live-1`), which would mean a different model and a rewritten call controller. So Vobiz places the call and hands it to OpenAI as an incoming one:

1. `call({ sessionId, to })` checks the number (allowlist, format) and that the session is active. Over `KRITVA_PHONE_MAX_CALLS` lines in use, the call waits as `queued` and goes out in order as lines free up (each queued call's negotiation is checked again before it is dialled). Then Kritva asks Vobiz's Make Call API (`POST /api/v1/Account/{auth_id}/Call/`) to dial `to` from Kritva's number. The answer, ring and hang-up URLs carry an unguessable per-call token, which is what authorises Vobiz's callbacks. State: dialling, then ringing.
2. When they answer, Vobiz fetches the answer URL. The XML bridges the call to OpenAI: `<Dial callerId="+91…"><User sipHeaders="kritva_call=<token>">sip:proj_…@sip.api.openai.com:5061;transport=tls</User></Dial>`. State: answered.
3. OpenAI posts `realtime.call.incoming`. The webhook finds the token in a SIP header (Vobiz adds its own `X-` prefix to `sipHeaders`), or, without it, takes the one call that is answered and waiting for its bridge. It accepts the call into **that session** (no new session, no routing), and the same `PhoneCall` runs it: turns, delivery, silence and time limit. The greeting asks the engine for an outbound opener (`engine.greet({ ..., outbound: true })`: who is calling, for whom and why, and whether now is a good time); until the multiple-counterparties work adds that to the engine, the usual greeting is used. State: connected. The record gets `voice_connection` with `direction: "outbound"`; the console shows "Kritva's call connected".
4. The end: their hang-up, Kritva's (`hangup(callId)`, silence, time limit) or Vobiz's. Whichever side ends first, Kritva makes sure the other ends too. Outcomes: `completed`, `no_answer`, `busy`, `failed` (answered but the bridge never arrived within 45 s, or the provider refused), `cancelled`.

### 15.2 The interface (agreed with the multiple-counterparties work, 2026-11-22)

- In-process: `PhoneHandle.outbound` (an `OutboundDialer`) with `call({ sessionId, to, clientRequestId? })`, `get(callId)`, `listForSession(sessionId)`, `hangup(callId)` and `onChange(listener)`.
- Operator routes: `POST /api/operator/sessions/:id/calls` `{ to, clientRequestId }` → 202 with the call; `GET /api/operator/sessions/:id/calls`; `GET /api/operator/calls/:callId`; `POST /api/operator/calls/:callId/hangup`.
- Errors: `phone_off`, `invalid_number` (400), `not_allowed`, `session_not_active` (409), `provider_error` (502). Calls over the line limit are queued, not refused.
- States: `queued`, `dialling`, `ringing`, `answered`, `connected`, `ended`. No automatic retries: the board offers "Call again", which calls `call()` with a new `clientRequestId`. When a deal goes to another counterparty, the board hangs up that session's calls still queued, dialling or ringing.
- One dialer per server: `main.ts` builds it with `outboundDialer(phone, engine)` and passes it to `createApp({ dialer })`, so the phone routes and the counterparties' board share it.
- The live-call registry (`createApp({ liveCalls })`, any object with `register(sessionId, call, contact)` and `unregister(sessionId, call)`) is told about every connected phone call in `connect()` in `routes.ts`, with the counterparty's number while the call lasts: the caller's for an inbound call, the dialled one (`dialledNumber(callId)`) for Kritva's own. That is what break-in and "keep your number" use. The numbers stay in memory.
- The multiple-counterparties work keeps counterparty numbers on the saved mandate's list (operator-only, never in a session record) and passes `to` from there, as "+91…" or a bare 10-digit number; the dialer normalises it with `KRITVA_PHONE_COUNTRY_CODE` or answers `invalid_number`.
- The call view: `{ callId, sessionId, to (masked), state, outcome, startedAt, answeredAt, connectedAt, endedAt, endReason }`.
- One call belongs to one existing, active negotiation session. A repeated `clientRequestId` returns the first call, so a double click dials once.
- The counterparty's number stays in memory and masked in logs and views. It never enters the negotiation record, as the user decided for inbound callers.

### 15.3 Indian rules (from Vobiz's compliance pages; to confirm with the user before any real call)

- Only Indian businesses or KYC-verified individuals may make domestic calls; the caller ID must be a Vobiz Indian number. The account's KYC is verified.
- Number series: 140 is for promotional calls only (10 AM to 8 PM, no Do-Not-Disturb bypass); 160 is for service and transactional calls (BFSI); **landline numbers like Kritva's 080 number are for service and transactional calls only, never promotional.** Whether a negotiation call to someone who asked to be called counts as service or transactional is not settled by those pages.
- Consent: cold calling is prohibited. Vobiz checks the national Do-Not-Disturb registry and blocks calls to registered numbers without documented consent, which must be no older than six months. Opt-outs must be honoured at once. Repeated complaints suspend the account (5 in 10 days: 15 days) and can lead to a one-year blacklisting.
- Cost: Vobiz quotes from ₹0.45 a minute for Indian outbound calls (its comparison page; the real rate shows on each call), plus OpenAI's realtime cost per minute.

Hence the allowlist: until the user confirms these points, only numbers they list (their own, for testing) can be dialled.

### 15.4 The first live outbound call (2026-11-22): connected, but silent

Placed to the user's own phone, with their approval, from the bed listing's negotiation.

What worked, end to end in about 11 s: Vobiz accepted `+91…` numbers and rang the phone; the ring and answer callbacks arrived; the answer XML's `<Dial><User>` reached `sip:proj_…@sip.api.openai.com:5061;transport=tls` over TLS; the tag arrived as the header `X-VH-kritva_call` (matched by header, not by the fallback); OpenAI took plain RTP (`sip_media_security: "rtp"`); the call joined its own negotiation, the full session applied (`session.updated`, no error) and the greeting was generated. Vobiz reported the hang-up as "Normal Hangup".

What did not: **no audio either way**. OpenAI never heard the person (no `input_audio_buffer.*` events) and never started playing Kritva's reply (no `output_audio_buffer.*`), and it did not pass on the hang-up. The cause is on Vobiz's side of the bridge: the bridged INVITE came from a Vobiz media server behind NAT (`Contact: <sip:Vobiz@10.1.35.193:5080;alias=18.96.230.113~5080~1>`, `Via: SIP/2.0/UDP 10.1.35.193:5080;received=18.96.230.113`, Record-Route `nat=yes`), while working inbound calls come from a public one (`Contact: <sip:mod_sofia@13.200.197.87:5080>`). A private address in the INVITE (and, very likely, in its SDP) leaves OpenAI no reachable place to send media or in-dialog requests.

Since then, Vobiz's hang-up callback ends Kritva's side of a bridged call at once (before, the silence timer ended it after 81 s).

Two more live attempts the same day, both connected end to end and both silent:

| Attempt | What reached OpenAI | Vobiz's record of the legs |
|---|---|---|
| 1. `<Dial><User>` to OpenAI's SIP address | from a NAT'd dialling server (`10.1.35.193`) | phone leg PCMU, 0.5% loss; SIP leg PCMU |
| 2. `<Dial><Number>` to Kritva's own number (`KRITVA_PHONE_BRIDGE=number`) | through the inbound trunk, from a public media server (`18.96.232.170`), matched as the one waiting call | phone leg PCMU, 0.6% loss; **forwarding leg PCMU, 100% loss**; inbound leg PCMU, 15% loss |
| 3. As 2, declaring `audio/pcmu` to OpenAI (`KRITVA_PHONE_OUTBOUND_CODEC`) | the same, `session.updated` with no error | the same pattern |

In every case OpenAI saw no audio from the far end (no `input_audio_buffer.*`) and never started playing (no `output_audio_buffer.*`), although the response was generated. The working inbound call, by contrast, came straight from a caller's network (PCMA) through the inbound trunk. **Conclusion: audio does not cross the second leg that Vobiz's dialling servers place with `<Dial>`** (100% loss on the forwarding leg), whatever its target. Kritva cannot fix that; Vobiz can.

Ways forward:
- **Vobiz support**, with these calls: Vobiz call `d5befe4d-fd03-4e4d-82ae-b966cc0653d4` (02:43 UTC, SIP bridge) and `c048c153-6f36-4dba-832a-a9677ae0e4e5` (03:00 UTC, forward to own number, 100% loss on the forwarding leg).
- **Stream the audio through Kritva's server** (Vobiz's `<Stream>` verb to a WebSocket, relayed to OpenAI's realtime WebSocket in G.711 mu-law). It avoids the `<Dial>` bridge entirely but is a larger build: the server carries the audio, and delivery must come from the stream's playback marks instead of OpenAI's playback events.
- **OpenAI's Live API** dials out itself through a SIP trunk, but needs `gpt-live-1` and a different call controller.
- For a demo today, multiple counterparties work over **inbound** phone calls (counterparties call Kritva's number), browser voice and chat.

Still open: the greeting. The engine's opening line is written for a call the counterparty started; the outbound opener (`engine.greet({ ..., outbound: true })`) comes with the multiple-counterparties work.
