# Kritva

Kritva is a reusable AI negotiation capability for apps and assistants. It represents a person or business in conversations where the parties must agree on terms. A host app supplies the case, the user's authority and an existing counterparty. Kritva returns progress, approval requests and the outcome.

## Status

| Epic | What it delivers |
| --- | --- |
| 1. Shared schema and mandate mapping | Supplied case text becomes a validated mandate draft through one reusable core. |
| 2. Shared negotiation record | One validated, append-only, durable event record per session. Text, voice, the console, strategy and evaluations all read it. |
| 2A. Thin end-to-end slice | A buyer chat page, checked replies, an operator event panel, an agreement card, and a seven-scenario script on the same negotiation path. |

Next: deepen the core (Epics 3–8) inside the running slice, then evaluation, the Kritva interface, browser voice and the demo interface.

## Repository layout

```
packages/core/            the reusable core (TypeScript)
  src/schema/             shared schema, deterministic validator, save/load
  src/mapping/            text → draft mapper, shared prompt, model output format
  src/mandate/            mandate confirmation (only confirmed mandates start sessions)
  src/record/             Epic 2: event types, append rules, SQLite storage
  src/negotiation/        Epic 2A: state projection, policy, reply check, turn engine
  src/llm/                provider-neutral model contract and the OpenAI adapter
  scripts/                operator tools (prepare and confirm a mandate)
apps/server/              HTTP API for the slice (Hono); buyer and operator routes
  scripts/run-scenarios.ts  the seven buyer scenarios, through the same routes as the chat page
apps/web/                 buyer chat, seller console and outcome card (React + Vite)
cases/                    case content, kept outside the core
  bed-sale/mandates/      the confirmed demo mandate
  bed-sale/buyer-scenarios/  the seven buyer scenarios
test-results/             recorded evidence per epic
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
KRITVA_TURN_MODEL=gpt-5.4-mini
KRITVA_TURN_REASONING_EFFORT=none
KRITVA_LOCALE=en-IN
```

## Run the chat page

Start the API server (port 8787), then the web app (port 5173), in two terminals:

```bash
npm run dev -w @kritva/server
```

```bash
npm run dev -w @kritva/web
```

Open http://localhost:5173. Type as the buyer on the left. The seller console on the right shows the shared record, and approval requests appear there. The record is stored in `data/kritva.sqlite`, which Git ignores. "New session" starts a fresh session and keeps the old one.

## Commands

```bash
npm test
```

```bash
npm run scenarios
```

```bash
npm run test:live
```

```bash
npm run typecheck
```

- `npm test` runs the deterministic suites. They make no model calls.
- `npm run scenarios` runs the seven buyer scenarios with the real turn model and writes `test-results/epic-2a/`. Add `-- --runs 3` for repeated runs.
- `npm run test:live` re-runs Epic 1 mapping against the real model and writes `test-results/epic-1/`.

To re-map and confirm the demo mandate after editing `cases/bed-sale/sources/demo-instructions.md`:

```bash
node --env-file=.env packages/core/scripts/prepare-mandate.ts bed-sale demo --confirm
```

## Core rules

**Mandates (Epic 1)**
- **One fixed schema.** Term names, values, units and conditions are data, so adding a term never changes the schema.
- **Separate records for separate meanings.** Asking price (a position), minimum (a limit) and authority (a permission) never merge.
- **No guessing.** Unknown stays unknown, and an inferred permission becomes a question for the principal, never authority.
- **Exact sources.** Every stated item quotes its source exactly and is attributed to the party whose own source says it.
- **Confirmation first.** Only a confirmed mandate, with every open issue acknowledged, can start a session.

**The record (Epic 2)**
- **Validated events.** Every event belongs to one session and gets an assigned sequence number. It is validated without a model call before it is saved.
- **Durable writes.** A successful write is on disk, and a failed write saves nothing.
- **Actors come from the route.** The application sets who acted. Conversation text can never become a seller approval.
- **Approvals bind to exact terms.** An approval or agreement binds to an exact terms hash and mandate revision, so changed terms need new confirmation.
- **Delivery counts, not drafts.** An offer counts as communicated only after the channel reports delivery, and an interrupted voice offer does not count.
- **Safe retries and corrections.** Retries never duplicate. Corrections append, and the original stays. Reset starts a new session and keeps the old one.
- **Private stays private.** Counterparty reads include public events only: no mandate, limits, decisions or blocked replies.

**Negotiation turns (Epic 2A)**
- **One path for every surface.** The chat page, the scenario script and, later, voice all call the same engine.
- **Code decides, the model words.** The model only interprets the buyer's message and words the reply, and it never sees private limits. Every offer comes from a deterministic policy that reads the confirmed mandate.
- **Every reply is checked in code before display.** It catches private amounts, amounts outside the plan, offers past the limit, missing offer amounts, claims of agreement or approval, and copied private text. A failing reply is blocked, recorded, and replaced by checked template wording.
- **Agreement needs both sides on the same terms.** Kritva states the complete terms, and the buyer confirms them. If the mandate requires it, the seller approves the same terms hash. Missing approval produces "pending approval", not an agreement.
