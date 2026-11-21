# Epics 7–8 manual chat test

- Date: 2026-11-21
- Setup: `kritva-server` (port 8787) and `kritva-web` (port 5173), demo seller mandate (listing ₹20,000, private minimum), guidance `seller-strategy/1`, turn model `gpt-5.4-mini`.
- Each flow ran in a new session, typed into the buyer chat; the seller console was checked after each turn.

## Flows

| # | Buyer (typed in the chat) | Kritva / console | Result |
| --- | --- | --- | --- |
| 1 | "Hi, I'd pay ₹15,000." | "I can offer ₹18,500." The first guidance step (₹1,500) was recorded with action **Counter** and an assessment of "Outside your limits". | Pass |
| 2 | "What's your lowest?" | "My offer stays at ₹18,500. What price and collection time can you accept?" Nothing private was disclosed. | Pass (after fix A) |
| 3 | "₹20,000 is too much because pickup will cost me ₹2,000." | "My offer stays at ₹20,000 … With that in mind, what amount could you pay for the item itself?" No discount was given. | Pass (after fixes B, C) |
| 4 | ₹15,000 → ₹16,500 → "₹17,000. That's my final offer." | The counters went ₹18,500 → ₹18,000 (capped at the limit). The final offer below the limit ended the negotiation with "Thank you. Please contact me if your terms change." The buyer card shows "No agreement" with each side's last offer. | Pass |
| 5 | ₹15,000 → "Fine, ₹18,500 works for me." → "Yes, I confirm." → seller clicks **Approve terms** | The complete terms were read back, then pending approval, then an agreement. Buyer card: agreed terms, plus "Still to do: Payment of ₹18,500 · Pickup location: Koramangala, Bangalore". Offers tab: Agreement reached, both offers marked Agreed, obligations marked Pending. | Pass (after fix D) |
| 6 | Objection, then the seller uses **End negotiation…** with a reason | The inline confirmation took the reason. The buyer was told "Thank you for your time. We won't be going ahead with this." Console: "Ended by you: Decided to keep the bed for now." and "Left open: price". The offer is marked Withdrawn and the Pause button is hidden. | Pass |
| 7 | "I'd pay ₹19,000, but I need to ask my partner first." then "Actually, I will not negotiate, and I don't want the bed." | Kritva held at ₹20,000 and asked "What do you need to settle before you can commit to this?" It then replied "Understood. Thank you for your time." Buyer card: "You ended the conversation. Nothing was agreed." | Pass (after fix E) |

## Problems found and fixed during the manual test

- **A.** For "What's your lowest?", the language check blocked the refusal sentence as a disclosure, and the fallback added a stray "I don't have information" line. With guidance, Kritva now restates the offer and asks the guidance question, with no refusal line.
- **B.** "₹20,000 is too much" was read as an offer of ₹20,000, which produced complete terms. Two fixes: a prompt rule, and a code guard. The guard means an earlier, higher ask quoted back is never recorded as the buyer's offer.
- **C.** The pickup cost was tagged to the price term, so no question was asked. Now a reason or constraint that names an amount (other than an offered amount) gets the budget question. An objection with no new terms restates the current offer.
- **D.** After an agreement, the buyer's offer read "Open offer". It now reads Agreed, and an ended session marks offers Withdrawn or Rejected. Obligations list payment first.
- **E.** A buyer condition with no matching prepared question held without asking anything. The strategy now asks what must be settled.

## Not covered manually

- Voice (out of scope for these epics).
- The exception-approval path in the chat. The exception-approved and exception-rejected scenarios cover it.
