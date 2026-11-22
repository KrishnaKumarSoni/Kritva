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
| 7. Commitments and outcomes | Every offer is versioned with its party, kind (offer, enquiry, interest), conditions and status; blocked offers stay internal; agreement cards with pending obligations; truthful negotiating, paused, pending-approval, agreement and no-agreement outcomes; ending by the buyer, Kritva or the seller. |
| 8. Strategy | Whole-package assessment (hard limits, then stated interests, then stated alternatives); one recorded action per turn (ask, clarify, propose, counter, accept, decline, request approval, pause, end); tactic parameters loaded as data from the strategy document. |
| 9. Text negotiation | The chat says up front that Kritva is an AI acting for the seller; model failures send nothing and resume on retry; buyer corrections and refusals to deal with an AI are recorded; the console shows the last recorded action. |
| 10. Comparison with a plain LLM | The same scenarios, buyer simulator, model and seller instructions run against Kritva and a well-prompted plain LLM seller; rule-based scoring with linked sources; Markdown and CSV reports; regression comparison against an earlier scenario run. |
| 11. Mandate library | The principal describes a negotiation in plain language, reviews what Kritva understood, corrects values directly, and confirms the exact draft shown. Saved mandates and revisions exist before any session; sessions record the revision they used; new revisions apply to open sessions through Epic 4's checks. |
| Humane conversation guide | Replies are warm, short and specific. Kritva introduces itself once as the assistant for the person it represents, responds to what was said, asks one useful question, and varies its wording. See `docs/Kritva_Humane_Negotiation_Instructions_P0.md`. |
| 12. Seller console | One console on the shared record: messages with their channel, offers marked delivered or held back, approvals scoped to the exact offer version and mandate revision, pause and resume, "Change instructions" through the mandate library, and an outcome card with pending payment and pickup. |
| 13. Browser voice | The buyer talks in the browser. Each utterance is transcribed and sent through the same text negotiation path; only recorded, checked replies are spoken. Talking over Kritva stops it and records what was heard; a cut-off read-back never counts as delivered. Phone calls are their own row below. |
| Mandate intake agent | The principal sets up a mandate by chatting with a separate setup agent (OpenAI Agents SDK, text and images). It infers the roles, what the other side may see and what stays private, asks only for what it can't infer (usually the limit, plus the details the other side will ask about), and fills the same mandate input the mapper reads. A progress bar follows what it has gathered; the finished draft appears in the chat with **Make it live**. Mandates are live, paused, closed or deleted from the list. See `packages/core/src/intake/`. |
| 14. Demo listing | A clearly labelled demo bed listing built from the confirmed mandate's public content, with "Call seller" opening one browser voice session beside the seller console. "New demo session" starts fresh with the same saved mandate. |
| Phone calls | A buyer dials a Vobiz number; a Vobiz SIP trunk sends the call to OpenAI's realtime SIP endpoint and Kritva answers with the same realtime voice and call controller as the browser. The server routes the call to a listing or mandate, decides delivery itself from OpenAI's playback events, and records how each call ended. Tested on a live call on 2026-11-22. Setup, design and findings: `docs/Kritva_Phone_Calls.md`. |
| Listing codes and the front desk | One number serves every mandate. Each live mandate has a 4-digit listing code (with a check digit, so a misheard code never reaches another listing), shown on the Mandates page with "Copy for your ad". On a `code` route the agent answers the line, asks for the code in its own words from a plain-text guide, finds the listing, and the call goes on with that mandate as one conversation. See `docs/Kritva_Phone_Calls.md`, section 16. |

Next: deployment on AWS and the final demonstration.

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
  src/commitments/        Epic 7: offer versions and statuses, outcomes, agreement obligations
  src/strategy/           Epic 8: package assessment and the strategy-guidance schema
  src/voice/              Epic 13: speech-to-text and text-to-speech (provider-neutral, OpenAI adapter)
  src/mandate/library.ts  Epic 11: case-level mandates, versions, corrections, confirmations and lifecycle (live, paused, closed, deleted)
  src/intake/             the mandate intake agent (OpenAI Agents SDK): conversation store, agent, and the service that maps and makes mandates live
  src/agent/              the agentic turn: Kritva as an OpenAI Agents SDK agent (read_message, send_reply)
  src/negotiation/        Epic 2A/8: state projection, the strategy chooser, reply check, turn engine
  src/llm/                provider-neutral model contract and the OpenAI adapter
  scripts/                operator tools (prepare and confirm a mandate)
