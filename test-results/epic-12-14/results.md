# Epics 12 to 14 and the humane conversation guide: tests

## Handoff fixes (2026-11-22)

- Node 24.19.0. `npm test`: core **280 passed**, server **64 passed** (no model calls). Workspace type checks and the production web build passed.
- Final live run: [all 31 buyer scenarios passed](../scenarios/chat-regressions/scenario-results.md) on gpt-5.4-mini, through the same routes and case configuration as the running app. Text turn latency p50 4.1s, p90 4.9s. The suite includes the second mandates (conditional and exception) and seller approval through agreement.
- Live results vary from run to run with the model. Seven runs while fixing ranged from 23 to 31 of 31. `conditional-truck` failed in 3 of those 7 runs: the model sometimes reads "collect Saturday" as an uncovered request and drops the truck condition, and the strategy then counters while that request is open. That is a strategy follow-up, not fixed here.

What changed:

1. **Reviewer accuracy and wording.** The reviewer now gets every current public term and, from the listing, who handles collection. Code filters drop reviewer concerns about statements code already verified: the plain introduction, the public asking amount in either word order, a recorded approval announced with the agreement, and a declined term restated with the value the buyer asked for. Each filter has a test where it must not apply. A single closing question in the text is used even when the model also fills the separate question field. A clarifying question the plan needs is no longer blocked as "a new question". A firm-offer invitation is never repeated within the reply or across the next two replies. Fallback wording varies its opener, puts a clarifying question last, and the agreement line reads "for the king-size bed".
   - In the five handoff conversations, the misreadings called out in the handoff (introduction, public ask, buyer collection) no longer block drafts. The overall block count is about the same (9 across 17 turns in the final run). The remaining blocks mix correct catches (for example "The seller has approved" before approval) with model misreadings, and the checked fallback still delivers every turn.
2. **Discount allowance per commitment.** `commitmentAllowance` in the strategy guidance sets what a better firm offer earns and what each listed non-price commitment earns (counted once). Delivered counteroffers use it, and no reduction exceeds what is left, so a repeated or worse offer earns nothing. The ledger (commitment, earned, used, remaining) is projected from the record and saved on each private decision. The buyer view never carries it. Targets now follow the package: a conditional target applies only when its conditions hold.
   - Bed-sale guidance: `betterOffer` ₹1,500 (equal to the first approved step), no non-price commitments listed, because the demo mandate has no term the seller values beyond price.
3. **Repeatable live chat regressions.** The five handoff conversations and the reported chat replay are buyer scenarios 26 to 31, with per-turn expectations for the decision, action, offer and reply. `--save-replays` stores their model responses in `cases/bed-sale/replays/`. `apps/server/test/replays.test.ts` replays them through the same routes and configuration with no model call, and checks every turn's delivered reply, decision and offer. The runner, the app and the replays now share `loadCaseRuntime`, so the runner no longer omits listing configuration.
4. **Interpretation grounding** surfaced by the full run: "₹17,500 is the most I can do" or "is my limit" is a final offer at that amount, "₹17,000 then?" is a proposal, and "Would you take ₹18,000?" is an enquiry about ₹18,000 even when the model drops the amount. A budget stated as a budget stays a ceiling.

Scenario checks loosened to accept correct model wording: unknown details ("aren't confirmed"), the changed-condition read-back, the seller-ends notice, and the cheaper-elsewhere value question (`answer` or `explain_price`). The introduction check now looks for one introduction naming Kritva, matching the named introduction.

## Closure verification

- Node 24.19.0. All 292 automated tests passed (239 core, 53 server). Workspace type checks and the production web build passed.
- All [25 live buyer scenarios](../scenarios/epic-12-14-closure/scenario-results.md) passed, including the seven core regressions and the partner-approval case.
- The seller API requires a seller key. The regression suite checks that buyer access cannot read private data or approve an offer, that seller approval requires the exact offer and mandate revision, and that reconnecting clears the interrupted indicator without replaying an old offer.
- A desktop Chromium run on localhost passed end to end with injected microphone audio and live OpenAI transcription, reasoning and speech. A double click opened one session. Mute and unmute toggled the microphone track, and the seller paused and resumed during the call. The buyer interrupted a counteroffer with ₹20,000. Kritva read back the king-size bed, price, Koramangala pickup and no delivery. The seller approved after the buyer confirmed. The agreement survived refresh with payment and pickup pending. The buyer-only window made zero seller API requests, ending voice stopped the track, and a fresh demo session kept the mandate and cleared prior offers.
- The [live speech pipeline](voice-timing-composed.md) measured 11 turns. Median time to the first audio byte was 5.6 seconds and the slowest turn was 7.5 seconds. The target is 1.5 seconds. Browser capture and playback buffering add time.
- A physical microphone rehearsal and verification on the deployed HTTPS origin remain open.

## Initial implementation checks

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
