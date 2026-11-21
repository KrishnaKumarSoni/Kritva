# Kritva

Kritva is a reusable AI negotiation capability for apps and assistants. It represents a person or business in conversations where the parties must agree on terms. A host app supplies the case, the user's authority and an existing counterparty. Kritva returns progress, approval requests and the outcome.

## Status

| Epic | What it delivers |
| --- | --- |
| 1. Shared schema and mandate mapping | Supplied case text becomes a validated mandate draft through one reusable core. |
| 2. Shared negotiation record | One validated, append-only, durable event record per session. Text, voice, the console, strategy and evaluations all read it. |
| 2A. Thin end-to-end slice | A buyer chat page, checked replies, an operator event panel, an agreement card, and a seven-scenario script on the same negotiation path. |
| 3. Deal space | Terms classified from the confirmed mandate. Every proposal is checked deterministically, linked conditions included, and the running chat uses the checks. |
| 4. Principal | Goals, needs, targets, preferences and alternatives kept distinct; permissions and limit exceptions read in code; changed instructions become drafts that only the principal can confirm. |
| 5. Counterparty | Buyer needs, constraints, claims and stated authority kept as quoted claims; limit estimates only with a stated basis; questions prepared from session context. |
| 6. Governance | Every outgoing action passes a two-phase gate (terms, then wording) against the active mandate; privacy and unsupported-claim checks; scoped exception approvals; pause. |

Next: deepen the core (Epics 7–8) inside the running slice, then evaluation, the Kritva interface, browser voice and the demo interface. Strategy belongs to Epics 4, 5, 6 and 8, so the slice's policy stays minimal until then.

## Repository layout

```
packages/core/            the reusable core (TypeScript)
  src/schema/             shared schema, deterministic validator, save/load
  src/mapping/            text → draft mapper, shared prompt, model output format
  src/mandate/            mandate confirmation (only confirmed mandates start sessions)
  src/record/             Epic 2: event types, append rules, SQLite storage
  src/dealspace/          Epic 3: term catalog and the deterministic proposal checker
  src/governance/         Epic 4/6: authority, the outgoing gate, claim checks, model language check
  src/counterparty/       Epic 5: buyer context projection and question preparation
  src/mandate/            confirmation and mid-session revisions (drafts)
  src/negotiation/        Epic 2A: state projection, policy, reply check, turn engine
  src/llm/                provider-neutral model contract and the OpenAI adapter
  scripts/                operator tools (prepare and confirm a mandate)
apps/server/              HTTP API for the slice (Hono); buyer and operator routes
  scripts/run-scenarios.ts  the seven buyer scenarios, through the same routes as the chat page
apps/web/                 buyer chat, seller console and outcome card (React + Vite)
cases/                    case content, kept outside the core
  bed-sale/mandates/      confirmed mandates: the demo one, plus conditional and exception test ones (test data)
  bed-sale/buyer-scenarios/  the buyer scenarios (seven core, plus four conditional-concession ones)
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
- `npm run scenarios` runs every buyer scenario with the real turn model and writes `test-results/scenarios/latest/`. Add `-- --runs 3` for repeated runs, or `-- --label epic-4` to keep a named copy.
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

**Deal space (Epic 3)**
- **Terms are classified, not assumed.** Each term is a negotiable range, options, fixed, restricted, stated by the principal, a condition detail, a description, or unresolved. Facts like age and size are never concessions. An asking price is never a minimum.
- **Proposals are checked in code.** The result is **fits known constraints**, **conflicts** or **needs clarification**, with each finding naming its term and source rule. The same inputs always give the same result, with no model call.
- **Linked conditions travel together.** A concession such as "₹18,000 only with Saturday collection" fits only when the same proposal holds the condition. A missing day means clarification, a different day means conflict, and an unsupported condition is kept and never passes. Offers and replies must name the condition they depend on.
- **Checks bind to exact terms and the mandate revision.** A changed proposal or a revised mandate is checked again, and an earlier pass is never reused.
- **Buyer requests stay the buyer's.** New terms (for example assembly) are recorded as requests, never promised or priced, and never written into the mandate.
- **A pass is not permission.** Authority and agreement still follow the mandate's permissions and the seller's approval.

**Principal (Epic 4)**
- **Separate records for separate meanings.** Asking price, target and walk-away limit are separate records. A preference never becomes a fixed condition. Needs never imply deadlines. Alternatives are only what the principal states, and an absent one stays unknown.
- **Authority is read in code.** Negotiating never implies accepting, and a missing permission is no permission.
- **Each limit says whether an exception may be requested.** Unspecified means no.
- **Conflicts block the affected actions.** Conflicting rules leave those actions unresolved until the principal clarifies them.
- **Changed instructions are mapped into a draft by the same Epic 1 mapper.**
  - A draft has no authority. Only the principal's control confirms it, and a stale draft cannot be confirmed.
  - Confirming creates the next revision and re-checks pending proposals.
  - Pending approvals are re-requested under the new revision.
  - Agreements stay in history.

**Counterparty (Epic 5)**
- **Buyer statements stay claims.** Needs, constraints, reasons, preferences, authority, claims, budgets and "final" statements each quote the buyer's exact words, keep the agent's reading separate, and stay in this session only.
- **Offers keep their package.** Amounts with different terms are never compared.
- **Estimates need a basis.** A limit estimate exists only with a stated basis and assumptions. An offer is willingness, not a maximum, and contradictions stay visible.
- **Questions come from context.** They are generated from the session in code: one clear thing each, never repeated once answered or refused. Strategy (Epic 8) decides whether to ask; the slice only asks at most one, while holding.

**Governance (Epic 6)**
- **Every outgoing action passes two gate phases.**
  - Terms: deal space, authority, exception paths and approvals, under the active revision.
  - Wording: amount checks, plus code rules against naming a limit, invented competition, deadlines, market claims and promises outside the terms. A model language check runs on composed text.
- **Results and fallbacks.** The gate returns allow, block, needs approval or needs clarification, recorded with rule and reason. A failing reply falls back to checked template wording.
- **Read-backs come from the checked fields.** Complete-terms and agreement read-backs are built from the checked terms, never written by the model.
- **Authority is re-read just before sending.** If the mandate changed mid-turn, the action is planned again. Pause stops negotiation replies.
- **Exceptions are scoped.** An exception is requested only where the limit allows it, offered only after approval, and covers those exact terms, that revision and that session once. The standing limit is unchanged.
  - A rejected exception is not asked again for the same terms.
  - The buyer can never create an approval.

**Negotiation turns (Epic 2A)**
- **One path for every surface.** The chat page, the scenario script and, later, voice all call the same engine.
- **Code decides, the model words.** The model only interprets the buyer's message and words the reply, and it never sees private limits. Every offer comes from a deterministic policy that reads the confirmed mandate.
- **Every reply is checked in code before display.** It catches private amounts, amounts outside the plan, offers past the limit, missing offer amounts, claims of agreement or approval, and copied private text. A failing reply is blocked, recorded, and replaced by checked template wording.
- **Agreement needs both sides on the same terms.** Kritva states the complete terms, and the buyer confirms them. If the mandate requires it, the seller approves the same terms hash. Missing approval produces "pending approval", not an agreement.