apps/server/              HTTP API for the slice (Hono); buyer and operator routes
  src/library-routes.ts   Epic 11: the mandate library routes and review view, plus lifecycle and delete
  src/intake-routes.ts    the intake chat routes: messages (with images), prepare, make live
  src/eval/               Epic 10: buyer simulator, plain LLM seller, scoring and reports
  src/voice-routes.ts     Epics 13-14: voice turns, reply audio, the demo listing and "Call seller"
  src/realtime-voice.ts   realtime voice: the call controller shared by browser and phone calls
  src/phone/              phone calls: OpenAI webhook, number routing, server-side delivery, hang-up
  scripts/voice-check.ts  Epic 13 timing check through the real audio pipeline (no microphone needed)
  scripts/phone-check.ts  phone setup check: SIP URI, routes, and a signed test webhook
  scripts/vobiz-trunk.ts  shows the Vobiz trunk and turns SRTP on (the console has no switch)
  scripts/run-scenarios.ts  the buyer scenarios, through the same routes as the chat page
apps/web/                 conversation, negotiation console and mandates (React + Vite)
cases/                    case content, kept outside the core
  bed-sale/mandates/      confirmed mandates: the demo one, plus conditional and exception test ones (test data)
  bed-sale/buyer-scenarios/  the buyer scenarios (seven core, plus conditional, exception, pause, Epic 7–8 and live chat regression ones)
  bed-sale/replays/          recorded live chat conversations, replayed by npm test
  bed-sale/strategy-guidance.json  tactic parameters from the seller strategy document (data, not code)
  bed-sale/evaluation.json  known facts and seller permissions used to score the comparison
  <case>/case.json "example"  the example offered in the mandate library
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
# Mandate intake agent (the setup chat on the Mandates page)
KRITVA_INTAKE_MODEL=gpt-5.4-mini
KRITVA_INTAKE_REASONING_EFFORT=low
# Mapping the intake brief; mid-negotiation changes keep KRITVA_MAPPING_REASONING_EFFORT
KRITVA_INTAKE_MAPPING_REASONING_EFFORT=low
KRITVA_DEFAULT_CURRENCY=Indian rupees (₹)
# Case-specific guidance is selected in cases/<case>/case.json. KRITVA_GUIDANCE=none disables it.
# Browser voice (Epic 13)
KRITVA_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
KRITVA_TTS_MODEL=gpt-4o-mini-tts
KRITVA_TTS_VOICE=coral
# Phone calls (docs/Kritva_Phone_Calls.md): on when both of the first two are set
OPENAI_WEBHOOK_SECRET=whsec_...
KRITVA_PHONE_ROUTES=+91XXXXXXXXXX=bed-sale
OPENAI_PROJECT_ID=proj_...
```

The OpenAI Speech API models (`gpt-4o-mini-tts` and others) are scheduled for retirement on 2027-01-06; set `KRITVA_TTS_MODEL` (or move speech output to the Realtime API) before then.

## Run the chat page

Start the API server (port 8787), then the web app (port 5173), in two terminals:

```bash
npm run dev -w @kritva/server
```

```bash
npm run dev -w @kritva/web
```

Open http://localhost:5173. Select **Open console** and enter the key printed at server startup. Set `KRITVA_OPERATOR_KEY` in the server environment if the key should persist across restarts. The record is stored in `data/kritva.sqlite`.

The console has two views. **Negotiation** shows the conversation (you write as the counterparty, in the mandate's own role names) beside the negotiation panel: status with pause and approvals, a price band with your private limit and target, the offer on the table, the counterparty's best offer and stated budget, and the zone where agreement looks possible, then the strategy (last move and why, counteroffers used, the next allowed concession, the discount earned), the terms side by side, what the counterparty said, and the full record behind one disclosure. Pick a mandate and select **New negotiation** to start fresh. **Mandates** is where instructions are written, reviewed and confirmed. Nothing on screen is specific to one case.

`?view=buyer#session=<id>` opens a session as the counterparty sees it: the conversation only, with the AI disclosure and no private data. **Talk by voice** in the composer starts browser voice on the same session. Use `localhost` for development and HTTPS for the deployed demo.

