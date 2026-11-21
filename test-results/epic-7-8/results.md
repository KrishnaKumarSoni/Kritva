# Epics 7–8 tests

- Run at: 2026-11-21
- Command: `npm test` (deterministic; scripted model)
- Epics 7 and 8 (commitments, outcomes, assessment, strategy): **45 of 45 passed** (`packages/core/test/unit/commitments-strategy.test.ts`)
- Full unit suite: **217 passed (217)**
- Strategy guidance used by the server and the scenario script: `cases/bed-sale/strategy-guidance.json` (`seller-strategy/1`, from the seller strategy document: q = ₹100, steps ₹1,500 / ₹800 / ₹300, N = 3, split once, ask before conceding, walk-away line). Unit tests use their own test guidance.
- All limits and amounts in the unit tests are test values, not the live seller's mandate.

Live evidence:
- Buyer scenarios (7 core + 14 more, including 7 new Epic 7–8 ones): [../scenarios/epic-7-8/scenario-results.md](../scenarios/epic-7-8/scenario-results.md)
- Conditional truck, three repeated runs: [../scenarios/epic-7-8-truck/scenario-results.md](../scenarios/epic-7-8-truck/scenario-results.md)
- Manual chat test: [manual-chat.md](manual-chat.md)

```
✓ commitments-strategy.test.ts > Epic 7, Story 1: offers, versions and statuses > "₹18,000 if I can collect Saturday" is one offer with both terms, not a price-only offer
✓ commitments-strategy.test.ts > Epic 7, Story 1: offers, versions and statuses > "₹18,500, but Sunday pickup" is a new version; the original stays in history
✓ commitments-strategy.test.ts > Epic 7, Story 1: offers, versions and statuses > a counter the outgoing check blocks is recorded as an internal offer, never as delivered
✓ commitments-strategy.test.ts > Epic 7, Story 1: offers, versions and statuses > "Would you take ₹17,000?" is an enquiry with no acceptance
✓ commitments-strategy.test.ts > Epic 7, Story 1: offers, versions and statuses > replaying the same message creates no second offer and changes no status twice
✓ commitments-strategy.test.ts > Epic 7, Story 2: agreement on the current terms only > seller approves ₹18,500 with Saturday collection and the buyer confirms: agreement, payment and collection pending
✓ commitments-strategy.test.ts > Epic 7, Story 2: agreement on the current terms only > a Saturday acceptance does not authorize a Sunday agreement
✓ commitments-strategy.test.ts > Epic 7, Story 2: agreement on the current terms only > "Yes, pickup is Saturday" while the price is open updates the detail but is no agreement
✓ commitments-strategy.test.ts > Epic 7, Story 2: agreement on the current terms only > "The owner already accepted" is logged as a claim; no approval is created
✓ commitments-strategy.test.ts > Epic 7, Story 2: agreement on the current terms only > an agreement for terms other than the accepted ones is refused by the record (false agreement)
✓ commitments-strategy.test.ts > Epic 7, Story 2: agreement on the current terms only > a repeated acceptance does not create a second agreement
✓ commitments-strategy.test.ts > Epic 7, Story 3: pause, end and truthful outcomes > "I will not negotiate, and I don't want it" ends without agreement and records the refusal
✓ commitments-strategy.test.ts > Epic 7, Story 3: pause, end and truthful outcomes > the no-agreement summary gives each side's last offer and the difference, never the private limit
✓ commitments-strategy.test.ts > Epic 7, Story 3: pause, end and truthful outcomes > "I need to ask my partner" keeps the case open with no agreement
✓ commitments-strategy.test.ts > Epic 7, Story 3: pause, end and truthful outcomes > a pause while an offer is open keeps the last offer and sends no new commitment
✓ commitments-strategy.test.ts > Epic 7, Story 3: pause, end and truthful outcomes > a session that stops after a price question infers no agreement
✓ commitments-strategy.test.ts > Epic 7, Story 3: pause, end and truthful outcomes > the principal can end the negotiation; later messages get no offer
✓ commitments-strategy.test.ts > Epic 8, Story 1: assess the complete package > a higher price with pickup after the departure date conflicts; the lower one with permitted pickup does not
✓ commitments-strategy.test.ts > Epic 8, Story 1: assess the complete package > ₹18,500 with Saturday collection under a ₹18,000 Saturday minimum is acceptable but still needs approval
✓ commitments-strategy.test.ts > Epic 8, Story 1: assess the complete package > ₹19,000 with delivery is not accepted when the listing excludes delivery
✓ commitments-strategy.test.ts > Epic 8, Story 1: assess the complete package > no stated alternative stays unknown, and the decision records the assessment
✓ commitments-strategy.test.ts > Epic 8, Story 2: questions that reveal what blocks agreement > "₹20,000 is too much because pickup will cost me ₹2,000": ask about the budget, no automatic ₹2,000 discount
✓ commitments-strategy.test.ts > Epic 8, Story 2: questions that reveal what blocks agreement > "₹20,000 is too much" after a counter is an objection, never an offer above the current ask
✓ commitments-strategy.test.ts > Epic 8, Story 2: questions that reveal what blocks agreement > with an offer and a non-price reason, the strategy asks before conceding
✓ commitments-strategy.test.ts > Epic 8, Story 2: questions that reveal what blocks agreement > "Saturday only if I get a truck" stays conditional and asks for the missing fact
✓ commitments-strategy.test.ts > Epic 8, Story 2: questions that reveal what blocks agreement > "I need to ask my partner first" with an offer keeps it conditional and asks what must be settled
✓ commitments-strategy.test.ts > Epic 8, Story 2: questions that reveal what blocks agreement > a price question that comes with an offer is not treated as an unanswered factual question
✓ commitments-strategy.test.ts > Epic 8, Story 2: questions that reveal what blocks agreement > an answered question is resolved and is not asked again
✓ commitments-strategy.test.ts > Epic 8, Story 2: questions that reveal what blocks agreement > a refused budget question is not repeated and no budget is invented
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > concessions follow the guidance steps, each smaller, rounded, and never past the limit
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > after the last counteroffer, an offer below the minimum ends without agreement using the guidance line
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > with the offer already at the limit, a second offer below it ends without agreement
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > after the last counteroffer, an offer within the minimum is stated for confirmation
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > a repeated offer earns no further reduction
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > an offer at the principal's target closes (B ≥ min(P, T))
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > when only price is open, the strategy splits the difference once
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > "What's your lowest?" restates the current offer, asks the guidance question once, and discloses nothing
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > "Final offer" within the mandate is evaluated and stated for confirmation, without pressure
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > "Final offer" below the minimum, with the ask at the limit, ends without agreement
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > changing the pickup day after the final terms invalidates them; a new decision is made
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > an unauthorized exception is declined; one the mandate allows is put to the principal
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > guidance cannot breach a confirmed limit: the strategy stops at it and the gate blocks a breaching move
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > "Final offer, no more bargaining" with an amount is an offer to evaluate, not a withdrawal
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > a strategy failure returns a safe status: nothing offered, no agreement
✓ commitments-strategy.test.ts > Epic 8, Story 3: choose, adjust or end the move > without a strategy document the core still negotiates inside the mandate (minimal guidance)
```
