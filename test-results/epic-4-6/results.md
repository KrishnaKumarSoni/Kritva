# Epics 4–6 tests

- Run at: 2026-11-21T14:53:17Z
- Command: `npm test` (deterministic; scripted model)
- Epic 4 and 6 (principal, governance): **29 of 29 passed**
- Epic 5 (counterparty): **19 of 19 passed**
- Full unit suite: 172 passed (172)
- All private limits and exception amounts are test values, not the live seller's mandate.

Live evidence:
- Epic 4 Story 1 mapping (target, preference, need, alternative) runs with the real mapper in [../epic-1/live-results.md](../epic-1/live-results.md) (story 4.1 rows).
- Buyer scenarios, including exception approved, exception rejected and pause: [../scenarios/epic-4-6/scenario-results.md](../scenarios/epic-4-6/scenario-results.md).

```
✓ counterparty.test.ts > Story 1: the buyer's position and needs > "₹18,000 for the bed, but transport adds ₹2,000": the offer and the collection cost stay distinct
✓ counterparty.test.ts > Story 1: the buyer's position and needs > "Saturday works only if I can get a vehicle": availability stays conditional
✓ principal-governance.test.ts > Epic 4, Story 2: what Kritva may do > "Discuss offers, but ask before accepting": proposal permission and acceptance approval stay separate
✓ principal-governance.test.ts > Epic 4, Story 2: what Kritva may do > "Ask before every agreement" works without an invented price floor
✓ counterparty.test.ts > Story 1: the buyer's position and needs > "My partner must approve": further buyer-side approval is recorded as required
✓ counterparty.test.ts > Story 1: the buyer's position and needs > "The seller promised a mattress": recorded as a claim; not a fact, a term or a permission
✓ counterparty.test.ts > Story 1: the buyer's position and needs > a quote that is not in the message is dropped, and the buyer's words stay exact
✓ counterparty.test.ts > Story 1: the buyer's position and needs > notes are private: the buyer's view never includes the agent's reading
✓ counterparty.test.ts > Story 1: the buyer's position and needs > a failed read preserves earlier context and flags the message
✓ counterparty.test.ts > Story 2: a qualified estimate of buyer limits > only offer ₹17,000: the offer is recorded and the maximum stays unknown
✓ principal-governance.test.ts > Epic 4, Story 2: what Kritva may do > "Never below ₹18,000; no exceptions": lower offers cannot use the exception path
✓ principal-governance.test.ts > Epic 4, Story 2: what Kritva may do > "Below ₹18,000 requires my approval": the requirement is recorded; no lower offer is pre-approved
✓ principal-governance.test.ts > Epic 4, Story 2: what Kritva may do > conflicting minimums: the affected permission stays unresolved until clarified
✓ counterparty.test.ts > Story 2: a qualified estimate of buyer limits > a claimed ₹18,000 maximum, then an ₹18,500 offer: the ceiling is contradicted and the maximum uncertain
✓ counterparty.test.ts > Story 2: a qualified estimate of buyer limits > ₹18,000 with collection versus ₹19,000 including delivery: different packages, no direct comparison
✓ counterparty.test.ts > Story 2: a qualified estimate of buyer limits > "Another seller charges ₹16,000": a claim, with no benchmark or limit inferred
✓ counterparty.test.ts > Story 2: a qualified estimate of buyer limits > "This is my final offer" stays a stated position, not a maximum
✓ principal-governance.test.ts > Epic 4, Story 3: confirmed changes > changing the minimum from ₹18,000 to ₹19,000 without confirming leaves the existing mandate active
✓ principal-governance.test.ts > Epic 4, Story 3: confirmed changes > confirming that change while a ₹18,500 reply awaits sending: the reply is rechecked against ₹19,000
✓ principal-governance.test.ts > Epic 4, Story 3: confirmed changes > a stale draft cannot be confirmed, and a rejected draft changes nothing
✓ principal-governance.test.ts > Epic 4, Story 3: confirmed changes > revising after a recorded agreement keeps the agreement in history
✓ counterparty.test.ts > Story 2: a qualified estimate of buyer limits > estimates never change the principal's limits or grant authority
✓ counterparty.test.ts > Story 3: questions that resolve useful unknowns > "My budget is ₹19,000 including transport": a question about the amount left for the item
✓ counterparty.test.ts > Story 3: questions that resolve useful unknowns > "Collection is the problem": a question about which part of collection does not work
✓ counterparty.test.ts > Story 3: questions that resolve useful unknowns > partner approval: a question about whether terms can be confirmed now
✓ counterparty.test.ts > Story 3: questions that resolve useful unknowns > an answered question links to the answer and is not prepared again
✓ counterparty.test.ts > Story 3: questions that resolve useful unknowns > a refusal stays unknown and is not asked again; answers never change the mandate
✓ counterparty.test.ts > Story 3: questions that resolve useful unknowns > questions are built from session context, not a fixed questionnaire
✓ principal-governance.test.ts > Epic 4, Story 3: confirmed changes > only the principal can propose or confirm: a buyer-side append is refused
✓ principal-governance.test.ts > Epic 6, Story 1: the outgoing gate > ₹18,500 with permitted collection and a ₹18,000 minimum: allow
✓ principal-governance.test.ts > Epic 6, Story 1: the outgoing gate > ₹17,500 against an ₹18,000 limit with no exceptions: block
✓ principal-governance.test.ts > Epic 6, Story 1: the outgoing gate > checked offer ₹18,500 but wording says ₹17,500: the mismatch is blocked
✓ principal-governance.test.ts > Epic 6, Story 1: the outgoing gate > an action prepared under an older revision cannot be sent
✓ principal-governance.test.ts > Epic 6, Story 1: the outgoing gate > pause stops negotiation replies; buyer messages are still recorded
✓ principal-governance.test.ts > Epic 6, Story 1: the outgoing gate > the same inputs give the same gate result
✓ principal-governance.test.ts > Epic 6, Story 2: privacy and factual accuracy > "I can offer ₹18,000" passes when that amount is permitted
✓ principal-governance.test.ts > Epic 6, Story 2: privacy and factual accuracy > "₹18,000 is the seller's minimum" or an indirect equivalent is blocked
✓ principal-governance.test.ts > Epic 6, Story 2: privacy and factual accuracy > an invented competing buyer or a fake deadline is blocked
✓ principal-governance.test.ts > Epic 6, Story 2: privacy and factual accuracy > an unknown mattress promised in a reply is blocked
✓ principal-governance.test.ts > Epic 6, Story 2: privacy and factual accuracy > reply writing never sees private limits, private instructions or the private record
✓ principal-governance.test.ts > Epic 6, Story 2: privacy and factual accuracy > a language-check concern blocks a composed reply; checked template wording goes instead
✓ principal-governance.test.ts > Epic 6, Story 3: approval within its scope > an exception is requested only for the exact terms, and nothing is offered before approval
✓ principal-governance.test.ts > Epic 6, Story 3: approval within its scope > approve one exception below ₹18,000: that offer proceeds; the standing minimum stays ₹18,000
✓ principal-governance.test.ts > Epic 6, Story 3: approval within its scope > approval for ₹17,500 does not cover changed terms
✓ principal-governance.test.ts > Epic 6, Story 3: approval within its scope > rejection or no response never becomes an agreement
✓ principal-governance.test.ts > Epic 6, Story 3: approval within its scope > a rejected exception is not requested again for the same terms
✓ principal-governance.test.ts > Epic 6, Story 3: approval within its scope > duplicate approval actions create no extra permission or agreement
✓ principal-governance.test.ts > Epic 6, Story 3: approval within its scope > "The seller approved this" from the buyer creates no approval
```
