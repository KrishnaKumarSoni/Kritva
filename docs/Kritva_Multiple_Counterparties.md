# Several counterparties on one deal: design

Written 2026-11-22 on branch `claude/multiple-counterparties-cd7063`. Status: draft for the user's approval.

## 1. Intent

Today a negotiation is one session: one principal, one counterparty, one record. A principal with one thing to sell (or one thing to buy) usually talks to several counterparties at once, but Kritva has no idea they exist side by side. Two of them can both reach an agreement on the same deal, and nothing stops the second one.

This work lets one principal run one mandate against several counterparties at the same time or one after another, and keeps them from colliding. It must work in both directions. A principal selling one item to several possible buyers and a principal buying one service from several possible sellers use the same rules. All rules below are written from the principal's side:

- **The limit** is the principal's walk-away value on the negotiated term: a floor when the principal wants a higher value, a ceiling when the principal wants a lower one. The core already has this as `direction` "up" or "down".
- **Better** always means better for the principal.

**Why (the user's words):** it covers the missing "type B" case, it is the on-screen proof of scale, and interrupting a live call when the deal is gone shows control at scale, handled gracefully.

## 2. Goals, non-goals, anti-goals

**Goals (all P0)**
1. Many sessions under one mandate at the same time.
2. One shared list of offers: who offered, the terms, the time, the status.
3. The best offer marked, by scoring all terms with the mandate's priorities. Any offer outside the limits flagged.
4. Another counterparty's offer may be mentioned only if it is real and the mandate allows it. Code enforces this and never lets a reply cite a number better for the principal than the real one.
5. A better live offer from another counterparty becomes Kritva's limit for its counters to everyone else (the user: "we should revise the floor if we get a better offer than the mandate floor").
6. The first approval locks the deal. If two counterparties say yes at once, the first one approved wins.
7. The other sessions are closed politely, including any that are on a live call: Kritva finishes its sentence, says a short filler, gives the news and asks to keep their number.
8. An optional list of counterparties on the mandate, capped by an environment setting (default 5).
9. Console: a board with one row per counterparty (status, latest offer, gap to the limit, a star on the best), starting several negotiations at once, the approval card, and header counters (negotiations run, your time used, deals outside limits).
10. Every existing single-counterparty behaviour keeps working, and all tests and evals pass.

**Non-goals**
- Simulated counterparties. Real counterparties only (the user: "we don't have time for simulated").
- Outbound messages to start a negotiation. (Outbound calls are now in scope: see section 13a. Follow-up calls belong to the approval session.)
- Several units of one item, or a principal making several deals from one mandate.
- Finding counterparties. The host or the principal supplies them.
- Time limits on offers. An offer stays live while its session is open (see section 8).

**Anti-goals (a failure even if everything else works)**
- Kritva mentions a competing offer that does not exist, or one that is better for the principal than the real one.
- One counterparty learns anything about another beyond what the mandate allows: a name, a number, a channel, other terms, or how many others there are.
- Two agreements recorded for one deal.
- A counterparty on a live call hears nothing about the deal being gone, or hears it in the middle of a sentence or over their own voice.
- Kritva withdraws something it already offered because a better offer came in elsewhere.
- Any change to how a single-counterparty negotiation behaves.

## 3. Constraints

- Code decides every amount and commitment. The model only reads messages and words replies (existing rule).
- The core stays case-neutral. `packages/core/test/unit/case-neutral.test.ts` forbids case words in `packages/core/src`, including the words for the two sides of a sale. Core code says "principal" and "counterparty", and reads role names from the mandate.
- Each counterparty's session never reads another session's record. Cross-session facts reach a session only as two numbers from code: its current limit and, when allowed, the amount it may cite.
- Latency matters (Bangalore). Nothing slow is added to a normal turn. Reading a group of at most 5 sessions is cheap.
- Never use em dashes. AWS later for deployment. OpenAI for models.
- Interface work uses the `fluid-design`, `apple-design`, `better-ui`, `better-polish` and `better-interface` skills, Geist Serif headings, burnt orange `#CC5500` for primary actions, jet black `#0A0A0A`, white, and Kritva-styled dropdowns (CLAUDE.md).
- Other sessions are changing the same code (section 15). Their work lands first and this builds on it. Planned record changes are announced to the approval session before they are made: an optional `competition` field on the `decision` event, the group events in their own module and tables, and a new `mention_other_offers` permission action. `record/rules.ts` does not change.

## 4. Approaches

**A. A group record over the sessions (picked by the user).** A small new append-only record holds what belongs to the group: which sessions belong to the deal, and when the deal was reserved, released and concluded. Offers are not copied into it. Each counterparty's offers stay in their own session record, and the board reads them from there. The lock is one database transaction on the group record. A mandate without a group runs exactly as today.

**B. Tag sessions and add a lock table.** About a day cheaper. Rejected: reservations, releases and the reason each counterparty was closed would be in no record, so the board's "who won, and why" would have to be pieced together from scattered session events and a side table. That weakens the audit trail the console depends on.

**C. One session holding every counterparty.** Rejected: every check and the agent's context would have to filter by counterparty, one slip from showing A's messages to B, and each counterparty's turn would wait on everyone else's.

## 5. Words used in this design

| Word | Meaning |
|---|---|
| Principal | The person Kritva represents (selling or buying). |
| Counterparty | One person on the other side. Each has one session. |
| Deal | The one agreement a mandate can make. One mandate, one deal. |
| Group | The sessions competing for one deal, plus the group record. |
| Live offer | A counterparty's latest offer (kind "offer", not an enquiry or interest) in a session that is still open, not withdrawn and not replaced by a later offer. Accepting Kritva's stated terms is a live offer at those terms. |
| Comparable | Two offers are comparable when they have the same value on every term except the negotiated one. |
| Within limits | The offer's package passes the deal-space check against the mandate revision in force, or its only conflicts are covered by an exception the principal approved for those exact terms. |

## 6. The counterparty list on the mandate

The user asked for an optional list of counterparties in the mandate. It lives on the saved mandate in the library, **outside the confirmed mandate body**:
- Adding or removing someone must not need a new revision and a new confirmation of the rules.
- Each session copies the confirmed mandate into its record. A list inside the body would put every counterparty's name and number into every other counterparty's session, next to the agent.

Each entry: an ID, a name (required), a phone number (optional, E.164 after normalising with the country code the phone setup already uses), and a private note (optional). Entries are added, edited and removed as append-only library events, like versions and lifecycle actions today.

**The cap.** `KRITVA_MAX_COUNTERPARTIES` (default 5) is read by the server and passed to the core. It caps two things with one number, because tokens are spent in sessions, not in list entries:
- the entries on one mandate's list;
- the open sessions in one group at a time (listed counterparties and walk-ins together).

A start beyond the cap is refused politely: the console says why, a browser caller sees "Busy right now, try again later", and a phone call gets the existing SIP 486 busy.

**Where the list is filled in.** The intake chat asks once, as an optional last step, whether the principal already knows who they will negotiate with (up to the cap). The mandates page and the board can add, edit and remove entries any time.

## 7. The group record

**Storage.** New append-only tables in the record database, on the same connection as sessions and events (`SqliteRecordBackend`), so a reservation and the session event that depends on it can be written in one transaction. The same no-update and no-delete triggers as `events`.

**One group per deal.** A group opens for a saved (library) mandate the first time a session starts under it, and stays open until its deal concludes or the principal closes the mandate. Reopening a closed mandate opens a new group. Prepared mandates from `cases/` (not in the library) never get a group and behave exactly as today. A session belongs to the group of the saved mandate named in its `session_started` `mandateSource`, so no session event changes.

**One revision for the whole group.** Confirming a new revision of a saved mandate already moves every open session using it to that revision (the library's confirm route and Epic 4's revision path). So all open sessions in a group share the revision in force, and "within limits" means the same thing for all of them.

**Resets.** Starting a negotiation with `previousSessionId` (a reset) ends the previous session and the new one takes its place in the group, with the same list entry. It is not a second counterparty and does not count twice against the cap.

**Group events** (principal and operator only, never shown to any counterparty):

| Event | Payload |
|---|---|
| `group_opened` | library mandate ID, case ID, the cap in force |
| `counterparty_joined` | session ID, list entry ID or null (a walk-in), how they came: link, listing, phone, console |
| `deal_reserved` | session ID, offer ID, terms hash, approval ID or null (a mandate that agrees without approval) |
| `deal_released` | session ID, reason: the counterparty declined or changed terms on the follow-up, the follow-up lapsed, or the principal cancelled |
| `deal_concluded` | session ID, agreement event ID |
| `principal_time` | what the principal did (approve, counter, decline, end, pause, start, edit list), session ID if any, milliseconds (section 13) |

**Rules, enforced when appending:**
- At most one active reservation per group. `deal_reserved` is refused while another is active; `deal_released` ends it.
- `deal_concluded` needs an active reservation for the same session and terms hash, and is written in the same transaction as that session's `agreement_recorded`. Nothing can be appended to a concluded group except `principal_time`.
- `counterparty_joined` is refused when the group has as many open sessions as the cap.

The engine gets an optional `DealGroups` dependency. Without it, or for a session outside any group, every code path is today's.

## 8. The offer board

A projection over the group record and each member session's own record. For each counterparty:
- name (from the list entry), or "Walk-in" with the channel and, for a phone caller, the last four digits;
- channel and whether a call is live now;
- status: not started, talking, waiting for your approval, reserved, waiting for their yes, agreed, closed because the deal went elsewhere, ended;
- the latest live offer: the full package (their terms over the principal's current package), and when it was made;
- within limits, outside limits, or unclear (the deal-space check says it needs clarification);
- the gap to the limit on the negotiated term, from the mandate's own limit, signed so that a positive gap is room in the principal's favour ("₹1,500 above your floor", "₹500 over your ceiling");
- the score, and a star on the best.

**Score.** One number per live offer, from the mandate, case-neutral:
1. Outside limits or unclear: no score, never the best, flagged.
2. Each term of the package gets a value from 0 to 1. The negotiated term: 0 at the mandate's limit, 1 at the opening value or better, linear between, mirrored for direction "down". Other terms: 1 when the value matches the principal's target or preference, lower for a permitted value the principal prefers less (weak preferences cost less than strong ones), 1 when the principal stated no preference (so those terms never change the order).
3. Terms are weighted by the mandate's priorities: a term named by a higher-priority goal weighs more. When the mandate gives no priorities (the demo mandate gives none), the negotiated term weighs twice any other term the principal has a preference on.
4. The score is the weighted mean. Ties go to the earlier offer. The board shows the breakdown, so the principal can see why one offer ranks first.

The exact formula within these rules is left to the builder, with unit tests that cover both directions.

**Header counters** for the group: negotiations run (sessions that joined, open or closed), your time used (section 13), and deals outside limits (agreements whose terms break the mandate's hard limits without an approved exception; this is 0 by construction, and any other number links to the record as a bug).

## 9. Competition inside a negotiation

### 9.1 A better live offer moves the limit

For a session S negotiating package x, the **effective limit** is the better (for the principal) of:
- the mandate's applicable limit for x (today's `applicableLimit(...) ?? n.limit`), and
- the best live offer from another open session in the group that is within limits and comparable to x.

Rules:
- It only ever moves in the principal's favour. It falls back when that offer is withdrawn, changed, or its session closes.
- It is capped at the opening value. Kritva never raises its public opening because of someone else.
- It stops further concessions. It never withdraws an offer Kritva already made to S. If S accepts Kritva's earlier offer, that acceptance stands and goes to the principal's approval as usual, and the board shows both offers.
- It is a strategy input, not a governance limit. The policy uses it wherever it reads the limit today (one helper replaces those reads). The outgoing gate and the reply check keep the mandate's limit, and the principal can still approve anything within the mandate.
- An offer on different terms (not comparable) shows on the board but does not move the limit. A different package is a different deal, and the mandate's own conditional limits already price package differences.

### 9.2 Citing another offer

**Permission.** A new permission action, `mention_other_offers`, in the mandate schema. Only mode `autonomous` allows it. A missing permission, `prohibited` or `requires_approval` all mean no. The intake chat asks once; the mapping prompt and validators learn the new action. Being a permission, it is part of the confirmed mandate and changes only through the principal's confirmation.

**What may be cited.** Only an offer that also moves the limit (live, within limits, comparable, from another open session), and only its value on the negotiated term. Never who made it, how they reached Kritva, when, how many others there are, or any other term.

**When.** The policy decides, never the model: when S's latest offer is worse than the citable offer and S asks for a concession or pushes back. At most once per citable value per session. The plan carries `competingAmount`: the real value, or a less favourable value rounded to the price step.

**Enforced in code, at the moment the reply is checked** (the group may have changed since the plan was made):
- An amount in the reply is allowed as a citation only if it equals the plan's `competingAmount` and that amount is not better for the principal than the best citable offer right now (at most the real value for direction "up", at least the real value for direction "down").
- A new reply-check rule, `invented_competition`: any mention of another offer or another interested party is blocked unless the plan carries a citation, or the move is Kritva's comparison question about the counterparty's own claim ("cheaper elsewhere"). The pattern uses generic words plus the role names from the mandate, so the core stays case-neutral.
- The realtime voice model's own words (conversation turns) go through the same check after the fact, as today, and are corrected if they break it.

With no group, no permission or no citable offer, the plan never carries a citation, so the second rule blocks every mention. This also covers a single negotiation that bluffs about other interest.

## 10. The lock

The lock has two steps, matching the approval session's design (approval happens later, then Kritva follows up, then the counterparty says yes again, and only then is there an agreement):

1. **Reserve** at the principal's approval of an accepted package (the approval session's `#onApproved` hook). This writes `deal_reserved`. While a reservation is active, any other approval for this deal is refused by the server, and its card says "Reserved for Ravi. You can approve this if that falls through." That is how "if two say yes at once, the first one approved wins" holds, even for two clicks at the same moment. Exception approvals (letting Kritva offer terms beyond a limit) and counters do not reserve: they are not a deal yet.
2. **Conclude** when the reserved counterparty says yes again and the agreement is recorded (the approval session's `#recordAgreement` hook). `deal_concluded` is written in the same transaction as `agreement_recorded`. Then the group closes, the other sessions are closed (section 11), and after that the library mandate's lifecycle is set to closed, so the listing and the phone line take no new calls. The order matters: the library's lifecycle route pauses every open session using the mandate, so the others are closed first and the lifecycle is set directly on the library, not through that route.

**Release.** The reservation ends, and nobody else is told anything (they never knew), when the reserved counterparty declines or changes terms on the follow-up, the follow-up lapses, or the principal cancels the reservation from the card. Everyone else carries on, and the effective limits recompute.

**A mandate that lets Kritva agree without approval.** Reserve and conclude happen together at the moment Kritva would record the agreement. If another session got there first, the agreement is refused and this counterparty is closed like the others.

**Until the approval session's work lands**, approval records the agreement straight away (today's `respondToApproval`). Then reserve and conclude happen together in that one call. The hooks are the same, so nothing changes when their work arrives.

## 11. Closing the other sessions

When a deal concludes, every other open session in the group is closed. For each, through the engine's per-session queue (so it waits for any turn already running):
- status changes to `no_agreement`, reason "The principal agreed terms with another counterparty", requested by the principal; any pending approval request in it is superseded (today's rule);
- Kritva says one closing message, started by code and checked like every reply: the news in plain words, with no detail about the other deal, then asks to keep their contact in case it falls through. Example for the demo case: "I've just heard from Krishna: the bed has gone to someone else, so I can't go ahead with this one. Can I keep your number in case it falls through?" The wording comes from the role names and the public subject in the mandate, so the core template stays case-neutral.

Where that message goes:
- **On a live call:** spoken on the call (section 12).
- **In an open chat:** it appears in their thread.
- **Waiting for an answer on a pending offer**, with a contact they gave the approval session's wrap-up: delivered through the approval session's follow-up channel, because they are expecting to hear back.
- **Otherwise:** recorded in their thread. If they come back, they read it, and any new message gets the same news.

**Their answer.** The next message is read for yes or no to keeping their contact. The consent is recorded with the approval session's contact event (it already asks "Can I keep your number?" after a decline), so there is one consent record, not two. On a phone call, the number is the caller ID, saved only on yes. In chat or a browser call, Kritva asks them to share a number only after a yes. A listed counterparty's number is already on the list, so the consent only marks it as fine to contact later. On a call, Kritva thanks them and ends the call.

## 12. Interrupting a live call

When the deal concludes, the group service notifies each live call's controller in the same process right away. The existing 1.2-second watch loop stays as a fallback.

- **Kritva is speaking:** it finishes the current sentence (read from the response's transcript deltas: a sentence ends at `.`, `?` or `!`), then the rest of that response is cancelled and any queued lines are dropped. The delivery report records what was actually spoken, as today for interrupted replies.
- **The counterparty is speaking:** Kritva lets them finish and does not answer what they said.
- **A deal turn is running in the engine:** the close waits for it (per-session queue). Its reply is dropped if it has not started playing, or cut at the end of a sentence if it has.
- Then a short **filler** line from the call's line table, in the language they last spoke ("Sorry, one second."), which covers the time the engine takes to write the closing message, then the **closing message** (section 11).
- After their answer about the contact, Kritva thanks them and ends the call: hang-up for a phone call, end of call for a browser call.
- While the session is closed, every turn goes to the engine (today's `tool_choice: required` for a session that is not active), so the realtime model never answers on its own about a deal that is gone.

Browser calls and phone calls share `RealtimeCall`, so one implementation serves both. Only the way of cutting the audio differs (`response.cancel` for both; the browser also needs its output buffer cleared). The builder confirms this with the existing realtime check script on a real call.

## 13. How counterparties reach Kritva

- **Start negotiations (console).** For every listed counterparty without a session, start a session under the active revision, linked to their entry, up to the cap. Each gets a private link (`?view=buyer#session=<id>`, today's counterparty page). The principal sends the links themselves. Kritva greets each one when they open it (today's greeting).
- **The public listing ("Call seller")** and **the console's "New negotiation"** under a saved mandate join the group as walk-ins, within the cap.
- **A phone call** from a listed number joins that counterparty's session and continues it. A call from any other number is a walk-in, within the cap. Both use the caller number the phone routes already read from the SIP headers. A call for a deal that has concluded hears the same closing news.

### 13a. Kritva calls the counterparties (added 2026-11-22)

The user asked for Kritva to call the numbers the principal provides. The telephony session owns the dialer (Vobiz Make Call, bridged into the same realtime controller); this work owns when to call and what the board shows. The agreed interface (`Dialer` in apps/server/src/group-routes.ts):
- `call({ sessionId, to, clientRequestId })`, `listForSession(sessionId)`, `hangup(callId)`; a call view with a masked number, state (dialling, ringing, answered, connected, ended) and outcome (completed, no answer, busy, failed, blocked, cancelled).
- One call belongs to one negotiation session. "Start negotiations" calls every listed counterparty with a phone number; the others get their private link. The board shows each call's state and has a Call button per counterparty. No automatic retries in P0.
- Numbers stay only on the mandate's counterparty list (operator-only). The dialer keeps them in memory and masks them in logs; the record gets only voice_connection events.
- An answered call goes through the phone routes' connect(), so break-in and "keep your number" work unchanged, and the engine opens with `greet({ outbound: true })`: who is calling, for whom, about what, and whether now is a good time.
- When a deal goes elsewhere, calls to the others that are still dialling or ringing are hung up.
- Open (the user's call): India's Do-Not-Disturb rules need documented consent to be called. Until decided, the dialer's allowlist (KRITVA_PHONE_OUTBOUND_ALLOW) is the only gate.

**Your time used.** The console measures, for each principal action on this group (approve, counter, decline, end, pause, start negotiations, edit the list), the time from when the thing to decide first appeared on screen to the click, and sends it with the action. The server records it as `principal_time`. The header shows the sum. Nothing is counted while the console is closed.

## 14. Console

A new board for each saved mandate, opened from the mandates page and from the negotiation view. Text sketch (selling example; a buying mandate reads the same with "ceiling"):

```
Kritva   Negotiations   Mandates
King-size bed · Koramangala                         [Start negotiations (2)]
5 negotiations run  ·  1 min 40 s of your time  ·  0 deals outside limits

   Counterparty      Channel         Status                Latest offer             Gap to your limit
★  Ravi              Phone · live    Waiting for you       ₹19,500 · pickup today   ₹1,500 above
   Asha              Chat            Talking               ₹18,800                  ₹800 above
   Walk-in ···4821   Browser call    Talking               ₹16,000  Outside limits  ₹2,000 below
   Meera             Link sent       Not opened yet        none
   Karthik           Chat            Closed: went to Ravi  ₹18,000
```

- A row opens that negotiation (today's chat and insights view) with a way back to the board.
- Pending approvals appear on the board above the rows, using the approval session's card. Their card shows every term and the follow-up status. This work adds its group states: "Reserved for Ravi" (approve disabled) and "Went to Ravi" (closed). If their card has no state for terms that changed after the request, this work adds "Terms changed, approve again".
- The counterparty list (add, edit, remove, copy each link) sits on the board, with the cap shown ("3 of 5").
- The star, flags and status changes animate with the `fluid-design` skill's interruptible spring motion. The page polls like today's console (every 2.5 seconds).

## 15. Work by other sessions, and merge order

| Session | Owns | Effect on this work |
|---|---|---|
| Parent (`epics-12-14-console-voice-demo`) | The refactor: code checks slimmed to hard limits, a plain-text conversation guide, a price and terms split in the brief. Touches `engine.ts`, `gate.ts`, `reply-check.ts`, `compose.ts`, `negotiator.ts`, `app.ts` and the phone routes. | Merged into this branch (commit `4424d97` and the voice-wait commit after it). The reply check still has its hard-limit rules, and the `invented_competition` rule (9.2) joins them. Baseline after the merge: 352 core and 129 server tests pass. |
| Approval (`claude/approval-flow-1d75c9`) | Per-session approval: approve, counter and decline; the wrap-up; follow-ups; the contact consent event; the approval card; the `#onApproved` and `#recordAgreement` hooks. | This work hooks into those two functions and reuses the consent event and the card. Changes to `record/events.ts` and `record/rules.ts` are announced to each other first. |
| Phone calls | Vobiz trunk, `phone/routes.ts`. | Caller matching and the cap are added there (section 13). |
| Tone | Reply wording. | The closing message follows the conversation guide like every other reply. |

## 16. Stages, tests and evals

Each stage is its own commit, with unit tests, and the full core and server suites plus the existing scenarios passing.

1. **Group record and list.** Tables, events, append rules, projection; the counterparty list in the library with the cap; sessions joining groups from every entry point; board API (read only). No change to how any negotiation behaves.
2. **Offer board.** Live offers, the score, flags, the gap, the best, the counters. Unit tests in both directions.
3. **Competition in negotiation.** The effective limit, the `mention_other_offers` permission, the citation plan and the `invented_competition` rule.
4. **Lock and closing.** Reserve, conclude, release; closing other sessions in text; contact consent. Hooked to the approval session's functions, or to today's `respondToApproval` if theirs has not landed.
5. **Live calls.** End-of-sentence interruption, the filler and the closing message on browser and phone calls; caller matching and the cap on calls. Tests with the fake realtime connector, then one real call with the check script.
6. **Console.** The board, starting several negotiations, the counters, the approval card states. Checked in the browser.
7. **Intake and mandates page.** The optional list step and the citation permission question.

**New live scenarios** (`run-scenarios.ts` learns a group scenario: several scripted counterparties taking turns, plus principal actions; scripted test turns, not simulated counterparties):
- two counterparties accept; the principal approves one; the second approval is refused; the reserved one confirms; the other is closed with the news and the contact question;
- a better comparable offer from B stops Kritva from countering A below it, without withdrawing what A was already offered;
- citation allowed: the reply cites at most B's real value and nothing else about B;
- citation not allowed: no mention of any other offer;
- one counterparty asks "do you have other offers?": Kritva invents none;
- a buying mandate (a new small confirmed buying case): the best is the lowest acceptable quote, the limit moves down, and no cited quote is lower than the real one;
- an offer outside limits is flagged, never starred, never moves the limit and is never cited;
- the reserved counterparty backs out: the reservation is released and everyone else carries on;
- the cap: a counterparty beyond it is refused.

All existing scenarios run unchanged (single counterparty), and an eval run shows no regressions. Where a scenario uses a saved mandate, the harness reopens it before each run, because concluding a deal now closes the mandate.

## 17. Calls I made (please check these)

1. The counterparty list lives on the saved mandate but outside the confirmed body (privacy, no re-confirmation).
2. One environment cap (`KRITVA_MAX_COUNTERPARTIES`, default 5) limits both the list and the open sessions per group.
3. Only comparable offers (same values on every other term) move the limit or can be cited.
4. The effective limit never goes past the opening value, and never withdraws an offer already made.
5. Citation is a mandate permission, off unless granted. It covers only the value on the negotiated term, never identity, channel, timing, count or other terms.
6. Approval reserves the deal; the counterparty's yes after approval concludes it; then the others are closed. A release tells the others nothing.
7. Concluding a deal closes the saved mandate (reopening it relists).
8. When no priorities are given, the negotiated term weighs twice any other term the principal has a preference on.
9. "Your time used" is measured by the console from when a decision appears on screen to the click.
10. "Deals outside limits" counts agreements outside the mandate's hard limits without an approved exception.
11. Offers have no time limit in P0: an offer is live while its session is open.
12. A phone call from a listed counterparty's number continues their session. This answers the phone session's open question ("new negotiation per call, or continue by caller number?"). The risk: caller ID can be faked, and the caller would then hear Kritva continue that counterparty's negotiation (their offers and Kritva's, never anyone else's). Walk-in callers always start a new session. If this risk is not acceptable, the alternative is that every call starts a new session and only the private link continues one.

## 18. Left to the builder

- The exact scoring formula within section 8's rules.
- Table layouts and indexes for the group record.
- The exact sentence-end detection and the audio-cut events for each transport, verified on a real call.
- Filler lines per language, alongside the call's existing line table.
- Copy on the board and cards, written with the `better-writing` and `better-ui` skills.
