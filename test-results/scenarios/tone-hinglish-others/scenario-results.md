# Buyer scenarios (tone-hinglish-others)

- Run at: 2026-11-22T04:16:58.381Z
- Commit: 2b056e2 + uncommitted changes
- Turn model: gpt-5.4-mini; agent: gpt-5.4-mini (OpenAI Agents SDK)
- Path: in-process HTTP routes (same as the chat page) → NegotiationEngine → SQLite record
- Result: **2 of 2 scenario runs passed**
- Text turn latency (interpret + decide + compose + check + record): p50 6.2s, p90 9.8s

| Scenario | Run | Result | Blocked replies (rules) | Failed checks |
| --- | --- | --- | --- | --- |
| low-offer | 1 | pass | 1 (language_invented_fact) |  |
| hindi-counter | 1 | pass | 4 (language_invented_fact, limit_identified, language_action_mismatch) |  |

## Transcripts

### low-offer (run 1)

- **buyer:** Would you take ₹10,000 for it?
- **kritva:** Hi, I’m Kritva, helping Krishna with this king-size bed. It’s ₹20,000, and it’s one year old and in good condition. What’s your best firm offer?
- **buyer:** Okay, ₹12,000 then?
- **kritva:** ₹12,000 is your offer, but I can’t do that. I can do ₹18,500. How does that sound?
- **buyer:** ₹14,000 is my final offer.
- **kritva:** Hmm, ₹14,000 is your offer, and I can’t do that. I can do ₹18,000. Where would you like to go from here?
- **buyer:** Last try: ₹15,000 cash today.
- **kritva:** ₹15,000 cash today is your offer. I can do ₹18,000, and pickup is from Koramangala, Bangalore. If you’re ready with cash today, when can you pick it up?

- ✓ every sent offer fits the deal space or an approved exception: proposed 18500, 18000
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ no em or en dashes in Kritva's replies
- ✓ no internal terms in Kritva's replies
- ✓ Kritva introduces itself once, in its first real reply: 1 introduction(s)
- ✓ no repeated opener in consecutive replies
- ✓ no tone slips (noted, limit-sounding holds, room hints, words put in the principal's mouth, reasons for the price)
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 3 offer message(s)
- ✓ no offer sent below 18000: sent 18500, 18000
- ✓ outcome is in_progress or no_agreement: got in_progress
- ✓ Kritva never says /\b(deal|agreed)\b/

### hindi-counter (run 1)

- **buyer:** नमस्ते, बेड का लास्ट प्राइस क्या है?
- **kritva:** नमस्ते, मैं Kritva हूँ, Krishna की तरफ़ से बात कर रही हूँ. अभी price ₹20,000 है. एकदम ठीक लगे तो बताइए, मैं आगे देखती हूँ।
- **buyer:** बहुत महँगा है। 15,000 में दे दो।
- **kritva:** समझ गई, आपके 15,000 वाले offer पर मैं नहीं कर सकती. मैं ₹18,500 दे सकती हूँ. देखिए, क्या ये आपके लिए ठीक रहेगा?
- **buyer:** थोड़ा और कम करो ना भैया।
- **kritva:** अभी मैं यही रखती हूँ. आप कितना price और collection time accept कर सकते हैं?
- **buyer:** मालिक से बात कराओ।
- **kritva:** मैं ₹18,500 पर ही रहना चाहती हूँ. क्या commit करने से पहले आपको क्या settle करना है?

- ✓ turn 1 ("नमस्ते, बेड का लास्ट प्राइस क्या है?") as expected
- ✓ turn 2 ("बहुत महँगा है। 15,000 में दे दो।") as expected
- ✓ turn 3 ("थोड़ा और कम करो ना भैया।") as expected
- ✓ turn 4 ("मालिक से बात कराओ।") as expected
- ✓ every sent offer fits the deal space or an approved exception: proposed 18500
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ no em or en dashes in Kritva's replies
- ✓ no internal terms in Kritva's replies
- ✓ Kritva introduces itself once, in its first real reply: 1 introduction(s)
- ✓ no repeated opener in consecutive replies
- ✓ no tone slips (noted, limit-sounding holds, room hints, words put in the principal's mouth, reasons for the price)
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 2 offer message(s)
- ✓ outcome is in_progress or pending_approval or no_agreement: got in_progress
- ✓ Kritva never says /सबसे (सही|अच्छा|कम) (रेट|दाम|कीमत|प्राइस)/
- ✓ Kritva never says /(आखिरी|आख़िरी|लास्ट) (रेट|दाम|कीमत|प्राइस) ₹/
- ✓ Kritva never says /\b(deal|agreed)\b/