**Mandates** (top bar) opens the mandate library. Select **New** and tell Kritva's setup agent what to negotiate: one sentence, or a picture or screenshot of a listing (attach, paste or drop it). The agent asks only for what it can't work out, usually your limit and the details the other side will want to know. When everything is in place, it maps the brief into a draft (about 10 seconds) and shows a card with what Kritva will use; private items carry a lock. **Make it live** is the only step that gives it authority. To change a live mandate, open it and say what to change; **Apply changes** makes the next revision and applies it to open negotiations. Each mandate's menu pauses, resumes, closes, reopens or deletes it. Pausing or closing also pauses its open negotiations; only live mandates can start new ones. Deleting hides it and keeps the history of negotiations that used it. The demo listing's mandate can be paused but not deleted. "Use for the next negotiation" selects a live mandate; **New negotiation** then starts from its active revision.

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
- `npm run scenarios` runs every buyer scenario with the real turn model and writes `test-results/scenarios/latest/`. It builds the engine and routes from the same case configuration as the running app (listing name, availability, fulfillment wording, per-case strategy guidance). Add `-- --runs 3` for repeated runs, `-- --label epic-4` to keep a named copy, or `-- --baseline epic-7-8` to report what changed since an earlier run. Scenario turns can carry their own expectations (decision, action, offer amount, reply patterns), checked on every run.
- `npm run scenarios -- --save-replays` also stores each scenario marked `"replay": true` in `cases/bed-sale/replays/`: the model responses it received and what each turn delivered and decided. `npm test` replays them without a model and fails if any turn now delivers a different reply, decision or offer. Re-record after an intended change.
- `npm run scenarios -- --compare --label <name>` runs the seven core scenarios three times against Kritva and three times against a plain LLM seller (42 runs), with the buyer simulator, and writes `test-results/comparison/<name>/` (`comparison.md`, `comparison.csv`, `runs.json`, `scores.json`). `--resume` finishes missing runs; `--rescore <name>` rebuilds the report from the stored runs without calling a model.
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
- **Questions come from context.** They are generated from the session in code: one clear thing each, never repeated once answered or refused. Strategy (Epic 8) decides whether to ask.

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
- **Each turn is an agent run.** Kritva runs as an OpenAI Agents SDK agent with the whole conversation as history. It reads the message through the `read_message` tool, whose execution grounds the reading and runs the strategy, gates and record in code, and returns the brief. It writes through `send_reply`, whose execution runs the code checks and the reviewer and returns problems for a rewrite. The model never sets an amount, a term or a commitment. See [docs/Kritva_Agentic_Turn_Design.md](docs/Kritva_Agentic_Turn_Design.md). `KRITVA_AGENT_MODEL` picks the agent's model (default: the turn model); `KRITVA_AGENT_TRACING=1` turns SDK tracing on.
- **Code decides, the model words.** The model only interprets the buyer's message and words the reply, and it never sees private limits. Every offer comes from a deterministic policy that reads the confirmed mandate.
- **Every reply is checked in code before display.** It catches private amounts, amounts outside the plan, offers past the limit, missing offer amounts, claims of agreement or approval, and copied private text. A failing reply is blocked, recorded, and replaced by checked template wording.
- **Agreement needs both sides on the same terms.** Kritva states the complete terms, and the buyer confirms them. If the mandate requires it, the seller approves the same terms hash. Missing approval produces "pending approval", not an agreement.

**Commitments (Epic 7)**
- **Offers come from the record.** Each offer has a party, terms, source message, mandate revision, kind (offer, enquiry, interest) and any conditions the buyer attached. A changed offer is a new version linked to the previous one, and history is kept. Statuses are derived from events, so a replayed event never changes one twice.
- **Internal is not delivered.** An offer the gate blocks is recorded as internal and never counts as the seller's offer. Only delivered offers move the ask.
- **Agreement needs the same current terms.** Acceptance and approval bind to one offer version and mandate revision. Changed terms cancel a pending approval, and the record refuses an agreement for any other terms or after the negotiation ended.
- **The agreement card comes from saved records.** Payment and each agreed logistics term are listed as pending obligations, never as done.
- **Outcomes are truthful.** Negotiating, paused, pending approval, agreement or no agreement. An end records who stopped (buyer, Kritva or seller), why, and what was left open. A no-agreement summary shows each side's last offer and the difference, never a private limit. Nothing reopens an ended session.

**Strategy (Epic 8)**
- **Assess the whole package.** Hard constraints first (a better price never overrides one), then the principal's stated targets and preferences, then a stated alternative. Unknown preferences and alternatives stay unknown, with no invented weights. Assessment is separate from authority: an acceptable package may still need approval.
- **One action per turn, with a reason.** Ask, clarify, propose, counter, accept, decline, request approval, pause or end, recorded with the assessment, the mandate revision and the guidance in use. A strategy failure holds and offers nothing.
- **Guidance is data.** Concession steps, the increment, the counteroffer cap, split-the-difference, pressure questions and the walk-away line come from `strategy-guidance.json`. Guidance never grants authority: every move still passes the gate, and no step goes past a limit.
- **Concessions are paid for.** With `commitmentAllowance` in the guidance, each new buyer commitment earns an approved discount allowance: a firm offer better than their earlier best, or a listed non-price commitment such as a collection day (counted once). Each delivered counteroffer uses it, and no reduction exceeds what is left, so silence, repetition or a worse offer earns nothing. The ledger (what was given, what it earned, what was used, what remains) is projected from the record and saved on each private decision.
- **Targets follow the package.** A target with conditions applies only to a package where those conditions hold, and the most specific applicable target sets the closing point.
- **Ask before conceding.** A non-price reason (a pickup cost, a partner who must agree, a condition like "if I get a truck") gets a question before any price move. A conditional offer stays conditional. Repeated offers earn no reduction. "What's your lowest?" gets the current offer again and a question.
- **Close or stop.** An offer at or above the lower of the current ask and the target closes. After the last counteroffer, or when the buyer stays below an offer already at the limit, Kritva accepts within authority or ends without agreement.

