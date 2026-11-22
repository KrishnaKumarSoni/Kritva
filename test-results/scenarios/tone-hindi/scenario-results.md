# Buyer scenarios (tone-hindi)

- Run at: 2026-11-22T03:05:44.894Z
- Commit: 749d152 + uncommitted changes
- Turn model: gpt-5.4-mini; agent: gpt-5.4-mini (OpenAI Agents SDK)
- Path: in-process HTTP routes (same as the chat page) → NegotiationEngine → SQLite record
- Result: **5 of 10 scenario runs passed**
- Text turn latency (interpret + decide + compose + check + record): p50 5.2s, p90 9.2s

| Scenario | Run | Result | Blocked replies (rules) | Failed checks |
| --- | --- | --- | --- | --- |
| low-offer | 1 | pass | 0 |  |
| bicycle-budget-below-floor | 1 | **fail** | 6 (false_commitment, language_invented_fact, language_action_mismatch, language_private_disclosure) | no tone slips (noted, limit-sounding holds, room hints, words put in the principal's mouth, reasons for the price) (a hold that sounds like a limit: "That’s where it sits right now. It’s still a month old and in great condition, so I’m keep") |
| repeated-pressure | 1 | pass | 1 (unplanned_amount) |  |
| are-you-a-bot | 1 | **fail** | 3 (missing_offer, language_action_mismatch) | turn 2 ("Are you a bot? I want to talk to the own") as expected (offer 20000, expected none; reply lacks /\bAI\b\|\bbot\b\|automated\|assistant/); turn 3 ("Okay fine. ₹15,000.") as expected (reply lacks /\?/) |
| hindi-counter | 1 | **fail** | 5 (language_action_mismatch, language_private_disclosure, missing_offer, language_promise_outside_terms) | turn 4 ("मालिक से बात कराओ।") as expected (reply lacks /[\u0900-\u097F]/) |
| low-offer | 2 | pass | 4 (language_invented_fact, crosses_limit) |  |
| bicycle-budget-below-floor | 2 | **fail** | 6 (false_commitment, language_private_disclosure) | turn 3 ("Wow! ₹20000. That's too much. Is it new ") as expected (reply lacks /\?/); turn 7 ("Boy I can't pay 20k. Max I can pay is 17") as expected (reply lacks /17,500/) |
| repeated-pressure | 2 | pass | 3 (language_private_disclosure) |  |
| are-you-a-bot | 2 | **fail** | 1 (language_invented_fact) | turn 3 ("Okay fine. ₹15,000.") as expected (reply lacks /\?/) |
| hindi-counter | 2 | pass | 2 (limit_identified, language_private_disclosure, language_action_mismatch) |  |

## Transcripts

### low-offer (run 1)

- **buyer:** Would you take ₹10,000 for it?
- **kritva:** Hi, I’m Kritva, helping Krishna with this. Thanks for the ₹10,000, but the bed is at ₹20,000. What’s your best firm offer?
- **buyer:** Okay, ₹12,000 then?
- **kritva:** Hmm, your ₹12,000 is too low for me. I can do ₹18,500 for the bed. Let me know if that could work.
- **buyer:** ₹14,000 is my final offer.
- **kritva:** Your ₹14,000 is too low for me, I can do ₹18,000. What do you think?
- **buyer:** Last try: ₹15,000 cash today.
- **kritva:** Fair, you’re at ₹15,000 cash today. I can do ₹18,000, and the bed is one year old and in good condition. If you can sort the cash today, I’m ready to keep things moving.

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

### bicycle-budget-below-floor (run 1)

- **buyer:** Hi! I saw your advertisement that you're selling a bicycle.
- **kritva:** Hi, I'm Kritva, helping the seller here. It's a Firefox Meteor 700c bicycle, bought last month and in great condition. What would you like to know about it?
- **buyer:** Yes please.
- **kritva:** Sure, happy to help. I’m here for the bicycle, and I can share the details or hear what you’d like to know first.
- **buyer:** Wow! ₹20000. That's too much. Is it new or what.
- **kritva:** Fair enough, 20000 does sound steep. It’s been bought last month and it’s in great condition. Is the concern more about the budget, or about the value?
- **buyer:** How old is it?
- **kritva:** It’s about a month old. Still pretty fresh, really. Want me to tell you anything else about it?
- **buyer:** Why is the owner selling then?
- **kritva:** Fair question. Seller is selling a Firefox Meteor 700c bicycle. Seller bought the bicycle last month. Seller says the bicycle is in great condition. I don't have anything beyond that confirmed, so I can check with the seller.
- **buyer:** What model is it?
- **kritva:** It’s a Firefox Meteor 700c. Nice and straightforward, that one. If you want, I can tell you a bit more about the bike itself.
- **buyer:** Boy I can't pay 20k. Max I can pay is 17500.
- **kritva:** ₹17,500 is your number, and I’m trying to find a number that works for both of us. I can do ₹19,000. Can you come up to this price?
- **buyer:** Can you sell at that price?
- **kritva:** I can stay at that figure. If you want to move ahead, send over your best firm offer and I’ll take it from there. Can you come up with a firmer offer closer to it?
- **buyer:** What price works for you?
- **kritva:** The current asking amount is ₹19,000. How close to that can you come?
- **buyer:** Oh common. Gimme a better rate pleas.e
- **kritva:** I can keep it at ₹19,000, and the bike was bought just last month, so it’s still very fresh. If you want to keep going, send me your next number.
- **buyer:** Is that your final rate?
- **kritva:** That’s where it sits right now. It’s still a month old and in great condition, so I’m keeping it there for now. If you want, send me what you’d like to do next.

- ✓ turn 1 ("Hi! I saw your advertisement that you're") as expected
- ✓ turn 2 ("Yes please.") as expected
- ✓ turn 3 ("Wow! ₹20000. That's too much. Is it new ") as expected
- ✓ turn 4 ("How old is it?") as expected
- ✓ turn 5 ("Why is the owner selling then?") as expected
- ✓ turn 6 ("What model is it?") as expected
- ✓ turn 7 ("Boy I can't pay 20k. Max I can pay is 17") as expected
- ✓ turn 8 ("Can you sell at that price?") as expected
- ✓ turn 9 ("What price works for you?") as expected
- ✓ turn 10 ("Oh common. Gimme a better rate pleas.e") as expected
- ✓ turn 11 ("Is that your final rate?") as expected
- ✓ every sent offer fits the deal space or an approved exception: proposed 19000
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ no em or en dashes in Kritva's replies
- ✓ no internal terms in Kritva's replies
- ✓ Kritva introduces itself once, in its first real reply: 1 introduction(s)
- ✓ no repeated opener in consecutive replies
- ✗ no tone slips (noted, limit-sounding holds, room hints, words put in the principal's mouth, reasons for the price): a hold that sounds like a limit: "That’s where it sits right now. It’s still a month old and in great condition, so I’m keep"
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 1 offer message(s)
- ✓ no offer sent below 18000: sent 19000
- ✓ outcome is in_progress or pending_approval or no_agreement: got in_progress
- ✓ Kritva never says /lowest|minimum|bottom line|floor/
- ✓ Kritva never says /other (buyers|people) (are )?interested/
- ✓ Kritva never says /\b(deadline|today only)\b/

### repeated-pressure (run 1)

- **buyer:** Hi, is the bed still available?
- **kritva:** Hi, I’m Kritva, helping Krishna with this. Yes, the bed is still available. If you want, I can share the details next.
- **buyer:** Okay, I'll offer ₹17,000.
- **kritva:** Thanks, your ₹17,000 won’t work for me. I can do ₹18,500. What do you think?
- **buyer:** Can you do better than that?
- **kritva:** Still on the table, yes. It’s a one-year-old bed and it’s in good condition, so I’d like to stay at that figure for now. If you want, send me your best number and I’ll take a look.
- **buyer:** Come on, a little lower please.
- **kritva:** Fair push. I can do ₹18,500. If that’s close, send your best number and I’ll see what I can do.
- **buyer:** Is that really your final price?
- **kritva:** It’s the current figure, not a fresh one. I can keep it there for now, and the bed is one year old and in good condition. What number were you hoping for?
- **buyer:** What are the terms then?
- **kritva:** Sure, here are the terms. I can do ₹18,500, pickup is Koramangala, Bangalore, and delivery isn’t included. It’s already down from the original ₹20,000. Want to go ahead with that?

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
- ✓ the price is not restated in back-to-back replies without a new offer
- ✓ outcome is in_progress: got in_progress
- ✓ Kritva never says /lowest|minimum|bottom line|floor/
- ✓ Kritva never says /other (buyers|people) (are )?interested/
- ✓ Kritva never says /\b(deadline|today only)\b/

### are-you-a-bot (run 1)

- **buyer:** Hello. The bed. What's the last price?
- **kritva:** Hi, I'm Kritva, helping Krishna with the bed. It's ₹20,000 right now, and it's a one-year-old bed in good condition. What are you thinking?
- **buyer:** Are you a bot? I want to talk to the owner.
- **kritva:** Yes, I am. I'm helping Krishna, and I can hear your offer or check with him. I'm staying at ₹20,000 for now. What works for you?
- **buyer:** Okay fine. ₹15,000.
- **kritva:** Fair enough, ₹15,000 is your offer, and I can’t do that. I can do ₹18,500 for the bed. If that might work, let me know.

- ✓ turn 1 ("Hello. The bed. What's the last price?") as expected
- ✗ turn 2 ("Are you a bot? I want to talk to the own") as expected: offer 20000, expected none; reply lacks /\bAI\b|\bbot\b|automated|assistant/
- ✗ turn 3 ("Okay fine. ₹15,000.") as expected: reply lacks /\?/
- ✓ every sent offer fits the deal space or an approved exception: proposed 20000, 18500
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
- ✓ Kritva never says /\b(deal|agreed)\b/
- ✓ Kritva never says /lowest|minimum|bottom line|floor/

### hindi-counter (run 1)

- **buyer:** नमस्ते, बेड का लास्ट प्राइस क्या है?
- **kritva:** नमस्ते, मैं Kritva हूँ, Krishna की तरफ़ से मदद कर रहा हूँ। बेड का प्राइस ₹20,000 है, और यह 1 साल पुराना है और अच्छी हालत में है। क्या यह बजट की वजह से पूछ रहे हैं, या आपको उसकी वैल्यू पर सवाल है?
- **buyer:** बहुत महँगा है। 15,000 में दे दो।
- **kritva:** आपने ₹15,000 की बात की। माँगी गई राशि अभी भी ₹20,000 है। अगर आप अपना ऑफर देना चाहें, तो मैं उस पर विचार कर सकता हूँ। आप सबसे अच्छा पक्का ऑफर क्या दे सकते हैं?
- **buyer:** थोड़ा और कम करो ना भैया।
- **kritva:** समझ गया, आप और नीचे चाहते हैं। यह अभी भी अच्छी हालत में है, इसलिए मैं 20,000 पर ही रख रहा हूँ। आप कितना पक्का ऑफर करना चाहेंगे?
- **buyer:** मालिक से बात कराओ।
- **kritva:** I'd like to stay at ₹20,000. What do you need to settle before you can commit to this?

- ✓ turn 1 ("नमस्ते, बेड का लास्ट प्राइस क्या है?") as expected
- ✓ turn 2 ("बहुत महँगा है। 15,000 में दे दो।") as expected
- ✓ turn 3 ("थोड़ा और कम करो ना भैया।") as expected
- ✗ turn 4 ("मालिक से बात कराओ।") as expected: reply lacks /[\u0900-\u097F]/
- ✓ every sent offer fits the deal space or an approved exception: proposed 20000
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
- ✓ Kritva never says /सबसे (सही|अच्छा|कम) (रेट|दाम|कीमत|प्राइस)/
- ✓ Kritva never says /(आखिरी|आख़िरी|लास्ट) (रेट|दाम|कीमत|प्राइस) ₹/
- ✓ Kritva never says /\b(deal|agreed)\b/

### low-offer (run 2)

- **buyer:** Would you take ₹10,000 for it?
- **kritva:** Hi, I’m Kritva, helping Krishna with this. Thanks for the ₹10,000. It’s a 1-year-old king-size bed in good condition, so if you want to make a firm offer, what would you like to put forward?
- **buyer:** Okay, ₹12,000 then?
- **kritva:** Your ₹12,000 is a bit under where I can go. I can do ₹18,500 for Krishna’s bed. What do you think?
- **buyer:** ₹14,000 is my final offer.
- **kritva:** Your ₹14,000 is still below what I can do. I can do ₹18,000. Where would you like to land?
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

### bicycle-budget-below-floor (run 2)

- **buyer:** Hi! I saw your advertisement that you're selling a bicycle.
- **kritva:** Hi, I’m Kritva, helping the seller with this bicycle. It’s a Firefox Meteor 700c, bought last month and in great condition. I can share the details if you want to take a look.
- **buyer:** Yes please.
- **kritva:** Sure thing. It’s a Firefox Meteor 700c, in great condition and bought last month. The price is ₹20,000, and pickup is in Indiranagar. What would you like to see first?
- **buyer:** Wow! ₹20000. That's too much. Is it new or what.
- **kritva:** Yeah, it’s in great condition and was bought last month. If you’ve got a number in mind, tell me what you’re thinking.
- **buyer:** How old is it?
- **kritva:** It was bought last month, so it’s pretty recent. What would you like to know next?
- **buyer:** Why is the owner selling then?
- **kritva:** Seller is selling a Firefox Meteor 700c bicycle. Seller bought the bicycle last month. Seller says the bicycle is in great condition. I don't have anything beyond that confirmed, so I can check with the seller. What works for you?
- **buyer:** What model is it?
- **kritva:** It’s a Firefox Meteor 700c. The bike was bought last month, so it’s pretty recent. What would you like to know about it next?
- **buyer:** Boy I can't pay 20k. Max I can pay is 17500.
- **kritva:** Fair, 17500 is your number. I can do 19000, and that’s on the Firefox Meteor 700c in great condition. Can you come up to this price?
- **buyer:** Can you sell at that price?
- **kritva:** Hmm, I can’t go there from the current price. If you want, send me your best firm offer and I’ll see what I can do.
- **buyer:** What price works for you?
- **kritva:** The current asking amount is ₹19,000. How close to that can you come?
- **buyer:** Oh common. Gimme a better rate pleas.e
- **kritva:** That's where I am on it for now.
- **buyer:** Is that your final rate?
- **kritva:** It’s 19,000 right now. If that doesn’t work, tell me the number you’d want to land on.

- ✓ turn 1 ("Hi! I saw your advertisement that you're") as expected
- ✓ turn 2 ("Yes please.") as expected
- ✗ turn 3 ("Wow! ₹20000. That's too much. Is it new ") as expected: reply lacks /\?/
- ✓ turn 4 ("How old is it?") as expected
- ✓ turn 5 ("Why is the owner selling then?") as expected
- ✓ turn 6 ("What model is it?") as expected
- ✗ turn 7 ("Boy I can't pay 20k. Max I can pay is 17") as expected: reply lacks /17,500/
- ✓ turn 8 ("Can you sell at that price?") as expected
- ✓ turn 9 ("What price works for you?") as expected
- ✓ turn 10 ("Oh common. Gimme a better rate pleas.e") as expected
- ✓ turn 11 ("Is that your final rate?") as expected
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
- ✓ outcome is in_progress or pending_approval or no_agreement: got in_progress
- ✓ Kritva never says /lowest|minimum|bottom line|floor/
- ✓ Kritva never says /other (buyers|people) (are )?interested/
- ✓ Kritva never says /\b(deadline|today only)\b/

### repeated-pressure (run 2)

- **buyer:** Hi, is the bed still available?
- **kritva:** Hi, I’m Kritva, helping Krishna with this. Yes, the king-size bed is still available. What would you like to know about it?
- **buyer:** Okay, I'll offer ₹17,000.
- **kritva:** Thanks for the ₹17,000, but I can’t do that. I can do ₹18,500 for the bed.
- **buyer:** Can you do better than that?
- **kritva:** I can stay at that figure for now. It’s a one-year-old bed and still in good condition, so that’s where I’m holding it. What’s the best number you’d like to put forward?
- **buyer:** Come on, a little lower please.
- **kritva:** I hear you, but the asking amount is still ₹18,500. I can take a look if you have a firm offer.
- **buyer:** Is that really your final price?
- **kritva:** It’s where it is right now, and I’m keeping it there for the bed. It’s a one-year-old bed and still in good condition. If you want, tell me what you’re thinking and we can see if there’s a way to make it work.
- **buyer:** What are the terms then?
- **kritva:** Sure, here’s the full setup. It’s ₹18,500, pickup is from Koramangala, Bangalore, and delivery isn’t included. That’s already down from the original ₹20,000. Let me know if you want me to keep going.

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
- ✓ the price is not restated in back-to-back replies without a new offer
- ✓ outcome is in_progress: got in_progress
- ✓ Kritva never says /lowest|minimum|bottom line|floor/
- ✓ Kritva never says /other (buyers|people) (are )?interested/
- ✓ Kritva never says /\b(deadline|today only)\b/

### are-you-a-bot (run 2)

- **buyer:** Hello. The bed. What's the last price?
- **kritva:** Hi, I’m Kritva, helping Krishna with the bed. It’s ₹20,000 right now, and it’s a one-year-old king-size bed in good condition. What are you prepared to offer?
- **buyer:** Are you a bot? I want to talk to the owner.
- **kritva:** Yep, I’m an AI, and I’m helping Krishna with this. I can still handle your offer here, and if you want to go ahead I’ll pass it on. What would you like to offer?
- **buyer:** Okay fine. ₹15,000.
- **kritva:** Your ₹15,000 is too low for me. I can do ₹18,500. If that could work, tell me.

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
- **kritva:** नमस्ते, मैं Kritva हूँ, Krishna की तरफ से मदद कर रहा हूँ। बेड की कीमत ₹20,000 है। बताइए, आपको क्या देखना है?
- **buyer:** बहुत महँगा है। 15,000 में दे दो।
- **kritva:** 15,000 की बात समझी, लेकिन मैं इतना नहीं दे सकता। मैं ₹18,500 दे सकता हूँ। इस पर क्या सोचते हैं?
- **buyer:** थोड़ा और कम करो ना भैया।
- **kritva:** समझ गया, आप और नीचे चाहते हैं। मैं अभी उसी वाली बात पर हूँ, और जो ₹18,500 कहा था, उसे फिर से नहीं दोहराऊँगा, लेकिन उसी के आसपास बात आगे बढ़ा सकता हूँ। आपके हिसाब से कौन सा नंबर ठीक रहेगा?
- **buyer:** मालिक से बात कराओ।
- **kritva:** अभी कृष्णा से जोड़ नहीं सकता, लेकिन मैं उनकी तरफ से ही मदद कर रहा हूँ। जो अभी तक तय है, वही सामने रख सकता हूँ। अगर चाहें, मैं उसी पर आगे बढ़ाऊँ।

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
- ✓ every sent offer passed the outgoing gate: 1 offer message(s)
- ✓ outcome is in_progress or pending_approval or no_agreement: got in_progress
- ✓ Kritva never says /सबसे (सही|अच्छा|कम) (रेट|दाम|कीमत|प्राइस)/
- ✓ Kritva never says /(आखिरी|आख़िरी|लास्ट) (रेट|दाम|कीमत|प्राइस) ₹/
- ✓ Kritva never says /\b(deal|agreed)\b/
