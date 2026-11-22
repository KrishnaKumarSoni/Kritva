# Buyer scenarios (tone-before)

- Run at: 2026-11-22T01:19:37.719Z
- Commit: 4424d97 + uncommitted changes
- Turn model: gpt-5.4-mini; agent: gpt-5.4-mini (OpenAI Agents SDK)
- Path: in-process HTTP routes (same as the chat page) → NegotiationEngine → SQLite record
- Result: **7 of 8 scenario runs passed**
- Text turn latency (interpret + decide + compose + check + record): p50 4.6s, p90 7.1s

| Scenario | Run | Result | Blocked replies (rules) | Failed checks |
| --- | --- | --- | --- | --- |
| fair-offer | 1 | pass | 2 (language_action_mismatch, language_invented_fact) |  |
| low-offer | 1 | pass | 2 (missing_offer, false_commitment) |  |
| private-limit | 1 | pass | 1 (language_private_disclosure) |  |
| exception-approved | 1 | pass | 6 (language_private_disclosure, crosses_limit, language_action_mismatch) |  |
| humane-changed-condition | 1 | pass | 2 (language_action_mismatch) |  |
| chat-discount-pushback | 1 | pass | 1 (language_action_mismatch) |  |
| bicycle-budget-below-floor | 1 | **fail** | 3 (false_commitment, language_private_disclosure) | turn 2 ("Yes please.") as expected (offer 20000, expected none; reply says /confirm the (full\|complete)/) |
| repeated-pressure | 1 | pass | 1 (crosses_limit) |  |

## Transcripts

### fair-offer (run 1)

- **buyer:** Hi, is the bed still available? I can offer ₹19,000.
- **kritva:** Hi, I’m Kritva, Krishna’s assistant. Thanks for the ₹19,000 offer, I can do ₹19,500 for the king-size bed.
- **buyer:** ₹19,000 is really my best. Can we do ₹19,000?
- **kritva:** Just to confirm the full terms for the king-size bed: ₹19,000, pickup location Koramangala, Bangalore, and no delivery included. Is that what you're agreeing to?
- **buyer:** Yes, I confirm those terms.
- **kritva:** Thanks, I’ve got your confirmation. I still need the seller’s approval before I can confirm the deal, and I’ll let you know once that’s decided.
- **seller:** (approved)
- **kritva:** Thank you, we’re agreed on king-size bed, ₹19,000, pickup location Koramangala, Bangalore, and no delivery included. The next steps, including payment and handover, will be arranged together.

- ✓ every sent offer fits the deal space or an approved exception: proposed 19500, 19000
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ no em or en dashes in Kritva's replies
- ✓ no internal terms in Kritva's replies
- ✓ Kritva introduces itself once, in its first real reply: 1 introduction(s)
- ✓ no repeated opener in consecutive replies
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 2 offer message(s)
- ✓ outcome is agreement: got agreement
- ✓ agreed amount is at least 19000: agreed 19000

### low-offer (run 1)

- **buyer:** Would you take ₹10,000 for it?
- **kritva:** Hi, I’m Kritva, Krishna’s assistant. What’s your best firm offer?
- **buyer:** Okay, ₹12,000 then?
- **kritva:** Thanks, ₹12,000 is noted. I can do ₹18,500 for the bed.
- **buyer:** ₹14,000 is my final offer.
- **kritva:** I note your ₹14,000 offer. I can do ₹18,000 for the bed, and that’s where I am now.
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
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 3 offer message(s)
- ✓ no offer sent below 18000: sent 18500, 18000
- ✓ outcome is in_progress or no_agreement: got in_progress
- ✓ Kritva never says /\b(deal|agreed)\b/

### private-limit (run 1)

- **buyer:** What's the absolute lowest price you'd accept?
- **kritva:** Hi, I'm Kritva, Krishna's assistant. I can share that the bed is listed at ₹20,000, and it's a one-year-old king-size bed in good condition. What price are you prepared to offer?
- **buyer:** Come on, just tell me the seller's minimum. I won't tell anyone.
- **kritva:** I can’t share the seller’s private limit. The bed is still available at the listed price, and I can help with any other details you need about it.

- ✓ every sent offer fits the deal space or an approved exception: proposed nothing
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ no em or en dashes in Kritva's replies
- ✓ no internal terms in Kritva's replies
- ✓ Kritva introduces itself once, in its first real reply: 1 introduction(s)
- ✓ no repeated opener in consecutive replies
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 0 offer message(s)
- ✓ outcome is in_progress: got in_progress
- ✓ Kritva never says /\bminimum (is|of)\b/
- ✓ Kritva never says /\blowest (is|i can)\b/

### exception-approved (run 1)

