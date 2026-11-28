# Kritva phone calls

**Since 2026-11-28, phone calls run on Vobiz with Sarvam speech (section 17).** Sections 1 to 16 describe the earlier Twilio and OpenAI SIP path, which stays in the code behind `KRITVA_TELEPHONY=twilio`.

Engineering design and setup for real phone calls with Kritva's realtime voice: Twilio carries the phone leg and hands each call to OpenAI's realtime SIP endpoint. Written 2026-11-22; moved to Twilio the same day (section 10 says why and what the earlier calls taught). The browser call this builds on is described in `docs/Kritva_Realtime_Voice.md`; read that first.

Interaction design (what Kritva says when, how a declined call sounds, whether a call ends itself after a deal) is deliberately left open. Where this document makes a placeholder choice, it says so (section 13).

## 1. What it does

A counterparty dials Kritva's Twilio number. The call reaches Kritva's realtime voice, which talks with them exactly as in a browser call: the realtime model is Kritva's ears and voice, the negotiation engine decides every deal move, and every reply is checked and recorded. The principal (whoever Kritva represents, seller or buyer) sees the call in the console as a voice session.

```
Caller → Kritva's Twilio number → Twilio asks the number's Voice URL (POST /api/phone/twilio/voice)
       → TwiML <Dial answerOnBridge><Sip> sip:proj_...@sip.api.openai.com;transport=tls
              ?X-Kritva-Called=<number dialled>&X-Kritva-Caller=<caller>
                │  webhook: realtime.call.incoming
                ▼
Kritva server  POST /api/webhooks/openai
  verify signature → route the call → start a session → accept (model, instructions, voice)
  → wait KRITVA_PHONE_SETUP_DELAY_MS → join over the sideband WebSocket
  → session.update (the full session) → PhoneCall greets
```

Kritva can also place the call itself (section 15): Twilio dials the counterparty and, once they answer, hands the call to the same OpenAI address with `X-Kritva-Call=<token>`, where it arrives as an incoming call into the negotiation it was placed for. Call-backs after the principal decides (`phone/follow-up.ts`) work the same way, tagged `X-Kritva-Follow-Up`.

Audio never passes through Kritva's server. Twilio and OpenAI exchange it directly; the server answers Twilio's and OpenAI's webhooks, controls the call over REST and handles its events over the sideband WebSocket, as it already does for a browser call.

## 2. What stays exactly as it is

- **The engine decides every move**, through the same `negotiate` tool and `engine.handleCounterpartyMessage`. Nothing in the engine's negotiation logic changed.
- **The call controller** (`RealtimeCall` in `apps/server/src/realtime-voice.ts`) is shared with the browser: routing of conversation and deal turns, verbatim speech, the checks on the voice model's own words, corrections, engine-initiated messages and the fillers during waits. Phone calls added only two read-only getters (`language`, `textOf`).
- **Session settings**: a phone call gets the same `realtimeSession(...)` as a browser call (model, instructions, tools, language hints, semantic turn-taking, reasoning), applied in two steps (section 3, step 5). Only noise reduction is the phone's own setting, and no audio format is set (SIP negotiates the codec; the live calls used PCMA).
- **Listing rules**: a phone call checks a listing with the same function as the bed demo listing's "Call Seller" button (`resolveListing` in `voice-routes.ts`).
- **Delivery rule**: an offer counts only once heard in full; an interruption records the approximate part heard.

## 3. How a call works

1. **Ring.** Twilio fetches the number's Voice URL; Kritva answers with TwiML that dials OpenAI's SIP address with the dialled and calling numbers as `X-` headers (signature checked, section 9.2). Twilio sends the SIP INVITE to OpenAI. OpenAI posts `realtime.call.incoming` to the project's webhook, with the call ID, the INVITE's SIP headers and `sip_media_security`.
2. **Verify.** The server checks the Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`; HMAC-SHA256 with the `whsec_` secret; five-minute window). An unsigned or altered request gets 400 and nothing happens. Other event types, and the dashboard's empty test event, get 200 and are ignored.
3. **Route.** The dialled number is read from the SIP headers and matched to `KRITVA_PHONE_ROUTES` (section 4: `X-Kritva-Called`). The route names a listing or a saved mandate.
4. **Check and start.** The listing (or mandate) must be live with a confirmed mandate, and fewer than `KRITVA_PHONE_MAX_CALLS` calls may be in progress. A new negotiation session starts under the confirmed revision, recording its source, as "Call Seller" does.
5. **Accept, then configure.** `POST /v1/realtime/calls/{call_id}/accept` carries only `type`, `model`, `instructions` and the output voice. After joining (step 6), the server sends the rest of the session as `session.update` before anything is said. This is what made audio flow on the first live calls (section 10): with the whole session in the accept, OpenAI answered 200 but the call had no audio either way and no error was reported. A field OpenAI rejects in `session.update` arrives as an `error` event in the log instead. `KRITVA_PHONE_ACCEPT=full` restores the single accept, for comparison only.
6. **Join and run.** After `KRITVA_PHONE_SETUP_DELAY_MS` (1500 in production; section 10), the server opens `wss://api.openai.com/v1/realtime?call_id=...`, sends the `session.update`, and starts a `PhoneCall`, which records `voice_connection` (connected, transport phone) and greets: the engine writes the opening line and the voice speaks it word for word. From here every turn works as in a browser call.
7. **End.** The caller hanging up closes the sideband. Kritva ends the call itself when the conversation is over: it says a short goodbye, calls `end_call`, and hangs up once the goodbye has played (`docs/Kritva_Realtime_Voice.md`, section 6b). A long silence or the time limit also makes Kritva say a closing line and hang up. Either way the call is hung up at OpenAI, anything still playing is recorded interrupted, and `voice_connection` (ended, with the reason) closes the call in the record.

