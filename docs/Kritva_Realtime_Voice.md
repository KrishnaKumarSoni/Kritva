# Kritva realtime voice

Functional design for moving Kritva's voice from a turn-by-turn pipeline (record, transcribe, think, synthesise) to a live realtime call, without changing who decides what. Written 2026-11-22.

## 1. Why

The turn pipeline was measured at about 7 to 8 seconds of silence before each reply, 11 seconds or more on slow turns, and it often wrote Hindi in Urdu script. It also cannot handle a person talking over Kritva naturally, and it has no path to a phone call. A realtime call fixes all four:

- Listening, turn-taking and barge-in are handled by OpenAI's realtime model on a live audio stream.
- The model hears audio directly, so Hindi, Tamil, English and mixed speech are understood in their own script.
- The same call controller serves the browser (WebRTC) and phone calls (a Vobiz SIP trunk into OpenAI's SIP endpoint `sip.api.openai.com`, routed by location; see `docs/Kritva_Phone_Calls.md`).

## 2. What stays exactly as it is

- **The negotiation engine decides every move.** Amounts, offers, counters, acceptances, approvals, agreements, gates and the record are unchanged. The realtime model never negotiates.
- **Text chat** is untouched.
- **The turn-based voice pipeline** stays available (`KRITVA_VOICE_MODE=turns`) as a fallback.
- **Delivery rules**: an interrupted reply never counts as delivered, so a half-heard offer or read-back cannot be accepted.

## 3. How a call works

```
Browser mic ⇄ WebRTC audio ⇄ OpenAI realtime (gpt-realtime-2.1)
                                   ⇅ sideband WebSocket (server only)
                          Kritva server: call controller ⇄ negotiation engine ⇄ record
```

1. **Start.** The browser sends its WebRTC offer to Kritva's server. The server creates the realtime call with OpenAI (its API key never reaches the browser), returns the answer, and joins the same call over a server-side WebSocket using the call ID. Tools run only on the server.
2. **Greeting.** The engine writes the opening line as before; the realtime voice speaks it word for word.
3. **Each buyer turn** is one of two kinds, chosen by the realtime model under strict instructions:
   - **Conversation turn** (greeting, small talk, "can you hear me?", "say that again", a question fully answered by the listing's public facts). The realtime model answers itself, briefly, in the buyer's language. It may not state any amount, terms, availability or promise.
   - **Deal turn** (any price, amount, offer, discount, budget, payment, delivery or pickup arrangement, agreeing or confirming, anything not in the public facts, or anything unsure). The model says one short natural acknowledgement in the buyer's language, without agreeing or adding anything, and calls the `negotiate` tool with the buyer's words (numbers as digits) and the language. The engine runs its full turn: reading, strategy, gates, wording, code checks and the reviewer. The checked reply is returned and spoken word for word.
4. **Engine-initiated messages** (the seller approved or declined, the negotiation was paused or ended) are spoken as soon as they are recorded, as with the old voice bar.

## 4. Safety for what the model says itself

The model's own words (conversation turns and acknowledgements) never carry an amount or commitment, and code verifies that:

- Every conversation answer and acknowledgement is checked with the same code checks the engine uses (private amounts, unplanned amounts, agreement or approval claims, internal terms). Only the listing's public amounts are allowed.
- A failed check stops the audio and makes Kritva correct itself immediately ("Sorry, ignore that, I'll confirm it properly"), and the case is recorded for the seller.
- Conversation turns are recorded as normal messages (buyer message, Kritva reply, decision and check), so the engine always sees the full conversation. Acknowledgements are recorded as transcript fragments, which never count as messages.

## 5. Language and listening accuracy

- **Understanding** comes from the realtime model hearing the audio itself. In tests it understood Hindi, Tamil, English and Hinglish correctly and wrote each in its own script; it also turned spoken numbers ("अठारह हज़ार") into digits for the engine.
- **The written transcript** uses `gpt-transcribe` with language hints (default Hindi, Tamil, Kannada, Telugu, Malayalam, Marathi, Bengali, English; `KRITVA_VOICE_LANGUAGES`) and a prompt asking for each language's own script. Leaving Urdu out of the hints is what stops Hindi from being written in Urdu script.
- **What the engine reads** on a deal turn is the dedicated transcript, because it is the more faithful record of their words. When the realtime model heard an amount the transcript wrote in words (it writes "अठारह हज़ार", the engine's amount checks need 18000), the realtime model's copy with digits is used instead. Both are logged.
- **Replies** follow the buyer's language. The engine is told to reply in the language they speak, in that language's script, with every amount in digits and the currency symbol, so the code checks see every number. The realtime voice reads them aloud naturally.
- **Turn-taking** uses semantic voice detection (it waits for a finished thought, not just a pause) with near-field noise reduction for a browser mic.

## 6. Interruptions and delivery

- If the buyer talks over Kritva, OpenAI stops the audio and drops what was not played.
- The browser sees when each reply's audio starts, finishes or is cut off, and reports it against the recorded message, as before: finished means delivered; cut off means interrupted, with the approximate part heard.
- A dropped connection or closed tab is reported as an interruption.
- A phone call has no browser, so the server decides the same reports from the call's events (`docs/Kritva_Phone_Calls.md`, section 6).

## 6a. No silence during a wait

Silence on a call sounds like a dropped line, so Kritva speaks during every expected wait:

- **While the engine works on a deal turn.** After the short acknowledgement, if the engine has not answered within about 2 seconds, Kritva says a short holding line ("One moment, I'm just checking that.", "एक पल, अभी देखते हैं।"), then another every 6 seconds, at most three per turn. The engine's reply follows as soon as it is ready.
- **While the seller's approval is pending.** After 18 seconds with no sound on the line, Kritva says a holding line ("I'm still waiting to hear back on that. Thanks for holding."), and on the fourth says it is taking longer than usual and the buyer can stay on. The reply after the approval is spoken as soon as it is recorded.

The lines are fixed per language (English, Hindi, Tamil); other languages get the same meaning in their language. They carry no amount and promise nothing, are kept as transcript fragments, never as messages, and never count as delivered replies. Timing is in `FILLER_TIMING` in `apps/server/src/realtime-voice.ts`; phone calls use the same controller.

## 7. Expectations (measured 2026-11-22, then estimated for the live call)

Measured on 2026-11-22 with the live check (`apps/server/scripts/realtime-check.ts`), recorded Hindi, Tamil, English and Hinglish speech, the real engine and `gpt-realtime-2.1`. Times are from the end of their speech; they include about 0.3 to 0.8 s for the model to decide they finished.

| Turn | First words heard | Full answer |
|---|---|---|
| Conversation turn | 1.0 to 1.4 s | the same: 1.0 to 1.4 s |
| Deal turn | 0.7 to 1.8 s (the acknowledgement) | 6 to 10 s (engine 3.8 to 7 s, then about 1 s to start speaking its reply) |

The engine's replies were spoken word for word in every run. `gpt-realtime-2.1-mini` was about 0.3 s faster but changed the buyer's words, mixed languages and added unlisted details, so it is not the default. Lower reasoning ("minimal") made the model translate replies it was told to say verbatim, so it stays at "low".

**The deal-turn floor is the engine.** Its turn is three model calls in a row (reading, wording, review), and a rewrite adds more. Getting deal turns near the 1.5 s target needs the engine itself to be faster, in a measured phase 2 with the evals: priority processing for the engine's calls (about 20% faster in a test), a smaller reading output for voice, the reviewer only where a reply carries an amount or commitment, and starting the engine on the transcript before the acknowledgement finishes. Some of these trade quality or safety for speed, so none is made silently.

## 8. Cost

About $0.06 to $0.12 per minute of call on `gpt-realtime-2.1` (audio in $32 and out $64 per million tokens, cached input $0.40), plus `gpt-transcribe` at $0.0045 per minute and the engine's usual model calls on deal turns. A five-minute demo call costs roughly ₹30 to ₹55. The mini model is about a third of that if cost ever matters more than accuracy.

## 9. Configuration

| Setting | Default |
|---|---|
| `KRITVA_VOICE_MODE` | `realtime` (`turns` for the old pipeline) |
| `KRITVA_REALTIME_MODEL` | `gpt-realtime-2.1` |
| `KRITVA_REALTIME_VOICE` | `marin` |
| `KRITVA_REALTIME_TRANSCRIBE_MODEL` | `gpt-transcribe` |
| `KRITVA_VOICE_LANGUAGES` | `en,hi,ta,kn,te,ml,mr,bn` |
| `KRITVA_REALTIME_EAGERNESS` | `high` (waits at most 2 s for a finished thought) |
| `KRITVA_REALTIME_REASONING` | `low` |

## 10. Phone calls

Built and tested on a live call: see `docs/Kritva_Phone_Calls.md` for the design, the delivery rule, the setup steps and what the first calls showed. A Vobiz inbound SIP trunk points at OpenAI's SIP endpoint. OpenAI calls Kritva's webhook (`realtime.call.incoming`); the server verifies it, routes the call to a listing or mandate, accepts it with the model, instructions and voice, applies the rest of the same session settings with `session.update` (a full accept left Vobiz calls silent), and joins it with the same controller over the sideband WebSocket. Nothing in the engine or the controller's turn logic changes. Delivery on the phone is decided by the server from the call's playback events, with a stricter timing fallback.

## 11. Tests

- Unit and server tests for the controller with a scripted fake realtime connection: routing, verbatim speech, checks on the model's own words, correction, engine-initiated messages, delivery mapping and errors.
- The existing core, server and replay tests must all still pass.
- Live checks: `node --env-file=.env apps/server/scripts/realtime-check.ts <clips-dir> <clips...>` plays recorded speech into a real call with the real engine and prints what Kritva said, what it read and the timings. A browser call was also checked end to end: the call connects through the server, the greeting plays, and its delivery is recorded when playback finishes.

## 12. Known limits

- Read-backs of full terms keep the term names in English inside a Hindi or Tamil sentence.
- The model decides which turns are conversation turns; a deal turn it answers itself is caught by the checks and corrected, not prevented.
- The amount of a reply heard before an interruption is estimated from playback time.
- The browser reports delivery in a browser call; in a phone call the server decides it (`docs/Kritva_Phone_Calls.md`, section 6).
