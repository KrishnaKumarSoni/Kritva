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