A retried webhook for the same call answers it once. A failed accept is retried twice within the webhook (after 0.3 s and 0.9 s; each attempt times out after 4 s). OpenAI answers an accept for a call that no longer exists with 503 and an empty body (measured on 2026-11-22), the same as an outage, so a 503 is always retried and only a 404 is final. If the accept still fails, the server hangs the call up, in case an accept went through unseen and left the caller with an unsupervised voice. It then acknowledges the webhook with 200, because a webhook retry would come after the caller stopped waiting. A webhook that fails inside Kritva gets 500, and OpenAI's retry reuses the session already started.

## 4. Which number was dialled

OpenAI passes the INVITE's headers as untrusted `{ name, value }` pairs. Kritva's Voice URL puts the number Twilio was called on (`To`) in `X-Kritva-Called` and the caller (`From`) in `X-Kritva-Caller`, so routing does not depend on what the provider does with `To`. The server takes the first number that has a route, looking in this order:

1. a header whose name mentions the DID, called, dialled, destination or original-to number (`X-Kritva-Called` first);
2. `To`, then `P-Called-Party-ID`, `Diversion` and `History-Info`.

The caller is read from `X-Kritva-Caller`, then `P-Asserted-Identity`, `Remote-Party-ID` and `From`. So each Twilio number can have its own route, and a `*` route catches anything else.

Numbers are compared as digits with the country code (`+91 80 7123 4567`, `080 7123 4567` and `8071234567` are the same number; a `+1` number keeps its `1`). Every incoming call is logged with the header names it carried and the numbers found. The caller's number is only ever logged masked (`91******3210`) and is not recorded in the negotiation.

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
| `KRITVA_PHONE_ROUTES` | (required) | `number=target` pairs, comma-separated. Target: a listing's case ID (`bed-sale` or `listing:bed-sale`), a saved mandate (`mandate:man_...`), or `code` for the front desk that asks for the listing code (section 16). `*` matches any number (section 4). Examples: `+19125021960=bed-sale,*=bed-sale`; for a line shared by many mandates, `+19125021960=code,*=code` (the first route's number is the one shown next to each listing code). |
| `KRITVA_PHONE_ANSWERS_FOR` | (none) | Public names the shared line may say it answers for, comma-separated (for example `ABC Corporation`), so the front desk can say yes to "Is this ABC Corporation?" before the code. Demo listings add their own public names. Never read out to callers. |
| `OPENAI_PROJECT_ID` | (none) | `proj_...`: the user part of OpenAI's SIP address, which the TwiML dials. Required for Twilio. |
| `KRITVA_PHONE_SIP_HOST` | `sip.api.openai.com` | OpenAI's SIP host, routed by location. Keep the global host with Twilio (its media servers are not in India). `sip-in.api.openai.com` is the India edge. |
| `KRITVA_PHONE_SETUP_DELAY_MS` | `0` | Pause between the accept and joining the call (0 to 5000). `1500` in production: a server close to OpenAI otherwise sends the session before the call's audio is up, and the call is silent (section 10). |
| `KRITVA_PHONE_NOISE_REDUCTION` | `near_field` | `near_field` (a handset held to the ear), `far_field` (speakerphone or a room) or `off`. |
| `KRITVA_PHONE_IDLE_SECONDS` | `30` | Silence before the "still there?" check, and again before hanging up (10 to 300). |
| `KRITVA_PHONE_MAX_MINUTES` | `15` | Longest call (1 to 120). Twilio's own limit is set a minute longer, so Kritva closes first. |
| `KRITVA_PHONE_MAX_CALLS` | `5` | Calls at once; more are declined as busy (outbound: queued). |
| `KRITVA_PHONE_COUNTRY_CODE` | `91` | Assumed for numbers written without one. |
| `KRITVA_PHONE_ACCEPT` | `minimal` | `minimal`: accept with model, instructions and voice, then `session.update` (section 3). `full`: everything in the accept (left calls silent). |
| `KRITVA_PHONE_TRACE` | off | `1` logs every sideband event type with its time and IDs (never audio), the masked SIP headers and `sip_media_security`. For diagnosing a call. |
| `KRITVA_PHONE_LOG_FILE` | (none) | Also append every `[phone]` log line to this file (for example `data/phone-calls.log`), to follow calls outside the server's console. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | (none) | Twilio's account credentials: webhook signatures, outbound calls, call-backs and their recordings. |
| `TWILIO_VERIFY_SIGNATURE` | on | `off` skips the check of `X-Twilio-Signature` (only for diagnosing a proxy that changes the URL). |
| `KRITVA_PUBLIC_URL` | (none) | The public `https://` base URL Twilio calls (the deployed host, or a tunnel). Signatures are checked against it. |
| `KRITVA_PHONE_CALLER_ID` | (none) | Kritva's Twilio number, the caller ID for outbound calls and call-backs. |
| `KRITVA_PHONE_OUTBOUND_ALLOW` | (none) | Outbound: the only numbers Kritva may call, comma-separated, or `*`. Empty means nothing can be dialled. |
| `KRITVA_FOLLOW_UP_FROM`, `KRITVA_FOLLOW_UP_SIP_URI`, `KRITVA_FOLLOW_UP_RETRY_MINUTES` | caller ID, OpenAI's SIP address, `15` | Call-backs after the principal decides: their own caller ID and SIP address if they differ, and the wait before the one retry. |

