# Cases

Each folder holds one negotiation case as plain input data. Core code and shared prompts never contain case content. To change a case, edit these files, not the core.

```
<case>/
  case.json        parties, and the catalogue of sources with author and disclosure labels
  sources/*.md     the text the application would supply (listings, instructions, messages)
  scenarios/*.json which sources one test run uses, and the expected results
```

- `authorPartyId` and `disclosure` on each source are set by the host application, not the model. Content attributed to a party can only come from that party's sources.
- `disclosure: "private"` marks content the agent may use but must never reveal. Governance enforces it in a later epic.
- A scenario's `expect` block is checked by `packages/core/test/support/expectations.ts`:
  - `require`: each matcher must match at least one record.
  - `requireAny`: at least one group must fully match.
  - `forbid`: no record may match.
  - `notSingle`: the matcher must match zero records, or two or more (never exactly one).
  - `forbidText`: whole words that must not appear in any record's text (issue messages excluded).
  - `minTerms`: the minimum number of terms.
- Scenarios that share an `equivalenceGroup` must produce the same meaning (positions, limits, permissions).

| Case | Principal | Purpose |
| --- | --- | --- |
| `bed-sale` | seller | The live demonstration case |
| `logo-design` | buyer | A second case that shows reuse: five terms, and a principal who is buying, not selling |
