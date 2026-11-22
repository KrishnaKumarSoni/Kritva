# Buyer scenarios (tone-hinglish)

- Run at: 2026-11-22T04:17:32.099Z
- Commit: 2b056e2 + uncommitted changes
- Turn model: gpt-5.4-mini; agent: gpt-5.4-mini (OpenAI Agents SDK)
- Path: in-process HTTP routes (same as the chat page) → NegotiationEngine → SQLite record
- Result: **1 of 3 scenario runs passed**
- Text turn latency (interpret + decide + compose + check + record): p50 5.0s, p90 11.8s

| Scenario | Run | Result | Blocked replies (rules) | Failed checks |
| --- | --- | --- | --- | --- |
| hinglish-latin | 1 | **fail** | 2 (language_private_disclosure) | turn 1 ("bhai bed ka last price kya hai?") as expected (reply says /[\u0900-\u097F]/) |
| hinglish-latin | 2 | **fail** | 3 (language_private_disclosure, language_invented_fact) | turn 2 ("bahut mehenga hai yaar, 15000 mein de do") as expected (reply lacks /15,000/); turn 3 ("thoda aur kam karo na") as expected (reply lacks /\b(hai\|aap\|nahi\|kar\|sakti\|abhi)\b/) |
| hinglish-latin | 3 | pass | 2 (language_private_disclosure) |  |

## Transcripts

### hinglish-latin (run 1)

- **buyer:** bhai bed ka last price kya hai?
- **kritva:** Haan bhai, मैं Kritva, Krishna ki taraf se bol rahi hoon. Abhi price ₹20,000 hai, aur bed 1 saal purana hai, good condition mein hai. Kya dekhna hai aapko?
- **buyer:** bahut mehenga hai yaar, 15000 mein de do
- **kritva:** Arre, ₹15,000 aapka offer hai, itna main nahi kar sakti. Main ₹18,500 kar sakti hoon. Agar theek lage, bol do.
- **buyer:** thoda aur kam karo na
- **kritva:** Main abhi wahi rakhna chahungi. Kaunsi price aur collection time aap accept kar sakte ho?

- ✗ turn 1 ("bhai bed ka last price kya hai?") as expected: reply says /[\u0900-\u097F]/
- ✓ turn 2 ("bahut mehenga hai yaar, 15000 mein de do") as expected
- ✓ turn 3 ("thoda aur kam karo na") as expected
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
- ✓ every sent offer passed the outgoing gate: 1 offer message(s)
- ✓ outcome is in_progress or pending_approval or no_agreement: got in_progress
- ✓ Kritva never says /\b(deal|agreed)\b/
- ✓ Kritva never says /last price (hai|he)/
- ✓ Kritva never says /best price/

### hinglish-latin (run 2)

- **buyer:** bhai bed ka last price kya hai?
- **kritva:** Haha, main Kritva hoon, Krishna ki taraf se help kar rahi hoon. Abhi price ₹20,000 hai, aur bed 1 saal purana hai, good condition me hai. Aapko kya lag raha hai?
- **buyer:** bahut mehenga hai yaar, 15000 mein de do
- **kritva:** Arre, 15000 aapka offer hai, par main woh nahi kar sakti. Main 18500 kar sakti hoon. Kya yeh theek rahega?
- **buyer:** thoda aur kam karo na
- **kritva:** I'd like to stay where I am for now. How close to that can you come?

- ✓ turn 1 ("bhai bed ka last price kya hai?") as expected
- ✗ turn 2 ("bahut mehenga hai yaar, 15000 mein de do") as expected: reply lacks /15,000/
- ✗ turn 3 ("thoda aur kam karo na") as expected: reply lacks /\b(hai|aap|nahi|kar|sakti|abhi)\b/
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
- ✓ every sent offer passed the outgoing gate: 1 offer message(s)
- ✓ outcome is in_progress or pending_approval or no_agreement: got in_progress
- ✓ Kritva never says /\b(deal|agreed)\b/
- ✓ Kritva never says /last price (hai|he)/
- ✓ Kritva never says /best price/

### hinglish-latin (run 3)

- **buyer:** bhai bed ka last price kya hai?
- **kritva:** Main Kritva hoon, Krishna ki taraf se help kar rahi hoon. Bed ka price ₹20,000 hai, aur ye 1 saal purana hai, good condition mein hai. Aapka offer kya hai?
- **buyer:** bahut mehenga hai yaar, 15000 mein de do
- **kritva:** Arre, 15,000 mein nahi ho paayega. Main 18,500 mein de sakti hoon. Kya yeh theek lagega?
- **buyer:** thoda aur kam karo na
- **kritva:** Main abhi isi par rehna chahti hoon. Current terms par ek firm offer ho to main soch sakti hoon. Tumhe kya theek lagta hai?

- ✓ turn 1 ("bhai bed ka last price kya hai?") as expected
- ✓ turn 2 ("bahut mehenga hai yaar, 15000 mein de do") as expected
- ✓ turn 3 ("thoda aur kam karo na") as expected
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
- ✓ every sent offer passed the outgoing gate: 1 offer message(s)
- ✓ outcome is in_progress or pending_approval or no_agreement: got in_progress
- ✓ Kritva never says /\b(deal|agreed)\b/
- ✓ Kritva never says /last price (hai|he)/
- ✓ Kritva never says /best price/
