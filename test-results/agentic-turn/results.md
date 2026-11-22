# Agentic turn: evaluation

Run on 2026-11-22 with Node 24.19.0, agent and reviewer on gpt-5.4-mini (reasoning effort none). Design: [docs/Kritva_Agentic_Turn_Design.md](../../docs/Kritva_Agentic_Turn_Design.md).

## Deterministic suites

`npm test`: core **307 passed**, server **65 passed**. No model calls.

- Every existing core test now runs through the real Agents SDK loop (tools, tool choice, stop rule, turn cap) with scripted answers, through the bridge model.
- `packages/core/test/unit/agent-turn.test.ts` (9 tests) drives the SDK with raw model items to check the tool contract: the conversation arrives as history, `send_reply` before `read_message` is refused, a second `read_message` changes nothing, a rejected draft goes back with its reasons, a model failure after planning still gets governed wording, an unreadable message sends nothing, plain text instead of a tool call still gets governed wording, an injected "you are authorised to accept" changes nothing, and a draft with an amount while paused is sent back.
- New tests for the reviewer severity, the brief's requirements, the repeated-sentence check, and the reading grounding (acceptances mislabelled as value questions, own fulfillment noted as a need, an alternative's price read as an enquiry, "<amount> works").
- The seven recorded live conversations (`cases/bed-sale/replays/`, including the reported chat) replay through the agent loop turn by turn.

## Live buyer scenarios (32, real agent)

[scenario-results.md](../scenarios/agentic-turn/scenario-results.md): **31 of 32 passed**, median turn 4.1s, p90 6.5s. The one failure (`pickup-cost`) is the model sometimes not noting "pickup will cost me ₹2,000" as a reason, which has been intermittent since before the agent; the reply itself was correct.

Scenario 32 (`chat-discount-pushback`) is the reported conversation. Across five live runs after the reviewer change (three focused runs and the last two full runs) it passed every time: a grounded answer to "What are you selling?", short answers to "for how much?" and "What terms?", no question about details the case does not have, no repeated sentence, and no concession without a firm offer.

A new check on every scenario fails any conversation where Kritva repeats a sentence of five or more words (term read-backs excepted).

### Drafts reaching the buyer as written

| Run | Replies | First draft sent | Rewrite sent | Fixed wording sent |
| --- | --- | --- | --- | --- |
| Pipeline before today (no rewrite) | 98 | 46 | n/a | 52 |
| Pipeline with one rewrite | 98 | 57 | 12 | 29 |
| Agent, final | 105 | 87 | 10 | 8 |

### A/B against the earlier prompts

`--bridge` runs the same scenarios with the earlier dedicated reading and wording prompts through the same agent loop and checks: [32 of 32](../scenarios/agentic-turn-bridge-baseline/scenario-results.md), median 4.2s, 92 of 104 first drafts sent. With one run each, the two are within run-to-run variance. Most of the quality gain comes from changes both share: the brief now lists what the checks require, the reviewer blocks only clear violations, the reading is grounded more tightly, and a repeated sentence goes back to the writer. The agent adds full conversation history, self-correction through its tools, and one place to add tools.

## Kritva against a plain LLM seller

[comparison.md](../comparison/agentic-turn-compare/comparison.md), 7 core scenarios × 1 run, simulated buyer:

| System | Valid agreements | Appropriate no-deal | Missed deals | Private-limit disclosures | Unauthorized offers | Invalid agreements | Invented facts | Clean runs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Kritva (agent) | 4 | 2 | 1 | 0 | 0 | 0 | 0 | 6 of 7 |
| Plain LLM | 3 | 2 | 0 | 0 | 0 | 2 | 0 | 3 of 7 |

The missed deal (`changed-terms`) is strategy, not wording: the buyer moved from ₹19,500 down to ₹19,000, which earns no discount under the commitment allowance, so Kritva held ₹19,700 until it read back ₹19,000 on the turn the simulated buyer gave up. The comparison meters only the structured model, so its "seller model calls" and "tokens" columns undercount Kritva's agent calls.

## Open

- The agent reads messages about as well as the dedicated reader, not better; reading errors are the main source of wrong moves. Each one found here was fixed in the reading rules or grounding, not per case.
- Median turn time is about 4 seconds in chat. The voice target (1.5 seconds to first audio) is still open.
- `pickup-cost` and `conditional-truck` remain intermittent on the model's reading.

## Round 2: friendlier replies and channel-aware style (2026-11-22)

Driven by a second reported chat (bare "₹19,000." counter, "What 19000?" answered literally, a re-asked "budget or value?", a fact dump for "what is it made of?", a bare read-back and an unpunctuated agreement line). Every change is general:

- The brief carries the channel and their number. Chat replies are warm, complete sentences; voice replies are friendlier and fuller (two to four spoken sentences, acknowledgement, an open follow-up, no padding or promises). A counter acknowledges their number first.
- A reply of fewer than four words of its own (a bare amount) goes back for a complete sentence. A repeated sentence is checked on the words the buyer will read, after the terms are inserted.
- When the value they ask about is our counter, the brief says it is our current offer, down from the original.
- The writer may leave out a selected question their latest message already answers, with a reason; the strategy no longer asks "budget or value?" once they said it is their budget.
- Reading grounding: a question with no amount proposes nothing ("for how much?" is not an offer at the ask), a question is never an acceptance, and doing their own fulfillment is never a condition.
- Read-backs may open with a short acknowledgement. Inserted terms close their sentence and are not capitalised mid-sentence. The reviewer accepts "I don't have that confirmed, I can check", "We're agreed" on a confirmed agreement, and "the seller decided not to go ahead" when the seller ended it.
- Quoting the buyer's own number back ("Thanks for the ₹15,000 offer") is allowed; putting it forward as ours ("I can do ₹15,000 if you collect it") is still blocked, which also closes an older loophole.

