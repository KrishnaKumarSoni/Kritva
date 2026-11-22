# Several counterparties on one deal: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One saved mandate runs up to N counterparties at once, with a shared offer board, a limit that moves with a better live offer, code-enforced citing, a reserve-then-conclude lock, and polite closing of the others (also mid-call).

**Architecture:** A group record (new append-only tables on the record's SQLite connection) links the sessions of one saved mandate. Offers stay in each session's own record and are projected into a board. The engine takes an optional `DealGroups` dependency; without it every path is today's.

**Tech Stack:** TypeScript on Node 24, `node:sqlite`, zod, Hono, React (Vite), vitest, OpenAI Realtime.

**Spec:** `docs/Kritva_Multiple_Counterparties.md` (approved 2026-11-22).

## Global Constraints

- Core stays case-neutral: `packages/core/test/unit/case-neutral.test.ts` must pass (no "buyer", "seller", "₹", case amounts in `packages/core/src`).
- Every rule is direction-aware (`NegotiableTerm.direction` "up" or "down"); "better" means better for the principal.
- `KRITVA_MAX_COUNTERPARTIES`, default 5: caps list entries per mandate and open sessions per group.
- Prepared mandates from `cases/` (no `mandateSource`) never join a group.
- No em dashes anywhere. Interface work uses `fluid-design`, `apple-design`, `better-ui`, `better-polish`, `better-interface`; Geist Serif headings; accent `#CC5500` for primary actions; Kritva-styled dropdowns.
- Demo path first. The user asked not to spend time on edge cases that will not happen in the demo.
- Tests: `npx vitest run --project unit --testTimeout=30000` in `packages/core`; `npx vitest run --testTimeout=30000` in `apps/server`. Node at `/Users/krishna/.nvm/versions/node/v24.19.0/bin`.

## Review Focus

1. Two approvals for two counterparties in the same tick: only one reserves; the second gets `reserved_elsewhere`. (Task 5 test.)
2. A reply that cites a competing amount better for the principal than the live one, or cites one when none exists: blocked. (Task 4 tests, both directions.)
3. A better competing offer arriving after Kritva already offered a value: Kritva holds, never raises its ask. (Task 4 test.)
4. A counterparty who is mid-sentence when the deal closes: Kritva speaks only after they stop. (Task 6 test.)
5. A single-counterparty negotiation under a saved mandate behaves exactly as before: all existing tests and scenarios unchanged. (Every task runs the full suites.)

---

### Task 1: Group record and counterparty list

**Files:**
- Create: `packages/core/src/record/groups.ts`
- Modify: `packages/core/src/record/store.ts` (append option `alsoWrite`), `packages/core/src/record/sqlite.ts` (group tables), `packages/core/src/mandate/library.ts` (counterparty list), `packages/core/src/index.ts`
- Test: `packages/core/test/unit/groups.test.ts`, `packages/core/test/unit/library-counterparties.test.ts`

**Interfaces (produces):**
- `RecordBackend` gains `insertGroupEvent(row: GroupEventRow): void`, `listGroupEvents(groupId?: string): GroupEventRow[]`.
- `NegotiationRecord.append(sessionId, event, actor, options?: { alsoWrite?: () => void })`: `alsoWrite` runs inside the same transaction; a throw rolls back both.
- `NegotiationRecord.groupBackend(): Pick<RecordBackend, "insertGroupEvent" | "listGroupEvents" | "transaction">`.
- `class DealGroups { constructor(record: NegotiationRecord, options: { maxOpen: number }) }` with:
  - `start(input: { mandate: ConfirmedMandate; mandateSource: { mandateId: string; revision: number }; entryId: string | null; via: "link" | "listing" | "phone" | "console"; previousSessionId?: string | null }): Promise<{ ok: true; sessionId: string; groupId: string } | { ok: false; code: "full" | "concluded" | "start_failed"; message: string }>`
  - `groupOf(sessionId: string): GroupState | null`, `openGroup(mandateId: string): GroupState | null`, `members(groupId: string): Array<{ sessionId: string; entryId: string | null; via: string; joinedAt: string }>`
  - `reserve(sessionId, r: { offerId: string; termsHash: string; approvalId: string | null }): { ok: true } | { ok: false; code: "reserved_elsewhere"; holderSessionId: string }`
  - `release(sessionId: string, reason: string): void`
  - `concludeWrite(sessionId: string, agreementOfferId: string): () => void` (for `alsoWrite`; throws if no matching reservation or the group concluded)
  - `recordTime(groupId: string, t: { action: string; sessionId: string | null; ms: number }): void`
- `GroupState = { groupId; mandateId; caseId; reservation: { sessionId; offerId; termsHash } | null; concluded: { sessionId } | null; timeMs: number }`
- `MandateLibrary`: `counterparties(mandateId): CounterpartyEntry[]`, `addCounterparty(mandateId, e: { name: string; phone: string | null; note: string | null }, max: number): LibraryResult<CounterpartyEntry>`, `updateCounterparty(...)`, `removeCounterparty(mandateId, entryId)`, `setLifecycleDirect` reuses `setLifecycle`. `CounterpartyEntry = { id; name; phone; note; addedAt }`.

- [ ] Write failing tests: start under cap succeeds and writes `group_opened` once then `counterparty_joined`; the (max+1)th open session gets `full`; a reset (`previousSessionId`) ends the old session and does not count twice; `reserve` twice from two sessions gives `reserved_elsewhere`; `release` then `reserve` succeeds; `concludeWrite` with `append(..., { alsoWrite })` writes both or neither; `start` after conclusion gives `concluded`; library list caps at `max` and never touches the confirmed body or revision.
- [ ] Run, see them fail. Implement. Run core suite, all pass. Commit.

### Task 2: Every entry point joins the group

**Files:** Modify `apps/server/src/app.ts` (POST `/api/operator/sessions` for `library:` mandates; new routes below), `apps/server/src/voice-routes.ts` (listing call), `apps/server/src/phone/routes.ts` (incoming call), `apps/server/src/main.ts`, `apps/server/src/main-helpers.ts` (read `KRITVA_MAX_COUNTERPARTIES`). Test: `apps/server/test/groups-routes.test.ts`.

**Interfaces (produces):**
- `GET/POST /api/operator/library/:id/counterparties`, `PATCH/DELETE /api/operator/library/:id/counterparties/:entryId`
- `POST /api/operator/library/:id/start` → `{ started: Array<{ entryId; sessionId; link: string }>, refused: Array<{ entryId; reason }> }`; starts one session per listed entry without an open session.
- Phone: a caller whose number equals a listed entry's phone and who has an open session continues it; otherwise a walk-in `start` (`via: "phone"`); `full` declines with 486.
- Listing call and console start: `full` → 409 `{ error: "busy", message: "Busy right now. Try again in a little while." }`.

- [ ] Failing route tests (fake LLM, as existing server tests): start two listed, then a walk-in, then the cap; phone caller match continues the same session. Implement. Full server suite passes. Commit.

### Task 3: Offer board

**Files:** Create `packages/core/src/negotiation/board.ts`; modify `apps/server/src/app.ts` (`GET /api/operator/library/:id/board`). Test: `packages/core/test/unit/board.test.ts`.

**Interfaces (produces):**
- `liveOffer(state: NegotiationState, ctx: SessionContext): { offerId: string; terms: OfferTerm[]; at: string; amount: number | null; withinLimits: boolean | null } | null` (null within-limits = unclear)
- `scoreOffer(view: MandateView, terms: OfferTerm[]): { score: number; parts: Array<{ termId: string; value: number; weight: number }> }`
- `projectBoard(rows: Array<{ sessionId: string; state: NegotiationState; ctx: SessionContext; entry: { id: string; name: string } | null; via: string; live: boolean }>, group: GroupState): Board` with `Board = { rows: BoardRow[]; bestSessionId: string | null; counters: { negotiationsRun: number; timeMs: number; dealsOutsideLimits: number } }`; `BoardRow` carries status label key, latest offer, `gap` (signed, positive = room for the principal, from the mandate's limit), `flag: "outside_limits" | "unclear" | null`.
- Score rules from spec section 8. Negotiated term: `(v - limit) / (opening - limit)` clamped to [0, 1] (mirrored for "down"); weight 2 when no priorities; other terms 1 if they match a principal preference or target, 0.5 for a weak mismatch, 0 for a strong mismatch, ignored when the principal has no preference.

- [ ] Failing tests: "up" ranks the higher comparable offer best; "down" ranks the lower best; outside-limits never best and flagged; gap sign in both directions; tie goes to the earlier offer; `dealsOutsideLimits` is 0 for normal agreements. Implement. Commit.

### Task 4: Competition inside a negotiation

**Files:** Modify `packages/core/src/schema/records.ts` (`PermissionAction` gains `"mention_other_offers"`), `packages/core/src/governance/authority.ts` (`mayMentionOtherOffers(): boolean`, true only for `autonomous`), `packages/core/src/negotiation/state.ts` (`competition?: Competition` on `NegotiationState`, set by the engine, not by `projectState`), `packages/core/src/negotiation/policy.ts` (one helper `limitFor(state, termId, pkg)` replaces the `applicableLimit(...)?.amount ?? n.limit` reads), `packages/core/src/negotiation/engine.ts` (`#plan`: set `state.competition` from groups before `decide`; choose citation after), `compose.ts` (brief `another_offer`), `conversation-guide.md` (one rule), `reply-check.ts` (`invented_competition`, cited amount allowed), `record/events.ts` (`decision.competition` optional, default null), `mapping/prompt.ts` (describe the action). Test: `packages/core/test/unit/competition.test.ts`.

**Interfaces:**
- Consumes: `DealGroups.groupOf`, `liveOffer` (Task 3).
- `Competition = { rivals: Array<{ amount: number; otherTerms: OfferTerm[] }>; mayCite: boolean }` (other open sessions' live offers within limits; `otherTerms` = all terms except the negotiated one).
- `limitFor(state, termId, pkg): number`: the better of the mandate's applicable limit and the best rival comparable to `pkg` (`sameValue` on every other term), never past `state.currentAsk` (so nothing already offered is withdrawn).
- `Plan.competingAmount?: number`: set when `mayCite`, a comparable rival exists, the counterparty's latest amount is worse than it, the move is `counter`, `hold` or a decline, and this value was not cited before in this session.
- Reply check: an amount equal to `plan.competingAmount` is allowed only if it is not better for the principal than the best comparable rival read at check time; `invented_competition` blocks `/\b(another|other|competing|second) (offers?|bids?|quotes?)\b|\bsomeone else\b|\bother (people|parties)\b|\bother <role>s?\b|\banother <role>\b/i` (role from the mandate) unless `plan.competingAmount` is set or their own latest message mentions another offer.

- [ ] Failing tests (both directions): with a better comparable rival, `decide` never counters past it and never above `currentAsk` ("up") or below it ("down"); a non-comparable rival changes nothing; citation set only with the permission; reply citing a better-than-real number is blocked; reply mentioning another offer with no rival is blocked; with no group, behaviour equals today's. Implement. Full core suite and existing scenario replays pass. Commit.

### Task 5: Lock, closing the others, contact consent

**Files:** Modify `packages/core/src/negotiation/engine.ts`, `packages/core/src/negotiation/templates.ts`, `apps/server/src/app.ts` (approval route maps `reserved_elsewhere` to 409; board and approval cards show group states), `apps/server/src/main.ts` (wire `onDealConcluded`). Test: `packages/core/test/unit/lock.test.ts`, server route test.

**Interfaces (produces):**
- `EngineOptions.groups?: DealGroups`, `EngineOptions.onDealConcluded?: (e: { groupId: string; mandateId: string; sessionId: string }) => void | Promise<void>`, `EngineOptions.onSessionClosedElsewhere?: (sessionId: string) => void`.
- `#onApproved(...)` (reservation) and `#recordAgreement(writes, state, payload)` (conclude in the same transaction via `alsoWrite`), matching the approval session's hook names. Today's `respondToApproval` and the autonomous `confirm_agreement` path both call them.
- `TurnError.code` gains `"reserved_elsewhere"`.
- `closeForDealElsewhere(input: { sessionId: string }): Promise<TurnResult | TurnError>`: status to `no_agreement` (reason "The principal agreed terms with another counterparty."), code template reply (no model call), channel = the session's last channel.
- After the close, the next counterparty message is read in code for consent (yes or no words, digits of a phone number) and recorded as a `counterparty_noted` item (kind `preference`, value = number if given); the reply is a template thanks, or one ask for the number when they said yes without one in chat or browser voice.
- After conclusion: close every other open member, then `onDealConcluded` sets the library mandate to closed directly.

- [ ] Failing tests: approve A then approve B gives `reserved_elsewhere`; A's agreement concludes the group and closes B with the template (mentions keeping their number, names no other party, no amount); B saying "yes, 98450 12345" records consent with the number; a new start after conclusion is refused; single-session approval behaves as before. Implement. Commit.

### Task 6: Breaking into a live call

**Files:** Modify `apps/server/src/realtime-voice.ts` (`RealtimeCall.breakIn(): void`, a shared `liveCalls: Map<string, RealtimeCall>` registry), `apps/server/src/phone/routes.ts` and the browser realtime route (register calls), `apps/server/src/phone/phone-call.ts` (hang up after the consent reply). Test: `apps/server/test/realtime-break-in.test.ts` (fake link).

**Interfaces:**
- `breakIn()`: if a response is playing, wait for the first sentence end in `response.output_audio_transcript.delta` (`.`, `?`, `!`), then send `response.cancel` and `output_audio_buffer.clear`, and drop queued lines; if the counterparty is speaking (`input_audio_buffer.speech_started` without `speech_stopped`), wait for `speech_stopped` and do not answer that turn; then speak the filler (`FILLER[lang]`, en "Sorry, one second.") and the closing message as soon as it is recorded.
- `onSessionClosedElsewhere` from Task 5 calls `liveCalls.get(id)?.breakIn()`.

- [ ] Failing tests with the fake link: mid-reply, the cancel is sent only after a sentence end; while they speak, nothing is sent until they stop; the filler goes before the closing message; queued lines are dropped. Implement. Commit. Then one real browser call with the realtime check script.

### Task 7: Console board

**Files:** Create `apps/web/src/BoardPage.tsx`; modify `apps/web/src/api.ts`, `apps/web/src/App.tsx` (a "Deals" view, open a row's negotiation, back to the board), `apps/web/src/MandatesPage.tsx` (open the board), `apps/web/src/styles.css`.

- [ ] Load all five interface skills. Build: header (title, counters), rows (name, channel with a live dot, status, latest offer, flag, gap, star), pending approval cards with group states, counterparty list editor with copy-link and "n of 5", "Start negotiations" button. Report `principal_time` ms with each action. Poll every 2.5 s. Check in the browser at desktop and phone width, light and dark. Commit.

### Task 8: Demo data, intake and live scenarios

**Files:** Modify `cases/bed-sale/mandates/demo.confirmed.json` (add the `mention_other_offers` autonomous permission), the intake agent prompt (one optional question about known counterparties and one about mentioning other offers), `apps/server/scripts/run-scenarios.ts` (group scenarios: several scripted counterparties plus principal actions), `cases/bed-sale/group-scenarios/*.json`.

- [ ] Scenarios: (1) two accept, approve one, second refused, other closed with the number question; (2) better comparable offer from B stops Kritva countering A below it; (3) citation allowed cites at most B's real amount; (4) a lone counterparty asking about other offers gets no invented one. Run them live, then the full existing scenario set, and compare with the last report for regressions. Commit.