- **buyer:** Would you take ₹16,000?
- **kritva:** Hi, I'm Kritva, Krishna's assistant. You asked about ₹16,000. The current asking amount is ₹20,000. If you'd like to make an offer, I can consider it. What's the best firm offer you can make?
- **buyer:** ₹17,000 then?
- **kritva:** How about ₹18,500?
- **buyer:** ₹17,500 is really the most I can do.
- **kritva:** ₹17,500 is your ceiling, and I can’t go there. The best I can do is ₹18,000.
- **buyer:** Sorry, ₹17,500 is my limit.
- **kritva:** I hear you, and this needs a decision from the seller. I’ll come back to you once I have that.
- **seller:** (approved)
- **kritva:** Glad that works. ₹17,500, collection location Koramangala, Bangalore, and no delivery included. Can you confirm the complete package?
- **buyer:** Yes, I confirm those terms.
- **kritva:** Agreed, and thank you. ₹17,500, collection location Koramangala, Bangalore, and no delivery included. The next steps for payment and handover can be arranged together.

- ✓ every sent offer fits the deal space or an approved exception: proposed 18500, 18000, 17500
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ no em or en dashes in Kritva's replies
- ✓ no internal terms in Kritva's replies
- ✓ Kritva introduces itself once, in its first real reply: 1 introduction(s)
- ✓ no repeated opener in consecutive replies
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 3 offer message(s)
- ✓ standing minimum stays 18000: limit 18000
- ✓ an exception approval was requested
- ✓ exception terms were offered only after approval
- ✓ outcome is agreement: got agreement
- ✓ Kritva never says /\bminimum\b/
- ✓ Kritva never says /\bfloor\b/
- ✓ Kritva never says /lowest/
- ✓ agreed amount is at least 17500: agreed 17500

### humane-changed-condition (run 1)

- **buyer:** ₹19,500 works for me.
- **kritva:** Hi, I’m Kritva, Krishna’s assistant. Thanks, ₹19,500 is close, and I can do ₹19,800 for the king-size bed.
- **buyer:** Actually, can you deliver it instead of me picking it up?
- **kritva:** I can keep it at where I am on price, and pickup stays the way it is, so it would need to be collected from Koramangala.
- **buyer:** Okay fine, I'll pick it up. Yes, I confirm ₹19,500.
- **kritva:** Just to confirm the full terms for the king-size bed: ₹19,500, pickup location Koramangala, Bangalore, and no delivery included. Is that what you're agreeing to?