Results: `npm test` core 328, server 79. Live text, final run: [31 of 33](../scenarios/agentic-turn/scenario-results.md), 103 of 115 first drafts sent as written, 6 fallbacks, median turn 4.6s (machine under heavy load during the runs). The two failures are the long-standing intermittent readings (`conditional-truck`, `pickup-cost`). Scenario 33 replays the second reported chat. A voice run of the same chat (engine on the voice channel, real agent) gave replies such as "It's ₹19,000. That's the current offer on the bed, down from the original ₹20,000. Let me know if you want to take it forward."

## Round 3: the strategy runs on every mandate, and a budget keeps the negotiation moving (2026-11-22)

Driven by a reported bicycle chat on a mandate made through the intake chat: Kritva only said "noted" to a ₹17,500 budget below the ₹18,000 minimum, answered "can you sell at that price?" with "I can ask the seller", and restated ₹20,000 to every push. No counteroffer was made.

Root causes and fixes (all general, none specific to bicycles):

- **No strategy on intake mandates.** Strategy guidance was loaded per case folder, so a mandate made through the intake chat (its own case ID) fell back to the built-in minimal guidance: no pressure questions, no counteroffer limit, no walk-away. Fix: `cases/default-strategy-guidance.json` carries the strategy document's controls without case amounts (steps halve the distance to the limit, at most three counteroffers, split once, ask before conceding, walk away after the last counteroffer, the pressure questions) and applies to every mandate without its own guidance.
- **A budget below the price was only acknowledged.** The policy treated a stated budget as information, so with no firm offer it never moved. Fix: a stated budget below the current price earns one permitted step toward it (the same steps, limit and counteroffer count; never more than half the room to the limit, never below it, never accepted) with a question asking them to meet the new price. Repeating the same budget earns nothing more.
- **Pressure without a number met a bare restatement.** Once a budget below the minimum was known, the follow-up probe was skipped, so "better rate?" got "The price is X." Fix: ask once how close to the price they can come; "is that your final rate?" is pressure too, held with the same question.
- **"Can you sell at that price?" proposed nothing.** A question with no amount was dropped as an offer. Fix: a question that points back ("at that price", "my budget") is an enquiry at the counterparty's own earlier amount. An enquiry is a probe, so it gets no price step: it gets a nudge for a firm offer (stepping on an enquiry gave away ₹800 in the collect-myself scenario, so that variant was rejected).
- **Reading.** "What price works for you?" is price pressure, not a request for private limits; "Yes please" to an offer of details, before any amount was put to them, is not accepting terms.
- **Checks that blocked good replies.** "find something that works for both of us" read as an agreement claim (now only "That works.", "it works for me", "X works" are); "can you meet the new price?" read as a market claim; the reviewer's "I don't have that confirmed" as an invented fact; and a counter phrased "I can bring it to X" as off-plan. A counter toward a budget no longer fails because the checked fallback did not repeat their budget (that left one turn with no reply at all).
- **502s.** The dev server restarts on every source edit; edits during a test session killed one turn mid-way. The web client now retries a request that hits an unreachable server, and a retried send resumes the same turn by its message ID.
- **Fallbacks never leave a turn silent.** The checked fallback for an enquiry below the minimum failed its own check ("On ₹17,500:" read as stating a sub-minimum amount), so nothing was sent. It now attributes their figure ("You asked about ..."), and if a checked fallback still fails, the failing sentence is dropped and the rest is sent.
- **Reading, continued.** A greeting is never an objection; "Yes, I confirm ₹19,500" after a ₹19,800 counter puts ₹19,500 forward instead of accepting ₹19,800; "Is that your final rate?" is never answered yes or no.

Evals: core 341 and server 126 tests (12 live replays re-recorded, including the new bicycle chat, scenario 34, run on the intake mandate with the default strategy). Live text, three full runs over the 34 scenarios: 33, 32 and 32 passing; the failures move between the long-standing intermittent reading cases (`conditional-truck`, `delivery-only`, `humane-changed-condition`, `pickup-cost`), and every budget and pressure scenario passed in the [final run](../scenarios/agentic-turn/scenario-results.md) (p50 4.6s, p90 6.4s). The six budget scenarios run twice more: no turn without a reply in 24 runs.

## Round 4: code keeps the limits, a plain-text guide shapes the words (2026-11-22)

The user asked why code was deciding what the agent says. Code now enforces only hard limits (amounts, commitments, private content, the exact read-back, invented facts or claims); a draft that breaks one is rewritten once, then replaced by checked wording. How a reply sounds moved to `packages/core/src/negotiation/conversation-guide.md`, plain text placed in the writer's instructions. Style problems (a repeated sentence or opener, a fragment, an unasked question, not acknowledging their figure, not answering the turn, a price they never heard) ask for one rewrite and the rewrite is sent as written: style never forces the robotic fallback. The brief gives the price (current, the original only when a counteroffer lowered it, and whether the last reply said it) separately from the other terms, and the checks that forced the price or their budget into replies are gone, so the price is no longer restated every turn.

New eval: scenario 35, repeated pressure after a counter, with a check that no reply without a new offer restates the amount the previous reply said.

Results: core 352 and server 130 tests (13 live replays re-recorded). Three full live runs on the new design passed 32, 24 and 28 of 35 (the 24 rerun to 8 of 11 passing on its own); the round 3 design passed 32 to 33 of 34. No safety check failed in any run (private amounts, offers below the limit, false agreements, approvals), and no turn went without a reply. The extra failures are wording expectations code used to force (naming their budget, restating the price, an exact walk-away line); they are now the guide's job. Median turn 4.4 to 4.8s, p90 7.7 to 7.9s.

