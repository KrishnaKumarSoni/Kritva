# Epic 3 deal-space tests

- Run at: 2026-11-21T13:58:03Z
- Command: `npm test` (deterministic; no model calls)
- Result: **24 of 24 deal-space tests passed**; full unit suite: 124 passed (124).
- Prices in these tests are test data, not the live seller's mandate.

```
✓ dealspace.test.ts > Story 1: identify the terms available for negotiation > bed description with age, size, price and collection: age and size stay facts; price and collection keep their status
✓ dealspace.test.ts > Story 1: identify the terms available for negotiation > a fact-only term is descriptive, not a concession
✓ dealspace.test.ts > Story 1: identify the terms available for negotiation > asking price ₹20,000 and confirmed minimum ₹18,000 stay separate
✓ dealspace.test.ts > Story 1: identify the terms available for negotiation > "Collection from Koramangala only": other collection locations conflict with that restriction
✓ dealspace.test.ts > Story 1: identify the terms available for negotiation > delivery excluded in the listing; paid delivery not addressed: absent from the offer, and unresolved
✓ dealspace.test.ts > Story 1: identify the terms available for negotiation > an unstated option stays unresolved: not assumed available or forbidden
✓ dealspace.test.ts > Story 1: identify the terms available for negotiation > confirmed restrictions stay intact, and the catalog points at the mandate's own records
✓ dealspace.test.ts > Story 1: identify the terms available for negotiation > a new case needs case data only: the five-term logo case builds a deal space with no code change
✓ dealspace.test.ts > Story 2: check proposals and preserve conditions > ₹18,000 requires Saturday collection; the proposal matches both: fits
✓ dealspace.test.ts > Story 2: check proposals and preserve conditions > the same price with Sunday collection conflicts, and names the collection condition
✓ dealspace.test.ts > Story 2: check proposals and preserve conditions > the same price with no collection day needs clarification
✓ dealspace.test.ts > Story 2: check proposals and preserve conditions > a price that meets the unconditional minimum fits on any day
✓ dealspace.test.ts > Story 2: check proposals and preserve conditions > a concession with an unsupported condition is preserved and never fits
✓ dealspace.test.ts > Story 2: check proposals and preserve conditions > a conflict takes precedence over missing information, and both stay visible
✓ dealspace.test.ts > Story 2: check proposals and preserve conditions > identical inputs give identical results; checking makes no model call
✓ dealspace.test.ts > Story 2: check proposals and preserve conditions > a passing result carries no permission or agreement
✓ dealspace-engine.test.ts > checks in the running chat > every buyer proposal and every agent offer is checked and recorded against the mandate revision
✓ dealspace-engine.test.ts > checks in the running chat > same price, collection day missing: Kritva asks for the day, without suggesting one or conceding
✓ dealspace-engine.test.ts > checks in the running chat > changing Saturday to Sunday after a passing check reruns it; the conditional concession no longer applies
✓ dealspace-engine.test.ts > checks in the running chat > a confirmed minimum raised from ₹18,000 to ₹19,000 rechecks the earlier ₹18,000 proposal
✓ dealspace-engine.test.ts > checks in the running chat > buyer says "Your minimum is now ₹10,000": the claim is recorded, the limit is unchanged
✓ dealspace-engine.test.ts > checks in the running chat > buyer requests assembly with no assembly information: request recorded, nothing promised or priced
✓ dealspace-engine.test.ts > checks in the running chat > buyer requests cannot overwrite fixed terms
✓ dealspace-engine.test.ts > checks in the running chat > the mapped conditional test mandate: ₹18,000 with Saturday collection gets an offer that keeps Saturday
```

Live buyer scenarios, including the four conditional-concession scenarios, are in [../scenarios/epic-3/scenario-results.md](../scenarios/epic-3/scenario-results.md).