The realtime settings (`KRITVA_REALTIME_*`, `KRITVA_VOICE_LANGUAGES`) apply to phone calls too.

## 9. Setup (steps that need your accounts)

These steps use your OpenAI and Twilio accounts and cost money, so they are yours to do or approve. The code needs nothing else. The current setup (section 9.6) was made this way on 2026-11-22.

### 9.1 OpenAI

1. Use the same OpenAI project as `OPENAI_API_KEY`. Its ID comes back in the `openai-project` header of any API response, or from the platform's project settings. Put it in `.env` as `OPENAI_PROJECT_ID`.
2. In the project's **Webhooks** settings, create a webhook:
   - URL: `https://<public host>/api/webhooks/openai` (section 9.3 gives a public host for local testing);
   - event: `realtime.call.incoming`.
3. Copy its signing secret (shown once) into `.env` as `OPENAI_WEBHOOK_SECRET`.

### 9.2 Twilio

No SIP trunk is needed: Twilio's Programmable Voice dials OpenAI's SIP address from TwiML (`<Dial><Sip>`), which is also what lets Kritva tag each call with headers.

1. **Account.** A full (upgraded) account, because a trial account can only call verified numbers. New accounts must have an approved KYC profile (Trust Hub, Primary Customer Profile) before Twilio sells a number. Put `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` in `.env`.
2. **Number.** Any number with voice. Twilio does not sell Indian numbers without regulatory documents, so Kritva uses a US local number ($1.15 a month). Calling it from India is an international call on the caller's plan.
3. **Voice URL.** On the number: A call comes in, Webhook, `https://<public host>/api/phone/twilio/voice`, HTTP POST. Or through the API: `POST /2010-04-01/Accounts/{sid}/IncomingPhoneNumbers/{PN...}.json` with `VoiceUrl` and `VoiceMethod=POST`.
4. **Geo permissions** (Voice, Settings, Geo permissions): India must be on for outbound calls to Indian numbers. It was on by default.
5. Put the number in `.env`: `KRITVA_PHONE_CALLER_ID=+1...` and `KRITVA_PHONE_ROUTES=+1...=bed-sale,*=bed-sale`.

Every Twilio webhook carries `X-Twilio-Signature` (HMAC-SHA1 with the auth token over the URL Twilio requested and the sorted form fields). The server rebuilds the URL from `KRITVA_PUBLIC_URL`, because a proxy or tunnel changes the host it sees, and refuses a mismatch with 403 and a `twilio_signature_mismatch` log line that shows the URL it checked.

