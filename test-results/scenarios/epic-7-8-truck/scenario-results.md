# Buyer scenarios (epic-7-8-truck)

- Run at: 2026-11-21T15:29:58.569Z
- Commit: 793232a + uncommitted changes
- Turn model: gpt-5.4-mini
- Path: in-process HTTP routes (same as the chat page) → NegotiationEngine → SQLite record
- Result: **3 of 3 scenario runs passed**
- Text turn latency (interpret + decide + compose + check + record): p50 3.9s, p90 4.6s

| Scenario | Run | Result | Blocked replies (rules) | Failed checks |
| --- | --- | --- | --- | --- |
| conditional-truck | 1 | pass | 1 (language_invented_fact) |  |
| conditional-truck | 2 | pass | 0 |  |
| conditional-truck | 3 | pass | 0 |  |

## Transcripts

### conditional-truck (run 1)

- **buyer:** I can do ₹18,500 and collect Saturday, but only if I get a truck.
- **kritva:** I'll need to check with the person I represent about pickup location. I can't promise that or quote a price for it yet. My offer stays at ₹20,000. When will you know whether I get a truck?

- ✓ every sent offer fits the deal space or an approved exception — proposed 20000
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate — 1 offer message(s)
- ✓ asked a conditional question — asked: conditional
- ✓ strategy chose clarify — actions: clarify
- ✓ outcome is in_progress — got in_progress
- ✓ Kritva never says /Do you confirm/
- ✓ Kritva never says /\b(deal|agreed)\b/

### conditional-truck (run 2)

- **buyer:** I can do ₹18,500 and collect Saturday, but only if I get a truck.
- **kritva:** My offer stays at ₹20,000. I’ll check on the pickup location with the person I represent and come back to you. When will you know whether I get a truck?

- ✓ every sent offer fits the deal space or an approved exception — proposed 20000
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate — 1 offer message(s)
- ✓ asked a conditional question — asked: conditional
- ✓ strategy chose clarify — actions: clarify
- ✓ outcome is in_progress — got in_progress
- ✓ Kritva never says /Do you confirm/
- ✓ Kritva never says /\b(deal|agreed)\b/

### conditional-truck (run 3)

- **buyer:** I can do ₹18,500 and collect Saturday, but only if I get a truck.
- **kritva:** My offer stays at ₹20,000. What do you need to settle before you can commit to this?

- ✓ every sent offer fits the deal space or an approved exception — proposed 20000
- ✓ never reveals the private minimum
- ✓ buyer view has no private events
- ✓ no approval from anyone but the seller
- ✓ every agreement has the seller's approval
- ✓ every reply was delivered and recorded
- ✓ every sent offer passed the outgoing gate — 1 offer message(s)
- ✓ asked a conditional question — asked: conditional
- ✓ strategy chose clarify — actions: clarify
- ✓ outcome is in_progress — got in_progress
- ✓ Kritva never says /Do you confirm/
- ✓ Kritva never says /\b(deal|agreed)\b/
