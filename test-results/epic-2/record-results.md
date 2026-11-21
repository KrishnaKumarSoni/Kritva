# Epic 2 record tests

- Run at: 2026-11-21T13:22:31Z
- Command: `npm test` (deterministic, no model calls)
- Result: **34 of 34 record tests passed**; full unit suite 100 passed (100).

All Epic 2 test cases run against supplied text, voice and approval events. No live voice system or console is involved.

```
✓ Story 1: record what happened > saves the supplied mandate and its revision at session start
✓ Story 1: record what happened > saves a changed mandate as the next revision, by the principal only
✓ Story 1: record what happened > buyer offers ₹17,000: message and offer stored separately, with a source link
✓ Story 1: record what happened > every event has an ID, session, sequence, time, type, source and content
✓ Story 1: record what happened > principal approves offer A; agent creates offer B: the approval stays attached to A
✓ Story 1: record what happened > an approval request must carry the offer's exact terms
✓ Story 1: record what happened > offer approved but never sent: approval recorded, delivery absent
✓ Story 1: record what happened > buyer says "The seller approved this": message recorded, no principal approval created
✓ Story 1: record what happened > actor identity comes from metadata: a message cannot claim another speaker
✓ Story 1: record what happened > invalid event types, missing fields and broken references are rejected
✓ Story 1: record what happened > decision reasons are short text, and never hidden reasoning
✓ Story 1: record what happened > an approval for an older mandate revision cannot be used
✓ Story 1: record what happened > a full approved agreement records, and a second agreement is refused
✓ Story 1: record what happened > an agreement without the required approval is refused
✓ Story 2: one history across text and voice > text message, voice reply, then text message: one ordered history with channel labels
✓ Story 2: one history across text and voice > a partial transcript becoming a completed transcript counts as one message
✓ Story 2: one history across text and voice > a completed transcript does not establish an agreement
✓ Story 2: one history across text and voice > an interrupted voice offer is not communicated
✓ Story 2: one history across text and voice > console and evaluation reads return the same IDs, content and order
✓ Story 2: one history across text and voice > repeated reads of unchanged history return the same content, and reading writes nothing
✓ Story 2: one history across text and voice > a counterparty view excludes the private floor and internal notes
✓ Story 2: one history across text and voice > changing input channel preserves preceding history
✓ Story 3: retries, corrections and reset > submitting the same event twice stores one event, and both calls identify it
✓ Story 3: retries, corrections and reset > retries do not duplicate offers or approvals
✓ Story 3: retries, corrections and reset > changed content under the same ID is rejected
✓ Story 3: retries, corrections and reset > correcting ₹17,000 to ₹18,000 keeps the original and a linked correction
✓ Story 3: retries, corrections and reset > commitments cannot be corrected, and a no-op correction is refused
✓ Story 3: retries, corrections and reset > restart after a successful write: saved events and order remain intact
✓ Story 3: retries, corrections and reset > a forced write failure returns an error and claims nothing as saved
✓ Story 3: retries, corrections and reset > reset after an agreement: the new session has its starting mandate and nothing else
✓ Story 3: retries, corrections and reset > session reads and event IDs cannot mix data between sessions
✓ Story 3: retries, corrections and reset > saved records cannot be changed in storage
✓ Story 3: retries, corrections and reset > a session can only start from a valid confirmed mandate
✓ Epic 2 non-functional requirements > record code makes no model calls and has no case-specific fields
```