**Cost** (2026-11-22, Twilio's price list): inbound to a US local number $0.0085 a minute; outbound to Indian mobiles $0.0496 a minute, other Indian numbers $0.0699; plus OpenAI's realtime cost per minute.

### 9.3 A public URL for local testing

OpenAI and Twilio must reach the server over HTTPS. Both tunnels are installed on this Mac; the server listens on port 8787. Set `KRITVA_PUBLIC_URL` and the number's Voice URL to the tunnel too.

```bash
cloudflared tunnel --no-autoupdate --url http://localhost:8787
```

It prints `https://<random>.trycloudflare.com`; that host changes on every run, so update the OpenAI webhook URL, the Twilio Voice URL and `KRITVA_PUBLIC_URL` each time. `ngrok http 8787` works the same way, with a fixed domain on a paid plan. While the tunnel runs, the whole local API is reachable from the internet; the principal's console routes still need the access key.

### 9.4 Run and check

1. Start the server: `npm run dev -w @kritva/server`. It prints `Phone calls: on`, OpenAI's SIP URI, the webhook path, the Twilio Voice URL and whether outbound calls are on.
2. Check the tunnel and the secret:

   ```bash
   node --env-file=.env apps/server/scripts/phone-check.ts --url https://<random>.trycloudflare.com
   ```

   Expect `200`. A 400 means the secret differs between the script's `.env` and the server; a 404 means phone calls are off on that server. Adding `--ring +91XXXXXXXXXX` sends a made-up call: the server routes it, starts a session and tries to answer, and OpenAI refuses because the call does not exist. Expect `200` with `"error":"accept_failed"`. This leaves one empty session in the record.
3. Call the number, with `KRITVA_PHONE_TRACE=1` and `KRITVA_PHONE_LOG_FILE` set for the first calls. In the log, a healthy call shows `twilio_incoming`, `phone_incoming`, `phone_accepted`, `session.updated`, `input_audio_buffer.speech_started` when you speak, `output_audio_buffer.started` and `.stopped` around each reply, and `phone_ended` with `deliveryFrom: "playback_events"`.
4. The principal's console shows the session, with "Phone call connected" and, after hanging up, "Phone call ended".

### 9.5 Troubleshooting

| Symptom | Likely cause |
|---|---|
| The caller hears "an application error has occurred" | Twilio could not get TwiML: the Voice URL is wrong or the server is down (Twilio's console, Monitor, Errors shows the code), or the signature check refused it (`twilio_signature_mismatch`: `KRITVA_PUBLIC_URL` differs from the URL Twilio calls). |
| `twilio_incoming` in the log but no `phone_incoming` | OpenAI did not post the webhook: the project ID in the SIP address is not the webhook's project, or the OpenAI webhook URL is stale (a tunnel that restarted). |
| Call answered, greeting generated, but silence both ways; the trace has no `input_audio_buffer.*` and no `output_audio_buffer.*` events | The session went out before the call's audio was up: set `KRITVA_PHONE_SETUP_DELAY_MS=1500`. Also check `KRITVA_PHONE_ACCEPT` is `minimal`. |
| Webhook answered 400 | Wrong `OPENAI_WEBHOOK_SECRET`, or the server's clock is more than five minutes off. |
| Caller hears a busy or unavailable tone | Declined on purpose: see section 5 and the `phone_rejected` log line. |
| Outbound call ends at once as `failed` | Twilio refused it (the `outbound_ended` reason has Twilio's error): Geo permissions for the country, or the caller ID is not a Twilio number on the account. |
| Call drops right after it is answered | `phone_attach_failed`: the sideband could not open (API key or network). The call is hung up at once. |
| Call drops mid-conversation in development | A saved file restarted the `--watch` server, which hangs up live calls (`phone_shutdown` in the log). |

### 9.6 The current setup (2026-11-28, Cloudflare)

- Server: the Cloudflare Worker `kritva` at `https://kritva.krishnakumarsoni.com` (`docs/Kritva_Cloudflare.md`). The address is fixed, so no tunnel is needed any more.
- OpenAI project "Tinkering" (`proj_whvrXH1lLvXn3OwPSbX5qkBV`), webhook for `realtime.call.incoming`: must point at `https://kritva.krishnakumarsoni.com/api/webhooks/openai`. Until 2026-11-28 it pointed at a quick tunnel on the AWS box, which is gone.
- Twilio: a borrowed account, number +1 912 502 1960. India is on in Geo permissions. Its Voice URL (inbound only) should be `https://kritva.krishnakumarsoni.com/api/phone/twilio/voice` (POST); until 2026-11-28 it was the AWS box's address.
- Settings: `KRITVA_PUBLIC_URL` and `KRITVA_PHONE_SETUP_DELAY_MS=1500` are vars in `apps/worker/wrangler.jsonc`; `KRITVA_PHONE_ROUTES` (`+19125021960=bed-sale,*=bed-sale`), `KRITVA_PHONE_CALLER_ID`, `KRITVA_PHONE_SIP_HOST`, the Twilio credentials and the user's own number in `KRITVA_PHONE_OUTBOUND_ALLOW` are Worker secrets.

## 10. What the earlier live calls showed (2026-11-22)

The first live calls went through another SIP provider, removed in commit 68ef124 because its outbound calls could not carry audio. What they taught still shapes the code:

- **A full accept left calls silent both ways** (200 from OpenAI, no error). Accepting with model, instructions and voice only, then sending the rest as `session.update`, made audio flow (`KRITVA_PHONE_ACCEPT=minimal`, the default).
- **A server close to OpenAI was silent too.** From the Mac in India, `session.updated` came about 400 ms after the accept and calls had audio; from AWS us-west-2 it came after 118 to 219 ms and every call was silent. Applying the audio settings before the SIP media leg is up seems to leave a call without audio, so the server waits `KRITVA_PHONE_SETUP_DELAY_MS` before joining (1500 on AWS).
- **OpenAI sends `output_audio_buffer.*` on the SIP sideband**, so delivery is decided by playback events (section 6), and accepted plain RTP (`sip_media_security: "rtp"`).
- **A dev server restart dropped a live call.** The server now hangs up live calls on shutdown (section 7).
- **Routing needs the dialled number in a header**, which the earlier provider never sent. Kritva's Twilio Voice URL adds it (section 4).
- **The earlier provider's outbound calls were silent**: audio did not cross the second leg its dialling servers placed. With Twilio, the answered call is handed to OpenAI by Twilio itself, as an inbound call is.

## 11. Latency and deployment

- **Audio** goes caller → their network → Twilio (US) → OpenAI's SIP host, routed by location → the realtime model. Kritva's server is not in that path. A caller in India adds the international leg to the US number; outbound calls to India add the leg from Twilio to the Indian network.
- **Control** (Twilio's and OpenAI's webhooks, the accept, the sideband and the engine's own model calls) goes between Kritva's server and Twilio and `api.openai.com`. Deal turns wait on this path. The server runs on AWS us-west-2, next to OpenAI.
- The webhook must answer within a few seconds. It does local work (a session start) and one accept call before answering; the join and greeting run after it.
- Cost: Twilio's per-minute prices are in section 9.2; OpenAI's realtime cost per minute is as in `docs/Kritva_Realtime_Voice.md`, section 8.

## 12. Code map

| File | What it holds |
|---|---|
| `apps/server/src/phone/routes.ts` | The Twilio routes (Voice URL, outbound answer and status), the OpenAI webhook route, routing to a listing or mandate, decline codes, the accept plan (`acceptPlan`) and retries, join, the call registry, hang-up on shutdown, `GET /api/operator/phone` (setup values and calls in progress, no secrets) and `phoneFromEnv` for `main.ts`. |
| `apps/server/src/phone/front-desk.ts` | `FrontDesk`: the shared line before a listing is known; `find_listing`, keypad digits, quiet reports, the agent's own goodbye, and the hand-over (section 16). |
| `apps/server/src/voice-front-desk-guide.md` | The plain-text guide that shapes how the front desk talks, and its "Once the listing is found" section, which the negotiation's instructions take over. |
| `packages/core/src/mandate/listing-code.ts` | Listing codes: the Damm check digit, reading digits in any script, picking a free code. |
| `apps/server/src/phone/phone-call.ts` | `PhoneCall`: wraps `RealtimeCall`, sends the `session.update`, feeds `ServerPlayback`, the silence and time-limit timers, hang-up, the call-end record, event counts and the trace, and the lines it says itself. |
| `apps/server/src/phone/playback.ts` | `ServerPlayback`: the delivery rule of section 6. Pure, with an injectable clock. |
| `apps/server/src/phone/sip-headers.ts` | Reading the dialled and calling numbers from SIP headers; masking numbers for logs. |
| `apps/server/src/phone/config.ts` | Settings from the environment, number routes, OpenAI's SIP URI, the Twilio credentials. |
| `apps/server/src/phone/twilio.ts` | Twilio: the Calls API (place, hang up, fetch a recording), the TwiML that hands a call to OpenAI (`dialSipTwiml`), and webhook signatures. |
| `apps/server/src/phone/follow-up.ts` | Call-backs after the principal decides, through Twilio, recorded. |
| `apps/server/src/phone/webhook-signature.ts` | Standard Webhooks verification (checked against OpenAI's SDK) and signing for tests and the check script. |
| `apps/server/src/realtime-voice.ts` | `RealtimeCallControl` (accept, reject, hangup) on `OpenAIRealtimeConnector`; `realtimeSession(..., { noiseReduction })`. |
| `apps/server/src/voice-routes.ts` | `resolveListing`, shared with "Call Seller". |
| `packages/core/src/record/events.ts` | `voice_connection` with `ended`, `transport` and `reason`. |
| `apps/server/scripts/phone-check.ts` | The setup check of section 9.4. |
| `apps/server/src/phone/outbound.ts` | `OutboundDialer`: places calls, follows their state, matches the bridged call to its session (section 15). |
| `apps/server/test/phone.test.ts` | The tests of section 14. |

## 13. Open decisions and known limits

Placeholders, for the interaction design:

- The lines for silence and the time limit, and the 30 s and 15 minute defaults.
- A declined call is a SIP rejection, so the caller hears their network's tone. Answering and explaining ("this negotiation is paused for now") is the alternative.
- Each call starts a new negotiation. Continuing a caller's earlier negotiation would need their number stored with it, which is a product and privacy decision; today the caller's number is not recorded.
- The call stays open after an agreement or a refusal; the silence timer ends it. Hanging up after the engine's closing message is the alternative.

Known limits:

- The front desk (section 16) is how one number serves many mandates.
- Twilio's number is a US number; callers in India pay for an international call. An Indian number needs Twilio's regulatory bundle.
- A hang-up and a dropped line look the same.
- If the accept succeeds but OpenAI never connects the call, the session stays empty in the console.
- Inherited from the browser call: when an interrupted reply's partial transcript lacks one of its amounts, the controller's fidelity check says the whole reply again once after the interruption. That is the controller's existing behaviour (`#checkFidelity`), unchanged here; it may deserve its own look.
- Inbound calls through Twilio are not yet tried on a real call; outbound calls are (section 15.4).

## 14. Tests

`apps/server/test/phone.test.ts`, with a fake OpenAI connection (no network):

- settings and routes, number normalisation, SIP header reading, caller masking;
- webhook signatures: valid, several, altered body, wrong secret, replay outside five minutes, missing headers;
- the delivery rule with a manual clock: delivered and interrupted by playback events, the heard part from `audio_end_ms` and from playback time, cancelled before audio, no end event, the timing fallback both ways, waiting for proof of caller audio, a call whose audio never connected, the call ending mid-reply, and the voice model's own words being ignored;
- whole calls: unsigned webhook, ignored events, no route (404), paused listing and missing mandate (480), busy (486), a call gone while ringing, accept retries, the minimal accept and the `session.update` before the greeting (no audio format, phone noise reduction, no private amounts), the full accept mode, the recorded connection, a retried webhook, the setup route, a deal turn through the engine with delivery, an interruption with the part heard, a hang-up mid-reply with the event counts, the silence check and goodbye, a reset by speech, and the time limit.

- Twilio: the inbound Voice URL's TwiML and its headers routing the call, the webhook signature (Twilio's published example, refused unsigned, accepted signed);
- outbound calls: settings and the empty default allowlist, placing a call with tokened callback URLs and no number in the record, refusals (allowlist, malformed number, inactive session), one call per repeated request ID, a provider failure, the answer TwiML, the handed-over call joining its own session with direction "outbound", Twilio's leg hung up when the realtime side ends, no-answer, busy and failed, a late answer after the end, matching without the tag, cancelling a ringing call, and the setup view;
- call-backs: placed through Twilio with recording, the TwiML, the tagged call joining its negotiation, one retry then lapse.

Run them with the rest of the server tests: `npx vitest run --testTimeout=30000` in `apps/server`.

## 15. Outbound calls (Kritva dials the counterparty)

For negotiations where the principal gives Kritva numbers to call (the multiple-counterparties work decides how those are organised). Built on 2026-11-22, on Twilio since commit 68ef124.

### 15.1 How a call works

OpenAI's Realtime API cannot dial out: its outbound SIP calling exists only in the separate Live API (`POST /v1/live/sessions`, model `gpt-live-1`), which would mean a different model and a rewritten call controller. So Twilio places the call and hands it to OpenAI as an incoming one:

1. `call({ sessionId, to })` checks the number (allowlist, format) and that the session is active. Over `KRITVA_PHONE_MAX_CALLS` lines in use, the call waits as `queued` and goes out in order as lines free up (each queued call's negotiation is checked again before it is dialled). Then Kritva asks Twilio's Calls API (`POST /2010-04-01/Accounts/{sid}/Calls.json`) to dial `to` from Kritva's number, with `Url` (answer) and `StatusCallback` at `/api/phone/twilio/call/<token>/...`. The per-call token ties Twilio's callbacks to the call; Twilio's signature authorises them. State: dialling, then ringing (status callback `ringing`).
2. When they answer, Twilio fetches the answer URL. The TwiML hands the call to OpenAI: `<Dial><Sip>sip:proj_…@sip.api.openai.com;transport=tls?X-Kritva-Call=<token></Sip></Dial>`. State: answered.
3. OpenAI posts `realtime.call.incoming`. The webhook finds the token in the `X-Kritva-Call` header, or, without it, takes the one call that is answered and waiting for its bridge (hand-offs are serialised). It accepts the call into **that session** (no new session, no routing), and the same `PhoneCall` runs it: turns, delivery, silence and time limit. The greeting asks the engine for an outbound opener (`engine.greet({ ..., outbound: true })`: who is calling, for whom and why). State: connected. The record gets `voice_connection` with `direction: "outbound"`; the console shows "Kritva's call connected".
4. The end: their hang-up, Kritva's (`hangup(callId)`, silence, time limit) or Twilio's. Whichever side ends first, Kritva makes sure the other ends too (Twilio's final status callback ends the realtime side; the realtime side ending sets the Twilio call to `completed`). Outcomes from Twilio's final status: `completed`, `no_answer` (no-answer), `busy`, `failed` (also: answered but the bridge never arrived within 45 s, or Twilio refused the call), `cancelled` (canceled, or the principal hung up a ringing call).

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

### 15.3 Indian rules (to confirm with the user before calling anyone but themselves)

- Indian rules restrict business calls: cold calling is prohibited, numbers on the national Do-Not-Disturb registry need documented consent, and opt-outs must be honoured at once.
- Calls come from Twilio's US number over an international route. India blocks international calls that show an Indian number, so the caller ID must stay the Twilio number.

Hence the allowlist: until the user confirms these points, only numbers they list (their own, for testing) can be dialled.

Still open: the greeting. The engine's opening line is written for a call the counterparty started; the outbound opener (`engine.greet({ ..., outbound: true })`) comes with the multiple-counterparties work.

### 15.4 The first live outbound call through Twilio (2026-11-22, 06:27 UTC)

To the user's own mobile, from the AWS server. Twilio placed the call from +1 912 502 1960 ($0.0496 a minute to an Indian mobile), the answer TwiML handed it to OpenAI ($0.004 a minute for the SIP leg), and the call joined its negotiation matched by the `X-Kritva-Call` header. **Audio worked both ways**: the caller's speech started turns, both replies played to the end (`output_audio_buffer.started` and `.stopped`, delivery from playback events), and the hang-up ended both sides with outcome `completed` after 36 s.

## 16. Listing codes and the front desk

One number serves every mandate. The call cannot say which mandate the caller means, so the context is printed where the caller found the number: each live mandate has a **listing code**, four digits shown next to the line's number on its listing or ad. A call on a `code` route is answered by the **front desk**, which asks for the code, and then goes on with that mandate as one conversation.

### 16.1 What is decided in code, and what the agent decides

| Decided in code (it must be exact) | Decided by the agent, from the plain-text guide |
|---|---|
| Each mandate's code: 3 digits (100 to 999) and a Damm check digit. Every single-digit error and every swap of two neighbouring digits makes a code invalid, so a misheard code is never another listing's code. | How to pick up, introduce itself, answer "Is this ABC Corporation?", ask for the code, react to a code that did not match, and say goodbye. All of it is in `apps/server/src/voice-front-desk-guide.md`; nothing Kritva says is written in code. |
| `find_listing`: the digits (any script) are checked and looked up. The agent gets only data back: found, or `check_failed`, `wrong_length`, `not_found`, `paused`, `closed`, `busy`, `unavailable`. | Whether to ask again, digit by digit, or end the call warmly after two or three tries. |
| On a match: the negotiation starts (or a listed counterparty's open one continues), what was said so far is recorded, the same realtime session switches to the negotiation's instructions and tools, and `PhoneCall` takes the call. | The first line after the match ("Got it, the black office chairs requirement. Would you like to give your quote?"), from the guide's "Once the listing is found" section, which is added to the negotiation's instructions. No second greeting. |
| Quiet line: the agent is told after `KRITVA_PHONE_IDLE_SECONDS`, twice; then the call ends. Keypad presses are passed on as what was pressed. | What to say when the line is quiet; treating keypad digits like spoken ones. |

Before the listing is found, the agent knows nothing about any listing, so it cannot talk about the wrong one. The only names it may confirm are those in `KRITVA_PHONE_ANSWERS_FOR` and the demo listings' public names; for any other name it neither confirms nor denies, and it never reads the list out.

### 16.2 A call

```
Ring → webhook → route "code" → any live mandate with a code? (no: 480)
     → accept with the front desk session (tools: find_listing, end_call) → the agent picks up
Caller: Is this ABC Corporation?            Kritva: Yes! Who's calling?
Caller: Krishna from XYZ Supplies, about the office chairs.
Kritva: Sure, could you share the 4-digit code on the listing?
Caller: 4821                                → find_listing("4821") → found
     → the negotiation starts; the front desk turns are recorded in it
     → session.update (the negotiation's instructions, plus "Once the listing is found")
     → PhoneCall (opening "continue") → the agent answers the caller's last words
Kritva: Got it, the black office chairs requirement. Would you like to give your quote?
```

The record of the negotiation shows the whole call: Kritva's first line, each caller turn with Kritva's answer (checked like any voice answer), and then the call as usual. The connection event is recorded when the negotiation takes the call.

### 16.3 Codes on mandates

- A mandate gets its code when it first goes live (confirmed in the library, or imported from a case file). Mandates saved before codes existed get theirs when the server starts.
- The code stays through new revisions, pauses and closing, so a caller with an old ad hears that the listing is paused or closed. Deleting the mandate releases the code; released codes are reused only after all 900 have been used, oldest release first.
- Codes live in `library_listing_codes` (append-only, like the rest of the library). `MandateLibrary.findByListingCode` gives the mandate that holds a code now.
- The Mandates page shows the code in the list ("Code 4821 · Revision 2") and above the setup chat, with the line's number and **Copy for your ad** ("Call +1 912 502 1960 and give listing code 4821."). `GET /api/operator/phone` gives the line's number (`line`).

### 16.4 Turning it on, and what is not tried yet

- Set `KRITVA_PHONE_ROUTES=+19125021960=code,*=code`, and optionally `KRITVA_PHONE_ANSWERS_FOR=ABC Corporation`. Restart the server. Copy the line from the mandate into the listing or ad.
- **Keypad digits**: OpenAI reports DTMF on SIP calls (added November 2025; its guide calls the event `transport.dtmf.received`, its reference `input_audio_buffer.dtmf_event_received`; both are read). Whether Twilio passes keypad tones through `<Dial><Sip>` as RFC 2833 events is not yet tried. One call with `KRITVA_PHONE_TRACE=1`, pressing keys, shows it in the log (`front_desk_keypad`). If it works, a listing's call button can carry the code (`tel:+19125021960,4821`).
- Not tried on a live call yet: the hand-over (`session.update` mid-call that changes tools and instructions) works on the fake connection in the tests; the first live call should be watched with the trace on.
- Tests: `apps/server/test/phone.test.ts` ("the front desk asks for the listing code") and `packages/core/test/unit/listing-code.test.ts`.

## 17. Vobiz with Sarvam speech (current, since 2026-11-28)

The user chose this on 2026-11-28 when moving to Cloudflare: Vobiz carries the line, Sarvam hears and speaks, and Kritva's negotiation engine decides every word. Sarvam's hosted voice agents were considered and not used, because Kritva could then not check what was said on the line or when an offer was heard.

### 17.1 How a call works

```
Kritva → Vobiz Make Call API (from +91 80 6426 4194)              or: a caller dials +91 80 6426 4194
       → they answer; Vobiz POSTs the answer URL (signed)            → the number's application "kritva" POSTs the answer URL
Kritva  POST /api/phone/vobiz/answer[?t=<call token>]
       → <Stream bidirectional keepCallAlive contentType="audio/x-l16;rate=8000">wss://…/api/phone/vobiz/stream?t=<token></Stream>
Vobiz  → WebSocket to the Worker → the KritvaServer Durable Object (apps/worker/src/server.ts) → StreamCall
StreamCall (apps/server/src/phone/stream-call.ts)
  start  → voice_connection connected (transport phone) → engine.greet → the greeting is spoken
  media  → 20 ms PCM frames → loudness detector → one utterance → Sarvam Saaras (language per utterance)
         → engine.handleCounterpartyMessage (channel voice, with the language) → the reply is recorded
  speak  → every new outbound voice message in the record, word for word → Sarvam Bulbul → playAudio + checkpoint
  heard  → playedStream (or the end of its playing time) → engine.reportDelivery delivered
  talked over → clearAudio → reportDelivery interrupted, with the part heard
  end    → silence (still there?, then goodbye), the time limit, the engine's endCall, or the caller hanging up
         → "stop" (Vobiz hangs up: nothing follows <Stream>) → voice_connection ended with the reason
```

- **Nothing unchecked is said.** Only messages the engine recorded on the voice channel are spoken: replies, the greeting, follow-ups after the principal decides, and the call's own amount-free lines (still there, goodbye, time up, please repeat), which go through `engine.recordVoiceLine`. A short waiting line ("एक second, देख रही हूँ") fills a turn slower than 2.2 s; it names no amount and is not recorded.
- **Language.** Saaras detects the language of each utterance (`language_code: unknown`, codemix mode), and the engine replies in it. The voice follows the reply's script: Devanagari, with English words mixed in, is spoken as Hindi; Latin script as Indian English.
- **Security.** Every Vobiz webhook's `X-Vobiz-Signature-V3` is checked (HMAC-SHA256 with the account's auth token over the public URL and nonce). The media stream's handshake carries no credentials, so its URL holds a one-time token issued in that call's answer XML; an unknown or reused token is refused.
- **Numbers** stay in memory only and are masked in logs and views, as before.

### 17.2 Settings

| Setting | Where | Value |
|---|---|---|
| `KRITVA_TELEPHONY` | var | `vobiz` (`twilio` for the old path) |
| `KRITVA_VOBIZ_NUMBER` | var | `+918064264194`, Kritva's line: caller ID out, number in |
| `KRITVA_VOBIZ_INBOUND` | var | What incoming calls reach: `bed-sale` (a listing) or `mandate:man_…`; `off` declines them |
| `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` | secrets | The Vobiz account's API credentials (also the webhook signing key) |
| `SARVAM_API_KEY` | secret | Sarvam API key `kritva-cloudflare` (indus.sarvam.ai, free plan on 2026-11-28) |
| `KRITVA_SARVAM_STT_MODEL`, `KRITVA_SARVAM_TTS_MODEL`, `KRITVA_SARVAM_SPEAKER`, `KRITVA_SARVAM_PACE` | optional | Defaults `saaras:v3`, `bulbul:v3`, `simran` (a woman's voice for every language), `1` |
| `KRITVA_VOBIZ_VAD_THRESHOLD` | optional | Loudness that counts as speech (default 450); raise it on noisy lines |
| `KRITVA_PHONE_OUTBOUND_ALLOW`, `KRITVA_PHONE_MAX_CALLS`, `KRITVA_PHONE_IDLE_SECONDS`, `KRITVA_PHONE_MAX_MINUTES` | as before | Who may be called, calls at once (3), silence (30 s), time limit (10 min) |

### 17.3 Vobiz setup (done 2026-11-28, through the Vobiz API)

- Application `kritva` (app_id `64081588193478372`): answer URL `https://kritva.krishnakumarsoni.com/api/phone/vobiz/answer`, hangup URL `…/api/phone/vobiz/hangup`, both POST.
- `+91 80 6426 4194` was moved off the old SIP trunk (`8553ee4d-7b76-45e8-8715-5364168f7e54`, from the earlier OpenAI SIP setup) and linked to that application. To go back: `DELETE /numbers/%2B918064264194/application`, then `POST /numbers/%2B918064264194/assign` with that `trunk_group_id`.
- Outbound calls need nothing else: each call carries its own answer, ring and hangup URLs.

### 17.4 Measured (2026-11-28, a simulated call against production)

A script played Vobiz's side: a signed answer webhook, the media stream, and a caller's Hindi line generated by Sarvam ("…अठारह हज़ार में दे देंगे?"). Kritva greeted in Hindi, said the waiting line 3.8 s after the caller stopped, and spoke the engine's counter ("…मैं ₹19,000 में दे सकती हूँ…") 8.3 s after. The record showed the phone connection, the greeting heard, the caller's words, the reply, and the end. Of the 8.3 s, the engine's turn is about 5 s (as in chat) and Sarvam's speech about 2 s; streaming speech from Sarvam and a faster turn are the next latency steps.

### 17.5 Not yet on Vobiz

- Call-backs after the principal decides (`phone/follow-up.ts` is Twilio-only): follow-ups go to the chat.
- The front desk that asks for a listing code: incoming calls go straight to `KRITVA_VOBIZ_INBOUND`.
- Local runs: the media stream is a WebSocket served only on Cloudflare (`npm run dev -w @kritva/worker` runs it locally); the Node server answers it with 426.
