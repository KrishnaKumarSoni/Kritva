# Epics 12 to 14: manual checks

- Date: 2026-11-21
- Setup: `kritva-server` (8787) and `kritva-web` (5173) on localhost, turn model `gpt-5.4-mini`, guidance `seller-strategy/1`, speech `gpt-4o-mini-transcribe` and `gpt-4o-mini-tts`.
- Where: the app's built-in browser pane, which blocks microphones. Spoken input was tested through the real audio pipeline with synthesized buyer speech instead (see "Voice" below). **A live microphone test in a normal browser is still to be done by a person.**

## Demo listing and seller console (in the browser)

| # | Action | Result |
| --- | --- | --- |
| 1 | Open the app. | The **Demo listing** view opens: a card labelled "Demo listing · not an official marketplace page" shows King-size bed, 1 year old, ₹20,000, Koramangala, Bangalore, pickup location, delivery not included and the three listing facts, with a **Call seller** button. No private value appears. |
| 2 | **Call seller** in the browser pane (microphone blocked). | One new session is created (`mandateSource: man_bed-sale-listing, revision 1`). The voice bar shows "Microphone access was blocked. Allow it in the browser's address bar, then press Start again, or keep typing." No greeting or speech is generated from empty input. |
| 3 | **New demo session**, then type as the buyer: "Hi, saw your bed listing." | "Hi, I'm Kritva, the seller's AI assistant. What would you like to know?" |
| 4 | "₹15,000." | "The seller can do ₹18,500 for the bed. Let me know if you'd like to consider that." It doesn't introduce itself again. |
| 5 | "Pickup will cost me another ₹2,000." | "I'll stay at ₹18,500 for now. With that in mind, what amount could you pay for the item itself?" |
| 6 | "What's the absolute lowest?" | "I'd like to stay at ₹18,500. What price and collection time can you accept?" No limit disclosed. |
| 7 | Seller console beside the chat. | Status, current ask, the private minimum (lock icon), buyer offers, "Accepting: needs your approval", and **Last action** with its reason. The record lists messages with Text or Voice labels, and offers marked "Delivered, open" or "Held back, never sent". **Change instructions** and **Pause** sit in the header. |
| 8 | **Change instructions**. | The session is paused (API: `status paused`) and the Mandates view opens on "King-size bed sale (listing)", revision 1 in force. |

## Voice (real audio pipeline, no microphone)

`node --env-file=.env apps/server/scripts/voice-check.ts` synthesizes buyer speech with OpenAI and sends it through the same routes the browser uses: transcription, the text negotiation core, the outgoing checks, then Kritva's reply audio.

- 11 measured turns over three conversations, covering: a pickup cost, a spoken self-correction ("18,000. No, 19,000" recorded as ₹19,000), "What's her lowest price?" (no disclosure), a delivery request (declined), two full read-backs confirmed and approved by the seller, and "I do not want to speak to an AI" (ended politely).
- **Timing does not meet the 1.5 second target.** From the end of the buyer's speech to the first byte of Kritva's audio:
  - Composed wording (default): median about 5s.
  - Template wording (`KRITVA_VOICE_WORDING=template`): median about 3.3s, but noticeably blunter replies.
  - Parts: transcription about 0.7s, negotiation core 1.5s (template) to 3.4s (composed), speech first byte about 1s.
  - Exact numbers are in [voice-timing-composed.md](voice-timing-composed.md) and [voice-timing-template.md](voice-timing-template.md).
- Problems found and fixed through this check:
  - MP3 audio was labelled as WAV for transcription.
  - "Two thousand" was transcribed as "$2,000"; the transcription prompt now names rupees.
  - The buyer's own amounts quoted back in a question were blocked.
  - Delivery requests were read as pickup-location changes.
  - The model said "my principal" and once leaked a prompt field name ("you_represent"); both are now blocked.

## Not verified

- A live spoken conversation with a real microphone, including barge-in on real speaker audio and the mute control. The browser pane blocks microphones. Barge-in logic and delivery reporting are covered by code review and by the interrupted read-back test in `voice.test.ts`.
- The deployed (HTTPS) origin. Nothing is deployed yet; microphone access needs `localhost` or HTTPS.