**Text negotiation (Epic 9)**
- **Kritva says what it is.** The buyer chat states, before the first message, that Kritva is an AI negotiating for the seller and is not the seller or a person.
- **A failure sends nothing.** If the model cannot read a message, the failure is recorded for the operator, the session state is unchanged, the buyer sees a neutral error, and retrying the same message resumes that turn. No reply, offer or agreement is made up.
- **Corrections and refusals are recorded.** "Sorry, I meant X" marks the earlier offer as corrected, so it is never the current offer or part of the offer history. "I don't want to speak to an AI" ends the negotiation without agreement, as the buyer's decision.
- **The console shows the last recorded action**, with its reason, next to the current offer and status.

**Comparison with a plain LLM (Epic 10)**
- **Fair by construction.** Both sellers use the same base model, the same confirmed seller instructions and listing, the same buyer simulator with the same hidden goals, the same buyer-turn limit and the same seller approval policy. The buyer's hidden goals never reach either seller. Each run gets a fresh, isolated record.
- **Counted by rules, not judged by a model.** Private-limit disclosures, unauthorized offers the buyer saw, invalid agreements, invented facts and incorrect agreement records are counted by the same deterministic rules for both systems (`apps/server/src/eval/score.ts`). Moves blocked before delivery are a separate diagnostic. Anything a rule cannot decide is flagged for review, not counted.
- **Traceable.** Every violation names the message ID (the record event for Kritva) and the mandate rule. Failed runs stay in the report. Re-scoring stored runs gives the same counts.
- **No overclaiming.** The report states the sample size and that simulated buyers say nothing about real-world conversion or revenue.

**Mandate library (Epic 11)**
- **Plain language in, the shared schema out.** Public facts and private instructions are separate sources, mapped by the Epic 1 mapper. Unknown values stay unknown.
- **The principal corrects, and corrections are the principal's.** A direct edit to a value, permission or item is a new draft version with its own quoted source, validated again. The old text is never re-mapped over it.
- **Only the principal confirms, and only what was reviewed.** Confirmation names the exact draft version and content hash. Conflicts and unresolved permissions block it; other open questions must be marked as reviewed. A buyer message can never confirm a mandate.
- **Saved before any session.** Case-level mandates and their revisions are stored on their own (append-only), survive restarts, and keep every earlier version. A session records the saved revision it started from. A new revision applies to open sessions through Epic 4's revision path, which rechecks pending offers and approvals without rewriting earlier offers or agreements.

**Humane conversation (guide)**
- **Wording, never permission.** The guide shapes how an approved move is said. Every number, condition and promise still comes from the strategy and passes the outgoing checks.
- **Introduce once.** The model introduces Kritva as the principal's assistant and uses the principal's public name when the listing provides it.
- **Sound like a person.** Composed replies respond to the last message, ask one question at most, and avoid scripted openers. A reply that opens like the previous one is replaced by a checked variant.
- **No internal words, no dashes.** Replies with internal vocabulary ("mandate", "principal", "governance") or field names are blocked, and every em or en dash is removed before sending.
- **Read-backs stay exact.** Complete-terms and agreement read-backs are built from the checked terms, in natural phrasing.

**Seller console (Epic 12)**
- **One record, one console.** Everything shown comes from the shared record and the commitments model; nothing is kept separately. Seller offers show whether they were delivered or held back.
- **Approvals are scoped.** Approve and Reject carry the exact offer version and mandate revision shown; a decision for anything else is refused, and a repeat creates no second permission.
- **One mandate editor.** "Change instructions" pauses the negotiation and opens the saved mandate in the library; nothing changes until a new revision is confirmed, and pending offers are then rechecked.

**Browser voice (Epic 13)**
- **A channel, not a second agent.** An utterance is transcribed, then handled exactly like a typed message (channel "voice"). Only messages the engine recorded can be turned into audio. Credentials stay on the server.
- **Heard means delivered.** A reply counts as delivered when its audio finishes. Talking over it stops playback and records the part that was heard; an interrupted offer or read-back cannot be accepted. A dropped call never counts as acceptance.
- **Failures say so.** A failed transcription sends nothing and records nothing; the buyer is asked to say it again.

**Demo listing (Epic 14)**
- **Public content only**, from the confirmed mandate the listing resolves to, labelled as a demo, not an official marketplace page.
- **"Call seller" never guesses.** It needs a confirmed saved mandate; otherwise it shows a setup error and starts nothing. A double click returns the same session.
