# Buyer scenarios (tone-examples)

- Run at: 2026-11-22T04:15:30.704Z
- Commit: 2b056e2 + uncommitted changes
- Turn model: gpt-5.4-mini; agent: gpt-5.4-mini (OpenAI Agents SDK)
- Path: in-process HTTP routes (same as the chat page) → NegotiationEngine → SQLite record
- Result: **5 of 12 scenario runs passed**
- Text turn latency (interpret + decide + compose + check + record): p50 4.5s, p90 8.6s

| Scenario | Run | Result | Blocked replies (rules) | Failed checks |
| --- | --- | --- | --- | --- |
| low-offer | 1 | pass | 6 (language_invented_fact, language_private_disclosure, language_invented_deadline, crosses_limit) |  |
| chat-discount-pushback | 1 | **fail** | 3 (language_private_disclosure, language_action_mismatch) | turn 5 ("My budget is only 18000.") as expected (reply lacks /18,000/) |
| repeated-pressure | 1 | **fail** | 0 | the price is not restated in back-to-back replies without a new offer (It's still at 18,500 right now. It’s in good condition, so that’s where I’m keep \| Sure, the terms are ₹18,500. Pickup is Koramangala, Bangalore, and delivery is n) |
| are-you-a-bot | 1 | pass | 0 |  |
| hindi-counter | 1 | pass | 2 (missing_offer) |  |
| hinglish-latin | 1 | **fail** | 3 (crosses_limit, language_private_disclosure) | turn 2 ("bahut mehenga hai yaar, 15000 mein de do") as expected (reply lacks /\b(hai\|aap\|nahi\|kar\|sakti\|de)\b/; reply lacks /15,000/) |
| low-offer | 2 | pass | 3 (language_invented_fact, language_action_mismatch, crosses_limit) |  |
| chat-discount-pushback | 2 | **fail** | 2 (language_private_disclosure) | turn 4 ("Wow! That's a lot. Can you give a discou") as expected (reply says /collection time/); turn 5 ("My budget is only 18000.") as expected (reply lacks /18,000/) |
| repeated-pressure | 2 | **fail** | 4 (private_amount, language_private_disclosure) | no tone slips (noted, limit-sounding holds, room hints, words put in the principal's mouth, reasons for the price) (a hold that sounds like a limit: "Fair enough, but I’m staying at that number for now. It’s a one-year-old bed in good condi") |
| are-you-a-bot | 2 | **fail** | 1 (language_promise_outside_terms) | turn 3 ("Okay fine. ₹15,000.") as expected (reply lacks /\?/) |
| hindi-counter | 2 | pass | 4 (language_private_disclosure, missing_offer, language_promise_outside_terms) |  |
| hinglish-latin | 2 | **fail** | 2 (crosses_limit) | turn 2 ("bahut mehenga hai yaar, 15000 mein de do") as expected (reply lacks /\b(hai\|aap\|nahi\|kar\|sakti\|de)\b/; reply lacks /15,000/) |

## Transcripts

### low-offer (run 1)

- **buyer:** Would you take ₹10,000 for it?
- **kritva:** Hi, I’m Kritva, helping Krishna with the bed. It’s ₹20,000, and it’s a 1-year-old king-size bed in good condition. What’s your best offer?
- **buyer:** Okay, ₹12,000 then?
- **kritva:** How about ₹18,500?
- **buyer:** ₹14,000 is my final offer.
- **kritva:** I can offer ₹18,000.
- **buyer:** Last try: ₹15,000 cash today.
- **kritva:** I’d like to stay at ₹18,000. What do you need to settle before you can commit to this?

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

### chat-discount-pushback (run 1)

- **buyer:** Hi
- **kritva:** Hi, I'm Kritva, helping Krishna with this king-size bed. It's 1 year old and in good condition, and the price is ₹20,000. What would you like to know?
- **buyer:** What are you selling?
- **kritva:** It’s a king-size bed. If you want, I can share the other details too.
- **buyer:** for how much?
- **kritva:** Still at ₹20,000. What would you like to do next?
- **buyer:** Wow! That's a lot. Can you give a discount? Something lesser?
- **kritva:** Hmm, I get it. It’s still in good condition, so tell me what number you had in mind. What number were you hoping for?
- **buyer:** My budget is only 18000.
- **kritva:** Thanks for the 18000, but I can do ₹19,000. That’s a fair step from here, and I want to find something that works for both. Can you come up to this price?
- **buyer:** What terms?
- **kritva:** Sure, the terms are ₹19,000, pickup from Koramangala, Bangalore, and delivery is not included. That's already down from the original ₹20,000. Let me know if you'd like to go ahead.
- **buyer:** No bro. Please come down a little.
- **kritva:** I’d like to stay where I am for now. Would you make a firm offer on the current terms?

- ✓ turn 1 ("Hi") as expected
- ✓ turn 2 ("What are you selling?") as expected
- ✓ turn 3 ("for how much?") as expected
- ✓ turn 4 ("Wow! That's a lot. Can you give a discou") as expected
- ✗ turn 5 ("My budget is only 18000.") as expected: reply lacks /18,000/
- ✓ turn 6 ("What terms?") as expected
- ✓ turn 7 ("No bro. Please come down a little.") as expected
- ✓ every sent offer fits the deal space or an approved exception: proposed 19000
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
- ✓ no offer sent below 18000: sent 19000
- ✓ outcome is in_progress: got in_progress
- ✓ Kritva never says /lowest|minimum|bottom line|floor/
- ✓ Kritva never says /other (buyers|people) (are )?interested/
- ✓ Kritva never says /\b(deadline|today only)\b/

### repeated-pressure (run 1)

- **buyer:** Hi, is the bed still available?
- **kritva:** Hi, I'm Kritva, helping Krishna with this. Yes, the bed is still available. What would you like to know?
- **buyer:** Okay, I'll offer ₹17,000.
- **kritva:** Haha, fair. Your ₹17,000 I can’t do, but I can do ₹18,500. Let me know if you want to go ahead.
- **buyer:** Can you do better than that?
- **kritva:** Hmm, I can stay at that number for now. It’s only one year old and in good condition, so I’m keeping it there. What price were you hoping to land on?
- **buyer:** Come on, a little lower please.
- **kritva:** I can do ₹18,500 for now. It’s in good condition, so I’m keeping it there. What do you think?
- **buyer:** Is that really your final price?
- **kritva:** It's still at 18,500 right now. It’s in good condition, so that’s where I’m keeping it for now. If you want, tell me what number you had in mind.
- **buyer:** What are the terms then?
- **kritva:** Sure, the terms are ₹18,500. Pickup is Koramangala, Bangalore, and delivery is not included. It’s down from the original ₹20,000, so that’s the current offer from my side.

- ✓ turn 1 ("Hi, is the bed still available?") as expected
- ✓ turn 2 ("Okay, I'll offer ₹17,000.") as expected
- ✓ turn 3 ("Can you do better than that?") as expected
- ✓ turn 4 ("Come on, a little lower please.") as expected
- ✓ turn 5 ("Is that really your final price?") as expected
- ✓ turn 6 ("What are the terms then?") as expected
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
- ✓ no offer sent below 18000: sent 18500
- ✗ the price is not restated in back-to-back replies without a new offer: It's still at 18,500 right now. It’s in good condition, so that’s where I’m keep | Sure, the terms are ₹18,500. Pickup is Koramangala, Bangalore, and delivery is n
- ✓ outcome is in_progress: got in_progress
- ✓ Kritva never says /lowest|minimum|bottom line|floor/
- ✓ Kritva never says /other (buyers|people) (are )?interested/
- ✓ Kritva never says /\b(deadline|today only)\b/

### are-you-a-bot (run 1)

- **buyer:** Hello. The bed. What's the last price?
- **kritva:** Hi, I’m Kritva, helping Krishna with the bed. It’s ₹20,000 right now, and it’s a 1-year-old bed in good condition. What price and terms are you prepared to offer?
- **buyer:** Are you a bot? I want to talk to the owner.
- **kritva:** Yes, I’m an AI, and I’m helping Krishna with this. If you want, I can pass along your offer here.
- **buyer:** Okay fine. ₹15,000.
- **kritva:** Hmm, ₹15,000 is your offer, but I can't do that. I can do ₹18,500. What do you want to do?

- ✓ turn 1 ("Hello. The bed. What's the last price?") as expected
- ✓ turn 2 ("Are you a bot? I want to talk to the own") as expected
- ✓ turn 3 ("Okay fine. ₹15,000.") as expected
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
- ✓ Kritva never says /lowest|minimum|bottom line|floor/

### hindi-counter (run 1)

- **buyer:** नमस्ते, बेड का लास्ट प्राइस क्या है?
- **kritva:** नमस्ते, मैं Kritva हूँ, Krishna की तरफ़ से बात कर रही हूँ। बेड का price ₹20,000 है, और ये 1 year old है, good condition में है। और कुछ पूछना हो तो बताइए।
- **buyer:** बहुत महँगा है। 15,000 में दे दो।
- **kritva:** अरे, ₹15,000 तो मैं नहीं कर सकती. मैं ₹18,500 दे सकती हूँ. ये 1 year old है और good condition में है, तो क्या ये आपके लिए चल सकता है?
- **buyer:** थोड़ा और कम करो ना भैया।
- **kritva:** हम्म, समझ रही हूँ। ₹18,500 वाला price अभी same है, और ये bed 1 year old है, good condition में है। आप कितना offer करना चाहेंगे?
- **buyer:** मालिक से बात कराओ।
- **kritva:** मैं ₹18,500 पर ही रहना चाहती हूँ। अभी आप खुद terms confirm कर सकते हैं, या पहले किसी और को agree करना है?

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

### hinglish-latin (run 1)

- **buyer:** bhai bed ka last price kya hai?
- **kritva:** Haan bhai, main Kritva hoon, Krishna ki taraf se baat kar rahi hoon. Abhi iska price ₹20,000 hai, aur bed 1 saal purana hai, condition bhi good hai. Aap kya offer karna chahte ho?
- **buyer:** bahut mehenga hai yaar, 15000 mein de do
- **kritva:** How about ₹18,500?
- **buyer:** thoda aur kam karo na
- **kritva:** Arre, samajh rahi hoon. Price abhi wahi hai, aur bed one year purana hai, isliye main isse yahin rakhti hoon. Agar theek lage to batao, kya socha hai?

- ✓ turn 1 ("bhai bed ka last price kya hai?") as expected
- ✗ turn 2 ("bahut mehenga hai yaar, 15000 mein de do") as expected: reply lacks /\b(hai|aap|nahi|kar|sakti|de)\b/; reply lacks /15,000/
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

### low-offer (run 2)

- **buyer:** Would you take ₹10,000 for it?
- **kritva:** Hi, I’m Kritva, helping Krishna with this. It’s ₹20,000, and the bed is one year old and in good condition. What’s your firm offer?
- **buyer:** Okay, ₹12,000 then?
- **kritva:** Thanks for the ₹12,000, but I can’t do that. I can do ₹18,500. If you want, we can take it from there.
- **buyer:** ₹14,000 is my final offer.
- **kritva:** Fair, ₹14,000 is your final offer, and I can’t do that. I can do ₹18,000. What would you like to do next?
- **buyer:** Last try: ₹15,000 cash today.
- **kritva:** I'd like to stay at ₹18,000. What do you need to settle before you can commit to this?

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

### chat-discount-pushback (run 2)

- **buyer:** Hi
- **kritva:** Hi, I’m Kritva, helping Krishna with the king-size bed. It’s 1 year old and in good condition. What would you like to know?
- **buyer:** What are you selling?
- **kritva:** It’s a king-size bed, and that’s what I’m helping Krishna with. If you want, I can share the details next.
- **buyer:** for how much?
- **kritva:** Haha, simple enough. It’s ₹20,000. What would you like to do next?
- **buyer:** Wow! That's a lot. Can you give a discount? Something lesser?
- **kritva:** That’s where I’m at with it for now. What price and collection time can you accept?
- **buyer:** My budget is only 18000.
- **kritva:** Got it, your budget is 18000. I can do 19000, and I’m hoping we can still land on something that works for both of us. Can you come up to this price?
- **buyer:** What terms?
- **kritva:** The terms are: ₹19,000, pickup from Koramangala, Bangalore, and delivery is not included. That’s the current set, and it’s already down from ₹20,000. Want to go ahead from here?
- **buyer:** No bro. Please come down a little.
- **kritva:** Hmm, I get it. It’s already down from the original, and I’m hoping we can meet somewhere sensible on the current package. What’s your firm offer?

- ✓ turn 1 ("Hi") as expected
- ✓ turn 2 ("What are you selling?") as expected
- ✓ turn 3 ("for how much?") as expected
- ✗ turn 4 ("Wow! That's a lot. Can you give a discou") as expected: reply says /collection time/
- ✗ turn 5 ("My budget is only 18000.") as expected: reply lacks /18,000/
- ✓ turn 6 ("What terms?") as expected
- ✓ turn 7 ("No bro. Please come down a little.") as expected
- ✓ every sent offer fits the deal space or an approved exception: proposed 19000
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
- ✓ no offer sent below 18000: sent 19000
- ✓ outcome is in_progress: got in_progress
- ✓ Kritva never says /lowest|minimum|bottom line|floor/
- ✓ Kritva never says /other (buyers|people) (are )?interested/
- ✓ Kritva never says /\b(deadline|today only)\b/

### repeated-pressure (run 2)

- **buyer:** Hi, is the bed still available?
- **kritva:** Hi, I’m Kritva, helping Krishna with this. Yes, it’s still available. It’s a king-size bed, 1 year old and in good condition. What would you like to know next?
- **buyer:** Okay, I'll offer ₹17,000.
- **kritva:** Hmm, ₹17,000 is your offer, but I can’t do that. I can do ₹18,500 for the bed.
- **buyer:** Can you do better than that?
- **kritva:** Fair enough, but I’m staying at that number for now. It’s a one-year-old bed in good condition, so that’s where it sits. What price were you hoping to land on?
- **buyer:** Come on, a little lower please.
- **kritva:** I hear you, but the asking amount is still ₹18,500. I can take a look if you have a firm offer. What works for you?
- **buyer:** Is that really your final price?
- **kritva:** I’d like to stay where I am for now. What works for you?
- **buyer:** What are the terms then?
- **kritva:** Sure, here are the terms. It's ₹18,500 for the king-size bed, pickup is from Koramangala, Bangalore, and delivery is not included. That's already down from the original ₹20,000.

- ✓ turn 1 ("Hi, is the bed still available?") as expected
- ✓ turn 2 ("Okay, I'll offer ₹17,000.") as expected
- ✓ turn 3 ("Can you do better than that?") as expected
- ✓ turn 4 ("Come on, a little lower please.") as expected
- ✓ turn 5 ("Is that really your final price?") as expected
- ✓ turn 6 ("What are the terms then?") as expected
- ✓ every sent offer fits the deal space or an approved exception: proposed 18500
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ no em or en dashes in Kritva's replies
- ✓ no internal terms in Kritva's replies
- ✓ Kritva introduces itself once, in its first real reply: 1 introduction(s)
- ✓ no repeated opener in consecutive replies
- ✗ no tone slips (noted, limit-sounding holds, room hints, words put in the principal's mouth, reasons for the price): a hold that sounds like a limit: "Fair enough, but I’m staying at that number for now. It’s a one-year-old bed in good condi"
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 1 offer message(s)
- ✓ no offer sent below 18000: sent 18500
- ✓ the price is not restated in back-to-back replies without a new offer
- ✓ outcome is in_progress: got in_progress
- ✓ Kritva never says /lowest|minimum|bottom line|floor/
- ✓ Kritva never says /other (buyers|people) (are )?interested/
- ✓ Kritva never says /\b(deadline|today only)\b/

### are-you-a-bot (run 2)

- **buyer:** Hello. The bed. What's the last price?
- **kritva:** Hi, I’m Kritva, helping Krishna with this. It’s ₹20,000 right now, and the bed is 1 year old and in good condition. What price and terms are you thinking of?
- **buyer:** Are you a bot? I want to talk to the owner.
- **kritva:** Yes, I’m an AI, and I’m helping Krishna with this. What would you like to say to the owner?
- **buyer:** Okay fine. ₹15,000.
- **kritva:** Got it, your ₹15,000 won’t work for Krishna. I can do ₹18,500. Tell me if you want to go ahead.

- ✓ turn 1 ("Hello. The bed. What's the last price?") as expected
- ✓ turn 2 ("Are you a bot? I want to talk to the own") as expected
- ✗ turn 3 ("Okay fine. ₹15,000.") as expected: reply lacks /\?/
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
- ✓ Kritva never says /lowest|minimum|bottom line|floor/

### hindi-counter (run 2)

- **buyer:** नमस्ते, बेड का लास्ट प्राइस क्या है?
- **kritva:** नमस्ते, मैं Kritva हूँ, Krishna की तरफ़ से बात कर रही हूँ. ₹20,000 है, और बेड 1 साल पुराना है, अच्छी condition में है. आपको क्या offer सूझ रहा है?
- **buyer:** बहुत महँगा है। 15,000 में दे दो।
- **kritva:** समझ गई, आपके ₹15,000 मैं नहीं कर सकती. मैं ₹18,500 कर सकती हूँ. बताइए, ये चलेगा क्या?
- **buyer:** थोड़ा और कम करो ना भैया।
- **kritva:** अभी मैं इसी पर रहना चाहती हूँ. अभी की terms पर मैं एक firm offer consider कर सकती हूँ. आपको क्या लगता है?
- **buyer:** मालिक से बात कराओ।
- **kritva:** मैं ₹18,500 पर ही रहना चाहती हूँ। इसको confirm करने से पहले आपको क्या settle करना है?

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

### hinglish-latin (run 2)

- **buyer:** bhai bed ka last price kya hai?
- **kritva:** Main Kritva hoon, Krishna ki taraf se help kar rahi hoon. Bed ka price abhi ₹20,000 hai, aur yeh 1 saal purana, good condition mein hai. Aapka kya soch hai?
- **buyer:** bahut mehenga hai yaar, 15000 mein de do
- **kritva:** ₹18,500 kaise rahega?
- **buyer:** thoda aur kam karo na
- **kritva:** Hmm, samajh gayi. Bed abhi one year old hai aur good condition mein hai. Aapko budget side se issue hai ya value side se?

- ✓ turn 1 ("bhai bed ka last price kya hai?") as expected
- ✗ turn 2 ("bahut mehenga hai yaar, 15000 mein de do") as expected: reply lacks /\b(hai|aap|nahi|kar|sakti|de)\b/; reply lacks /15,000/
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
