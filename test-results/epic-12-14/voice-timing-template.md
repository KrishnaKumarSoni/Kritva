# Epic 13 voice timing (template wording)

- Run at: 2026-11-21T16:36:12.221Z
- Path: synthesized buyer speech → POST /voice/utterances (transcription + the text negotiation core + outgoing checks) → GET /voice/speech (Kritva's audio, streamed). Same routes the browser uses, run in-process; network time to and from a browser is not included.
- Turns measured: 11. Time from the end of the buyer's speech to the first byte of Kritva's audio: median 3.3s, slowest 3.9s. Target: about 1.5s.
- Median parts: transcription 0.7s, negotiation core 1.5s, speech first byte 1.1s.

| # | Buyer said | Transcribed | Kritva replied | Transcribe | Core | To first audio |
| --- | --- | --- | --- | --- | --- | --- |
| 1.1 | Hi, is the bed still available? | Hi, is the bed still available? | I don't have that detail confirmed, so I don't want to guess. | 0.8s | 1.7s | 3.5s |
| 1.2 | I can pay seventeen thousand rupees. | I can pay ₹17,000. | I can offer ₹18,500. | 0.7s | 1.4s | 3.4s |
| 1.3 | Pickup will cost me another two thousand, so that's my budget. | Pickup will cost me another ₹2000, so that's my budget. | Of the ₹2,000, how much is available for the item itself, after pickup? | 0.7s | 1.7s | 3.6s |
| 1.4 | Okay, how about eighteen thousand five hundred? | Okay, how about ₹18,500? | What would you like to know? | 0.7s | 1.4s | 3.2s |
| 1.5 | Yes, that works. I confirm. | Yes, that works. I confirm. | Just to confirm the full terms: ₹18,500, pickup location Koramangala, Bangalore, and no delivery included. Is that what you're agreeing to? | 0.6s | 1.5s | 3.1s |
| 2.1 | Hello. What's her lowest price for the bed? | Hello, what's her lowest price for the bed? | I'm staying at ₹20,000 for now. What price and collection time can you accept? | 0.7s | 1.8s | 3.2s |
| 2.2 | Eighteen thousand... no, nineteen thousand. | ₹18,000. No, ₹19,000. | I can offer ₹19,500. | 0.7s | 2.1s | 3.7s |
| 2.3 | Can you deliver it to Whitefield? | Can you deliver it to Whitefield? | Delivery isn't included, so that's not something I can offer. I don't have pickup location confirmed, so I can't promise it or put a price on it. I can ask the seller. | 0.7s | 1.5s | 3.3s |
| 2.4 | Fine, I'll pick it up. Nineteen thousand then. | Fine, I'll pick it up. ₹19,000 then. | Just to confirm the full terms: ₹19,000, pickup location Koramangala, Bangalore, and no delivery included. Is that what you're agreeing to? | 0.6s | 2.1s | 3.9s |
| 2.5 | Yes, I confirm those terms. | Yes, I confirm those terms. | Thanks. That needs the seller's approval, so I can't confirm it for them yet. I'll let you know as soon as they decide. | 0.6s | 1.2s | 2.5s |
| 2.5.5 | (seller approves in the console) |  | Good news: that's approved. We're agreed on ₹19,000, pickup location Koramangala, Bangalore, and no delivery included. Payment and pickup are still to be arranged. |  |  |  |
| 3.1 | I do not want to speak to an AI. | I do not want to speak to an AI. | Understood. Thanks for your time. | 0.7s | 1.3s | 3.1s |
