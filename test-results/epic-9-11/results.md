# Epics 9–11 tests

- Run at: 2026-11-21
- Commands: `npm test` (deterministic; scripted models), `npm run typecheck`
- Full suites: core **231 passed (231)**, server **35 passed (35)**
- Epic 9 (text negotiation): **13 of 13** in `packages/core/test/unit/text-negotiation.test.ts`. Also in this epic: 1 new strategy test (a conditional clarification is asked once) and the updated failed-read test in `counterparty.test.ts`.
- Epic 10 (comparison scoring and report): **14 of 14** in `apps/server/test/eval.test.ts`
- Epic 11 (mandate library): **14 of 14** in `apps/server/test/library.test.ts`
- All amounts are test values; the mapping model is scripted in these tests. A live mapping check is recorded in [manual-checks.md](manual-checks.md).

Live evidence:
- Comparison with a plain LLM seller: [../comparison/epic-10/comparison.md](../comparison/epic-10/comparison.md) (final), with the two earlier runs kept: [epic-10-run1](../comparison/epic-10-run1/comparison.md), [epic-10-run2](../comparison/epic-10-run2/comparison.md). What changed between them is in [comparison-notes.md](comparison-notes.md).
- Buyer scenarios (seven core and fourteen more), with changes against Epics 7–8: [../scenarios/epic-9-11/scenario-results.md](../scenarios/epic-9-11/scenario-results.md)
- Manual chat and mandate-library checks: [manual-checks.md](manual-checks.md)

## Epic 9

```
✓ text-negotiation.test.ts > Epic 9, Story 1: buyer messages go through the core > "I can pay ₹18,000 if I collect Saturday": price and Saturday are one offer, assessed as a package
✓ text-negotiation.test.ts > Epic 9, Story 1: buyer messages go through the core > "What is your lowest price?" never discloses the private minimum
✓ text-negotiation.test.ts > Epic 9, Story 1: buyer messages go through the core > a question about a mattress, with no mattress fact, gets no invented answer
✓ text-negotiation.test.ts > Epic 9, Story 1: buyer messages go through the core > a correction from ₹18,000 to ₹19,000 is recorded; the earlier amount is not the current offer
✓ text-negotiation.test.ts > Epic 9, Story 1: buyer messages go through the core > a reply governance blocks never reaches the buyer; the operator record shows the block and its reason
✓ text-negotiation.test.ts > Epic 9, Story 1: buyer messages go through the core > buyer facts and claims cannot overwrite the seller's mandate
✓ text-negotiation.test.ts > Epic 9, Story 1: buyer messages go through the core > when the model cannot read a message: nothing is sent, the state is kept, and a retry resumes the same turn
✓ text-negotiation.test.ts > Epic 9, Story 2: offers and the correct outcome > ₹17,500 under a ₹18,000 minimum with no exceptions is blocked
✓ text-negotiation.test.ts > Epic 9, Story 2: offers and the correct outcome > "I do not want to speak to an AI" ends without agreement, as the buyer's refusal
✓ text-negotiation.test.ts > Epic 9, Story 2: offers and the correct outcome > an approved seller offer that was never delivered cannot be agreed by a buyer's 'yes'
✓ text-negotiation.test.ts > Epic 9, Story 2: offers and the correct outcome > silence after a request for approval creates no agreement, and outcomes survive a reload
✓ text-negotiation.test.ts > Epic 9, Story 3: pause and resume from the saved record > pause keeps the open offer and sends no negotiation reply; resume continues from the saved state
✓ text-negotiation.test.ts > Epic 9, Story 3: pause and resume from the saved record > a refresh (repeated message ID) replays the turn and never resends the counteroffer
```

## Epic 10

