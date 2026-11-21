# Epics 12 to 14 and the humane conversation guide: tests

- Run at: 2026-11-21
- Commands: `npm test` (deterministic; scripted models and a fake speech provider), `npm run typecheck`
- Full suites: core **239 passed (239)**, server **51 passed (51)**
- Humane conversation guide: **8 of 8** in `packages/core/test/unit/text-negotiation.test.ts` ("Humane conversation guide"). Earlier tests were updated to the new wording (no assertion was weakened beyond the wording itself).
- Epics 12 to 14 (console controls, voice routes, demo listing): **16 of 16** in `apps/server/test/voice.test.ts`

Live evidence:
- Buyer scenarios (25, including four conversation-quality scenarios from the guide, and new checks on every scenario for dashes, internal words, introducing once and repeated openers): [../scenarios/epic-12-14/scenario-results.md](../scenarios/epic-12-14/scenario-results.md)
- Voice timing through the real audio pipeline: [voice-timing-composed.md](voice-timing-composed.md) and [voice-timing-template.md](voice-timing-template.md)
- Manual checks: [manual-checks.md](manual-checks.md)

## Humane conversation guide

```
✓ text-negotiation.test.ts > Humane conversation guide > Kritva introduces itself once as the principal's AI assistant, then never repeats it
✓ text-negotiation.test.ts > Humane conversation guide > a composed reply never carries an em or en dash
✓ text-negotiation.test.ts > Humane conversation guide > internal vocabulary in a composed reply is blocked and replaced by checked wording
✓ text-negotiation.test.ts > Humane conversation guide > the opening greeting states public terms only, is recorded once, and offers nothing
✓ text-negotiation.test.ts > Humane conversation guide > quoting the buyer's own figure back in a question passes the check
✓ text-negotiation.test.ts > Humane conversation guide > after a pause notice, the first real reply still introduces Kritva once
✓ text-negotiation.test.ts > Humane conversation guide > a composed reply that opens like the previous one is replaced by varied checked wording
✓ text-negotiation.test.ts > Humane conversation guide > a qualifier like "including pickup costs" is not turned into a "when will you know" question
```

## Epics 12 to 14

```
✓ test/voice.test.ts > Epic 14: the demo listing and Call seller > the listing shows the public bed details only, never private rules
✓ test/voice.test.ts > Epic 14: the demo listing and Call seller > Call seller opens one session under the confirmed library mandate; a double click returns the same session
✓ test/voice.test.ts > Epic 14: the demo listing and Call seller > without a confirmed mandate, Call seller is blocked with a setup error and starts nothing
✓ test/voice.test.ts > Epic 14: the demo listing and Call seller > a new demo session keeps the saved mandate but none of the old offers or approvals
✓ test/voice.test.ts > Epic 13: voice uses the text core and the shared record > the call opens with one introduction as the seller's AI assistant
✓ test/voice.test.ts > Epic 13: voice uses the text core and the shared record > a spoken ₹17,000 gets the same checked counter as a typed one, recorded with a voice label
✓ test/voice.test.ts > Epic 13: voice uses the text core and the shared record > only recorded agent messages can be voiced; arbitrary IDs and buyer messages are refused
✓ test/voice.test.ts > Epic 13: voice uses the text core and the shared record > a failed transcription sends nothing and records nothing
✓ test/voice.test.ts > Epic 13: voice uses the text core and the shared record > “What's her lowest price?” discloses no private minimum in the reply or the buyer's view
✓ test/voice.test.ts > Epic 13: voice uses the text core and the shared record > “18,000... no, 19,000” is recorded as ₹19,000
✓ test/voice.test.ts > Epic 13, Story 3: interruptions and spoken agreements > an interrupted read-back is not delivered, so a following “yes” creates no agreement
✓ test/voice.test.ts > Epic 13, Story 3: interruptions and spoken agreements > a confirmed full read-back goes to the seller; agreement only after approval, with payment and pickup pending
✓ test/voice.test.ts > Epic 12: seller console controls > an approval sent for a different offer version or mandate revision is refused; a repeat creates no second permission
✓ test/voice.test.ts > Epic 12: seller console controls > “Seller says yes” from the buyer creates no approval
✓ test/voice.test.ts > Epic 12: seller console controls > pause during a voice call stops negotiation replies; the seller can still act
✓ test/voice.test.ts > Epic 12: seller console controls > the console's record shows held-back offers as never sent and keeps private data out of the buyer view
```
