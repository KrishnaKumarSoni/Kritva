# Epic 10: comparison notes

Three comparison runs of 42 (7 scenarios × 3 runs × 2 systems). All runs use `gpt-5.4-mini` for both sellers and the buyer simulator. All 126 runs completed; none failed. Every number below is re-scored from the stored runs with the final scoring rules (`--rescore`).

| Run | What changed before it | Kritva: valid / no-deal / missed / unresolved / invalid · clean | Plain LLM: valid / no-deal / missed / unresolved / invalid · clean |
| --- | --- | --- | --- |
| [epic-10-run1](../comparison/epic-10-run1/comparison.md) | — | 8 / 6 / 1 / 5 / 1 · 14 | 10 / 6 / 0 / 1 / 4 · 11 |
| [epic-10-run2](../comparison/epic-10-run2/comparison.md) | Kritva: no conditions about the item or its own terms; "please check first" is not acceptance; a conditional question is asked only once | 13 / 6 / 1 / 1 / 0 · 19 | 11 / 6 / 0 / 0 / 4 · 11 |
| [epic-10](../comparison/epic-10/comparison.md) (final) | Kritva: conditions that only mean "if you agree" are ignored | 12 / 6 / 1 / 2 / 0 · 18 | 10 / 6 / 0 / 1 / 4 · 11 |

"Clean" means a valid agreement or an appropriate no-deal, with no violations and nothing flagged for review.

## Final run (`epic-10`)

- **Buyer-visible violations.**
  - Kritva: 0 in 21 runs.
  - Plain LLM: 4 invalid agreements and 4 incorrect agreement records, in 4 runs. In each one it declared the deal agreed while still asking the buyer to confirm ("Agreed at ₹19,000 … Please confirm and we can finalize"). Neither system disclosed the private minimum, offered below it, offered delivery, or invented a product fact.
- **Outcomes.**
  - Kritva: 12 valid agreements, 6 appropriate no-deals (low offer, instruction override), 1 missed deal, 2 unresolved at the six-turn limit.
  - Plain LLM: 10 valid agreements, 6 appropriate no-deals, 1 unresolved.
- **Prices in valid agreements.** Kritva: mostly ₹19,000–₹19,500, with one ₹18,500. Plain LLM: mostly ₹19,000–₹19,500, with one ₹18,000 and one ₹18,500.
- **Cost.**
  - Kritva: about 11.8 seller model calls and 16,000 tokens per run, 4.0s median turn.
  - Plain LLM: about 5.1 calls, 5,000 tokens and 2.0s.
  - Kritva's extra calls are interpretation, composition and the language check. Its gate blocked 48 composed replies before delivery (a diagnostic only); each was replaced by checked template wording.
- **Needs review.** Kritva 1 (a feasible deal the buyer walked away from). Plain LLM 12, mostly sentences such as "I'll check with the seller on ₹14,000", which mention an amount below the minimum without offering it.

## Kritva weaknesses the comparison found

- **Fixed between runs:**
  - Over-eager "conditions" ("if it's in good condition", "if that works") made Kritva stall with odd questions.
  - A buyer saying "please check and let me know" was taken as acceptance.
- **Still open:**
  - **Missed deal (private-limit, run 2).** The buyer said "₹18,500 max" twice. The model recorded it as a budget note, not an offer, so Kritva held at ₹20,000 and asked a garbled budget question ("Of the ₹20,000, how much is available for the item itself, after the price?").
  - **Unresolved runs (private-limit run 1, unknown-details run 2).** Kritva either reached ₹18,500 only on the last turn, or kept promising to check unknown product details without moving.
- **Concession pace.** Kritva rarely concedes on a question alone ("what's your lowest?"). With tight-budget buyers this slows agreement within six turns.

## Scoring corrections made along the way

These were applied to every run before any numbers above, and each has a test in `apps/server/test/eval.test.ts`:
- Refusals written with curly apostrophes ("can’t") or as "isn't accepting" were counted as offers.
- A read-back of "delivery included: No" or "no delivery included" was counted as offering delivery.
- Questions to the buyer, and "checking with the seller about whether a mattress is included", were counted as asserted facts.

## Limits of this evidence

- 21 runs per system, one case, simulated buyers. The results say nothing about real-world conversion, revenue, or whether real buyers stay in an AI conversation.
- The buyer simulator's acceptance flag is the ground truth for "the buyer accepted". Borderline replies can be read differently by a person.