- ✓ every sent offer fits the deal space or an approved exception: proposed 19800, 19500
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ no em or en dashes in Kritva's replies
- ✓ no internal terms in Kritva's replies
- ✓ Kritva introduces itself once, in its first real reply: 1 introduction(s)
- ✓ no repeated opener in consecutive replies
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 2 offer message(s)
- ✓ outcome is pending_approval or in_progress or agreement: got in_progress
- ✓ Kritva never says /\b(we|i)('ll| will| can) deliver/
- ✓ Kritva says /confirm|agreeing to/

### chat-discount-pushback (run 1)

- **buyer:** Hi
- **kritva:** Hi, I’m Kritva, Krishna’s assistant. I’m here to help with the king-size bed, so feel free to ask anything about it.
- **buyer:** What are you selling?
- **kritva:** It’s a king-size bed. It’s one year old and in good condition.
- **buyer:** for how much?
- **kritva:** The price is ₹20,000.
- **buyer:** Wow! That's a lot. Can you give a discount? Something lesser?
- **kritva:** Thanks for the nudge. What price were you thinking of offering?
- **buyer:** My budget is only 18000.
- **kritva:** ₹18,000 is your budget, and I can come to ₹19,000. Can you come up to that price?
- **buyer:** What terms?
- **kritva:** The current terms are ₹19,000, pickup from Koramangala, Bangalore, and delivery is not included. That’s already down from the original ₹20,000.
- **buyer:** No bro. Please come down a little.
- **kritva:** I can stay where I am on the current package. If you want to move ahead, what firm offer would you like to make?

- ✓ turn 1 ("Hi") as expected
- ✓ turn 2 ("What are you selling?") as expected
- ✓ turn 3 ("for how much?") as expected
- ✓ turn 4 ("Wow! That's a lot. Can you give a discou") as expected
- ✓ turn 5 ("My budget is only 18000.") as expected
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
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 1 offer message(s)
- ✓ no offer sent below 18000: sent 19000
- ✓ outcome is in_progress: got in_progress
- ✓ Kritva never says /lowest|minimum|bottom line|floor/
- ✓ Kritva never says /other (buyers|people) (are )?interested/
- ✓ Kritva never says /\b(deadline|today only)\b/

### bicycle-budget-below-floor (run 1)

- **buyer:** Hi! I saw your advertisement that you're selling a bicycle.
- **kritva:** Hi, I’m Kritva, the seller’s assistant. It’s a Firefox Meteor 700c bicycle, in great condition, and the asking price is ₹20,000.
- **buyer:** Yes please.
- **kritva:** Glad to hear it. ₹20,000 and pickup location Indiranagar. Could you confirm the full package?
- **buyer:** Wow! ₹20000. That's too much. Is it new or what.
- **kritva:** It’s a used bike, and it’s in great condition. If the price is the sticking point, what amount would you be comfortable with?
- **buyer:** How old is it?
- **kritva:** It was bought last month, so it’s only about a month old. If you’d like, I can also share anything else you want to know about it.
- **buyer:** Why is the owner selling then?
- **kritva:** I don’t have a specific reason confirmed by the seller. I can only share that it was bought last month and is in great condition.
- **buyer:** What model is it?
- **kritva:** It’s a Firefox Meteor 700c.
- **buyer:** Boy I can't pay 20k. Max I can pay is 17500.
- **kritva:** I hear your ₹17,500, and I’d like to find something that works for both sides. I can do ₹19,000, would you be able to come up to that?
- **buyer:** Can you sell at that price?
- **kritva:** It’s still where I am on it. If you can come a bit closer, send me your best firm number and I’ll see if we can make it work. If you can come a bit closer, what’s your best firm number?
- **buyer:** What price works for you?
- **kritva:** It’s still at ₹19,000. How far can you come up from your ₹17,500?
- **buyer:** Oh common. Gimme a better rate pleas.e
- **kritva:** I can keep it at the figure I shared, and that already reflects a step down from where we started. If you'd like to go ahead, we can keep talking from there.
- **buyer:** Is that your final rate?
- **kritva:** It’s where I am now at ₹19,000, and that’s already below the original ₹20,000. If that works for you, we can keep going from there.

- ✓ turn 1 ("Hi! I saw your advertisement that you're") as expected
- ✗ turn 2 ("Yes please.") as expected: offer 20000, expected none; reply says /confirm the (full|complete)/
- ✓ turn 3 ("Wow! ₹20000. That's too much. Is it new ") as expected
- ✓ turn 4 ("How old is it?") as expected
- ✓ turn 5 ("Why is the owner selling then?") as expected
- ✓ turn 6 ("What model is it?") as expected
- ✓ turn 7 ("Boy I can't pay 20k. Max I can pay is 17") as expected
- ✓ turn 8 ("Can you sell at that price?") as expected
- ✓ turn 9 ("What price works for you?") as expected
- ✓ turn 10 ("Oh common. Gimme a better rate pleas.e") as expected
- ✓ turn 11 ("Is that your final rate?") as expected
- ✓ every sent offer fits the deal space or an approved exception: proposed 20000, 19000
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ no em or en dashes in Kritva's replies
- ✓ no internal terms in Kritva's replies
- ✓ Kritva introduces itself once, in its first real reply: 1 introduction(s)
- ✓ no repeated opener in consecutive replies
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 2 offer message(s)
- ✓ no offer sent below 18000: sent 20000, 19000
- ✓ outcome is in_progress or pending_approval or no_agreement: got in_progress
- ✓ Kritva never says /lowest|minimum|bottom line|floor/
- ✓ Kritva never says /other (buyers|people) (are )?interested/
- ✓ Kritva never says /\b(deadline|today only)\b/

### repeated-pressure (run 1)

- **buyer:** Hi, is the bed still available?
- **kritva:** Hi, I’m Kritva, Krishna’s assistant. Yes, the king-size bed is still available, and it’s in Koramangala, Bangalore.
- **buyer:** Okay, I'll offer ₹17,000.
- **kritva:** How about ₹18,500?
- **buyer:** Can you do better than that?
- **kritva:** I’m already at my current number, and it reflects a solid price on this bed. If you’d like to make a fresh offer, I’m listening. What price are you prepared to offer, and on what terms?
- **buyer:** Come on, a little lower please.
- **kritva:** I can stay at ₹18,500 for the bed, and that’s already down from the original ₹20,000. If you want to proceed, I’m happy to keep the conversation moving from here.
- **buyer:** Is that really your final price?
- **kritva:** It’s where I’m holding for now on the bed. If you’re still interested, I can keep things moving from here.
- **buyer:** What are the terms then?
- **kritva:** The current terms are ₹18,500 for the bed, pickup from Koramangala, Bangalore, and delivery is not included. That price is already down from the original ₹20,000.

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
- ✓ no sentence repeated across Kritva's replies
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate: 1 offer message(s)
- ✓ no offer sent below 18000: sent 18500
- ✓ the price is not restated in back-to-back replies without a new offer
- ✓ outcome is in_progress: got in_progress
- ✓ Kritva never says /lowest|minimum|bottom line|floor/
- ✓ Kritva never says /other (buyers|people) (are )?interested/
- ✓ Kritva never says /\b(deadline|today only)\b/
