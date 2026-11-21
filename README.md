# Kritva

Kritva is a reusable AI negotiation capability for apps and assistants. It represents a person or business in conversations where the parties must agree on terms. A host app supplies the case, the user's authority and an existing counterparty. Kritva returns progress, approval requests and the outcome.

## Status

**Epic 1: shared schema and mandate mapping.** Supplied case text becomes a validated, unapproved mandate draft through one reusable core. Negotiation, approvals, the conversation log and interfaces come in later epics.

## Repository layout

```
packages/core/          the reusable core (TypeScript)
  src/schema/           shared schema, deterministic validator, save/load
  src/mapping/          text → draft mapper, shared prompt, model output format
  src/llm/              provider-neutral model contract and the OpenAI adapter
  test/unit/            deterministic tests (no model calls)
  test/live/            tests against the real model
cases/                  case content (listings, instructions, scenarios), kept outside the core
test-results/epic-1/    recorded live results and every mapped draft
```

## Setup

Requires Node 24 (see `.nvmrc`).

```bash
nvm use
```

```bash
npm install
```

Add a `.env` file at the repository root. Git ignores it.

```
OPENAI_API_KEY=...
# Optional overrides
KRITVA_MAPPING_MODEL=gpt-5.5
KRITVA_MAPPING_REASONING_EFFORT=low
KRITVA_MAPPING_TIMEOUT_MS=90000
```

## Commands

```bash
npm test
```

```bash
npm run test:live
```

```bash
npm run typecheck
```

`npm test` runs the deterministic suite. `npm run test:live` maps every scenario in `cases/` with the real model, checks it against the expected results, and rewrites `test-results/epic-1/`.

## Core rules in Epic 1

- **One fixed schema.** It has parties, sources, terms, goals, facts, positions, limits, permissions, conditions and issues. Term names, values, units and conditions are data, so adding a term never changes the schema.
- **Asking price, minimum and authority are separate records.** A position (what a party puts forward), a limit (a boundary the agent must not cross) and a permission (what the principal explicitly allows) never merge.
- **Unknown stays unknown.** No default price, fact or permission is created. Inference can never grant permission: an inferred permission becomes a question for the principal.
- **Every stated item quotes its source exactly.** It is also attributed to the party whose own source says it, so counterparty text can't change the principal's limits or permissions.
- **Disclosure labels come from the host app.** An item is public only if a public source states it.
- **Validation is deterministic and makes no model call.** Only a `ValidatedDraft` can reach other core components. Errors name the field and the reason, never the value.
- **Mapping makes at most two model calls** (one plus one repair). It returns a validated draft or an error, never partial content. Drafts are always `unapproved`.
