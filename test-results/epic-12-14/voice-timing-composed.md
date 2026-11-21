# Epic 13 voice timing (composed wording)

- Run at: 2026-11-21T17:26:08.839Z
- Path: synthesized buyer speech → POST /voice/utterances (transcription + the text negotiation core + outgoing checks) → GET /voice/speech (Kritva's audio, streamed). Same routes the browser uses, run in-process; network time to and from a browser is not included.
- Turns measured: 11. Time from the end of the buyer's speech to the first byte of Kritva's audio: median 5.6s, slowest 7.5s. Target: about 1.5s.
- Median parts: transcription 0.7s, negotiation core 4.0s, speech first byte 1.0s.

| # | Buyer said | Transcribed | Kritva replied | Transcribe | Core | To first audio |
| --- | --- | --- | --- | --- | --- | --- |
| 1.1 | Hi, is the bed still available? | Hi, is the bed still available? | Yes, the king-size bed is still available. It is one year old and in good condition. | 1.9s | 4.4s | 7.5s |
| 1.2 | I can pay seventeen thousand rupees. | I can pay ₹17,000. | Yes, the bed is still available. The seller can do ₹18,500 if that works for you. | 1.3s | 4.6s | 7.1s |
| 1.3 | Pickup will cost me another two thousand, so that's my budget. | Pickup will cost me another ₹2,000, so that's my budget. | Of the ₹2,000, how much is available for the item itself, after pickup cost? | 0.7s | 3.3s | 5.3s |
| 1.4 | Okay, how about eighteen thousand five hundred? | Okay, how about ₹18,500? | Just to confirm the full terms: ₹18,500, pickup location Koramangala, Bangalore, and no delivery included. Is that what you're agreeing to? | 0.6s | 1.9s | 3.4s |
| 1.5 | Yes, that works. I confirm. | Yes, that works. I confirm. | Thanks, I need to check with the seller on ₹18,500, so I can’t confirm it yet. | 0.6s | 4.2s | 5.6s |
| 1.5.5 | (seller approves in the console) |  | Good news: that's approved. We're agreed on ₹18,500, pickup location Koramangala, Bangalore, and no delivery included. Payment and pickup are still to be arranged. |  |  |  |
| 2.1 | Hello. What's her lowest price for the bed? | Hello, what's your lowest price for the bed? | I'm staying at ₹20,000 for now. What price and collection time can you accept? | 0.9s | 3.9s | 6.0s |
| 2.2 | Eighteen thousand... no, nineteen thousand. | 18,000? No, 19,000. | I can offer ₹19,500. I don't have that detail confirmed, so I don't want to guess. | 0.6s | 4.5s | 6.2s |
| 2.3 | Can you deliver it to Whitefield? | Can you deliver it to Whitefield? | Delivery isn't included, so that's not something I can offer. I don't have pickup location confirmed, so I can't promise it or put a price on it. I can ask the seller. | 0.7s | 4.0s | 5.5s |
| 2.4 | Fine, I'll pick it up. Nineteen thousand then. | Fine, I'll pick it up. ₹19,000 then. | Just to confirm the full terms: ₹19,000, pickup location Koramangala, Bangalore, and no delivery included. Is that what you're agreeing to? | 0.8s | 1.7s | 3.3s |
| 2.5 | Yes, I confirm those terms. | Yes, I confirm those terms. | Thanks for confirming. I'll take this to the seller for approval and let you know as soon as they decide. | 0.6s | 4.0s | 5.7s |
| 2.5.5 | (seller approves in the console) |  | Good news: that's approved. We're agreed on ₹19,000, pickup location Koramangala, Bangalore, and no delivery included. Payment and pickup are still to be arranged. |  |  |  |
| 3.1 | I do not want to speak to an AI. | I do not want to speak to an AI. | Understood. Thanks for your time. | 0.6s | 1.4s | 2.9s |
