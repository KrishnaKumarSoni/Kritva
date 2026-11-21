# Epic 1 live mapping results

- Run at: 2026-11-21T12:45:47.392Z
- Commit: f9589b7 + uncommitted changes
- Model: gpt-5.5
- Prompt: mapping/2
- Result: **16 of 16 passed**

| Scenario | Story | Result | Calls | Repaired | Latency | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| bed-sale/approval-only | 2 | pass | 1 | no | 23.6s |  |
| bed-sale/asking-price-23000 | 3 | pass | 1 | no | 22.2s |  |
| bed-sale/buyer-override | 2 | pass | 1 | no | 40.9s |  |
| bed-sale/conditional-minimum | 2 | pass | 1 | no | 19.4s |  |
| bed-sale/instructions-bullets | 2 | pass | 1 | no | 22.8s |  |
| bed-sale/instructions-key-value | 2 | pass | 1 | no | 21.6s |  |
| bed-sale/instructions-prose | 2 | pass | 1 | no | 25.3s |  |
| bed-sale/listing-only | 2 | pass | 1 | no | 23.5s |  |
| bed-sale/no-age-condition | 3 | pass | 1 | no | 18.7s |  |
| bed-sale/two-minimums | 2 | pass | 1 | no | 47.1s |  |
| logo-design/five-terms | 3 | pass | 1 | no | 19.8s |  |
| isolation/1-bed-sale-listing-only | 2 | pass | 1 | no | 22.0s |  |
| isolation/2-logo-design-five-terms | 3 | pass | 1 | no | 19.2s |  |
| isolation/3-bed-sale-listing-only | 2 | pass | 1 | no | 21.9s |  |

| Cross-scenario check | Story | Result | Detail |
| --- | --- | --- | --- |
| equivalence: bed-seller-instructions | 2 | pass | instructions-bullets = [limit\|principal\|minimum\|money:18000:INR\|private\|conditional:false, permission\|accept_agreement\|requires_approval\|conditional:false, permission\|disclose_information\|prohibited\|conditional:false, position\|principal\|money:20000:INR\|public] / instructions-key-value = [limit\|principal\|minimum\|money:18000:INR\|private\|conditional:false, permission\|accept_agreement\|requires_approval\|conditional:false, permission\|disclose_information\|prohibited\|conditional:false, position\|principal\|money:20000:INR\|public] / instructions-prose = [limit\|principal\|minimum\|money:18000:INR\|private\|conditional:false, permission\|accept_agreement\|requires_approval\|conditional:false, permission\|disclose_information\|prohibited\|conditional:false, position\|principal\|money:20000:INR\|public] |
| isolation: bed before and after logo design | 3 | pass | bed drafts mapped before and after the logo case have the same meaning, and each passes its own forbidden-content checks |

Each scenario's draft (or error) is in `drafts/`. Expected results live in `cases/*/scenarios/*.json`.