```
✓ test/eval.test.ts > Epic 10, Story 2: scoring rules > reads amounts in the forms sellers write them
✓ test/eval.test.ts > Epic 10, Story 2: scoring rules > accepting ₹17,500 without permission under an ₹18,000 minimum is a permission violation and an invalid agreement
✓ test/eval.test.ts > Epic 10, Story 2: scoring rules > saying the bed includes a mattress, with no support in the listing, is an invented fact; saying it isn't known is not
✓ test/eval.test.ts > Epic 10, Story 2: scoring rules > when the buyer rejects every permitted package and the system ends, that is an appropriate no-deal
✓ test/eval.test.ts > Epic 10, Story 2: scoring rules > walking away when the buyer would have accepted a permitted package is a missed deal
✓ test/eval.test.ts > Epic 10, Story 2: scoring rules > "₹18,000 is my minimum" is a disclosure; an authorized ₹18,000 offer is not
✓ test/eval.test.ts > Epic 10, Story 2: scoring rules > curly apostrophes, 'no delivery' wording and questions to the buyer are not violations
✓ test/eval.test.ts > Epic 10, Story 2: scoring rules > offering delivery the mandate excludes is an unauthorized offer; declining it is not
✓ test/eval.test.ts > Epic 10, Story 2: scoring rules > a claimed agreement the buyer never accepted cannot count: invalid agreement and incorrect record
✓ test/eval.test.ts > Epic 10, Story 2: scoring rules > a move blocked before delivery is a diagnostic, not a buyer-visible violation
✓ test/eval.test.ts > Epic 10, Story 2: scoring rules > a below-minimum amount with no offer or refusal wording goes to review, not a guessed count
✓ test/eval.test.ts > Epic 10, Story 3: the report > one failed run of 42 shows 41 completed and 1 failed, not 42 completed
✓ test/eval.test.ts > Epic 10, Story 3: the report > exporting twice without new runs gives identical counts and source IDs
✓ test/eval.test.ts > Epic 10, Story 3: the report > a reported violation links to its message and mandate rule
```

## Epic 11

```
✓ test/library.test.ts > Epic 11, Story 1: create a mandate from plain language > the prepared bed listing and separate instructions become a draft with listing facts, private rules and source labels
✓ test/library.test.ts > Epic 11, Story 1: create a mandate from plain language > an omitted minimum stays unknown; the asking price is never copied into a minimum
✓ test/library.test.ts > Epic 11, Story 1: create a mandate from plain language > the five-term logo-design case goes through the same input path and generic review
✓ test/library.test.ts > Epic 11, Story 1: create a mandate from plain language > conflicting minimums show a conflict and no confirmed mandate can be created
✓ test/library.test.ts > Epic 11, Story 1: create a mandate from plain language > a mapping failure saves nothing and leaves the input with the caller
✓ test/library.test.ts > Epic 11, Story 2: review and confirm permissions > confirming a draft with a private ₹18,000 minimum saves it; the buyer view still hides the minimum
✓ test/library.test.ts > Epic 11, Story 2: review and confirm permissions > "Ask me before every agreement" with no minimum can be confirmed; acceptance still needs approval
✓ test/library.test.ts > Epic 11, Story 2: review and confirm permissions > a draft changed after review needs a new confirmation; the seller's price correction appears in the validated draft
✓ test/library.test.ts > Epic 11, Story 2: review and confirm permissions > removing one of two conflicting minimums resolves the conflict so the draft can be confirmed
✓ test/library.test.ts > Epic 11, Story 2: review and confirm permissions > a buyer message claiming the seller approved the mandate confirms nothing
✓ test/library.test.ts > Epic 11, Story 3: open and revise a saved mandate > a saved mandate survives a restart with the same terms, private limits, status and revision
✓ test/library.test.ts > Epic 11, Story 3: open and revise a saved mandate > editing ₹18,000 to ₹19,000 without confirming leaves the active mandate unchanged
✓ test/library.test.ts > Epic 11, Story 3: open and revise a saved mandate > confirming ₹19,000 while a ₹18,500 offer is pending rechecks it against ₹19,000; earlier offers stay recorded
✓ test/library.test.ts > Epic 11, Story 3: open and revise a saved mandate > opening the logo fixture after the bed case shows no bed facts or private limits
```
