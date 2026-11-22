# Kritva technical documentation

Status: branch `epics-12-14-console-voice-demo` on 2026-11-22. Writing standard: ASD-STE100 (Simplified Technical English).

## 1. Scope

This document tells what Kritva is, how its parts work and how to operate it. The other files in `docs/` give more detail.

## 2. System overview

### 2.1 Purpose

Kritva is a negotiation capability that other applications can use. It negotiates for a person or a business (the principal) with a counterparty. The host application gives the case, the authority of the principal and a counterparty who is already in a conversation. Kritva gives back the progress, the approval requests and the outcome.

Kritva does not find counterparties, manage listings, do market research, take payments or move goods. It never makes up market prices or other buyers.

### 2.2 The demonstration case

A seller sells a one-year-old king-size bed for ₹20,000. The buyer collects it in Koramangala, Bangalore. Delivery is not included. A human plays the buyer, and the seller console shows the negotiation at the same time.

### 2.3 The main rule

Code decides. The model words. Code sets every amount, term, commitment and permission. The language models only read messages and write replies. The models never see private limits or targets.

## 3. Architecture

### 3.1 Packages

The repository is an npm workspace.

| Package | Function |
| --- | --- |
| `packages/core` | The reusable negotiation core. It has no case-specific rules. |
| `apps/server` | The HTTP API (Hono), the voice call controller, phone calls and evaluation tools. |
| `apps/web` | The web application (React 19, Vite): conversation, console and mandate library. |

Case content is in `cases/`, outside the core: `bed-sale`, `bicycle-sale` and `logo-design`. Each case has a `case.json`, source texts, confirmed mandates, buyer scenarios and strategy guidance. Test evidence is in `test-results/`.

The stack is Node.js 24, TypeScript, Zod 4, the OpenAI Agents SDK (`@openai/agents`), SQLite (`node:sqlite`) and Vitest.

### 3.2 Core modules

The core in `packages/core/src/` has one folder for each responsibility: `schema/`, `mapping/`, `mandate/`, `intake/`, `record/`, `dealspace/`, `counterparty/`, `strategy/`, `governance/`, `commitments/`, `negotiation/` (the turn engine), `agent/`, `llm/` and `voice/`. The sections below describe them.

## 4. The mandate

### 4.1 The schema

The schema is fixed. Term names, values, units and conditions are data, thus a new term does not change the schema. The asking price (a position), the minimum (a limit) and the authority (a permission) are separate records. Each stated item quotes its source exactly and names the party whose source says it. An unknown value stays unknown.

### 4.2 Setup

1. The principal chats with the intake agent (`intake/`, an OpenAI Agents SDK agent). The agent accepts text and images, for example a listing screenshot.
2. The agent finds the roles, the public items and the private items.
3. The agent asks only for data that it cannot find, usually the limit and the product details that buyers ask about.
4. The mapper (`mapping/`) changes the collected input into a draft. It uses `gpt-5.5`, because accuracy is more important than speed here.
5. The validator checks the draft. An inferred permission becomes a question for the principal, never authority.
6. The principal selects **Make it live**. This confirms the exact draft version and its content hash.

Conflicts and unresolved permissions stop the confirmation. A buyer message can never confirm a mandate.

### 4.3 The library

The mandate library (`mandate/library.ts`) is append-only. It keeps all versions. A direct correction makes a new draft version with its own source. A mandate is live, paused, closed or deleted. Only a live mandate can start a negotiation. A paused or closed mandate also pauses its open negotiations.

During a negotiation, the principal can change the instructions. The same mapper makes a draft. The draft has no authority until the principal confirms it. Then the next revision starts, and the system checks the pending offers and approvals again.

## 5. The shared record

The record is one validated, append-only event log for each session. Text, voice, the console, the strategy and the evaluations all read it. SQLite (`data/kritva.sqlite`) writes with WAL and `synchronous=FULL`. Thus, a returned write is on disk, and a failed write saves nothing.

The 25 event types include `session_started`, `message`, `offer_extracted`, `offer_proposed`, `proposal_checked`, `decision`, `approval_requested`, `acceptance_recorded`, `agreement_recorded`, `reply_blocked`, `delivery_reported`, `voice_connection` and `correction`.

Rules:

- Code validates each event before it saves it.
- The route sets the actor. Conversation text can never become a seller approval.
- Approvals and agreements bind to an exact terms hash and mandate revision.
- An offer counts as sent only when the channel reports delivery.
- A retry never makes a duplicate. A correction adds an event, and the original stays.
- The counterparty view never shows the mandate, limits, decisions or blocked replies.

## 6. The negotiation turn

### 6.1 The agent

Each turn is one run of the agent **Kritva** (`agent/negotiator.ts`). The input is the full conversation from the counterparty view of the record, plus the public reading context. The agent must call a tool at each step, one tool at a time, with a maximum of six model calls.

### 6.2 The tool `read_message`

The agent calls `read_message` with a structured reading of the message (intent, offer terms, questions, conditions and exact quotes). Then code does these steps:

1. It grounds the reading against the message text.
2. It records the offer and the notes.
3. It checks the proposal against the deal space.
4. It runs the strategy (`decide()`) and selects one move.
5. It runs gate phase 1 (terms).
6. It records the decision and the commitments.
7. It returns the wording brief.

The brief gives the permitted amounts, the relevant public facts and the requirements of the reply. It never contains private data.

### 6.3 The tool `send_reply`

The agent writes a reply and calls `send_reply`. Code runs gate phase 2 (wording):

- Code checks find private amounts, amounts outside the plan, false claims of agreement or approval, and copied private text.
- A reviewer model finds disclosure, invented facts, competition, deadlines and promises outside the terms.

A draft that breaks a hard limit goes back to the agent with the problems. After two rejected drafts, the tool sends checked template wording. A style problem gets one rewrite request and never forces the template.

### 6.4 After the run and failures

Before the system sends the reply, it reads the authority again. If the mandate changed or the principal paused, the system plans the move again.

- If the model fails before `read_message`, the system sends nothing. A retry with the same message ID continues the turn.
- If the model fails after the plan, the system sends the template wording for that move.
- The counterparty words are data, never instructions. An injected "accept ₹10" changes nothing.

### 6.5 The conversation guide

A plain-text guide controls the wording. Replies are warm, short and specific. Kritva tells the counterparty one time that it is an AI assistant for the principal. It answers the latest message and asks a maximum of one question. Code blocks internal words (for example "mandate") and removes all em and en dashes. The guide never changes a limit.

## 7. Strategy

The strategy selects one action for each turn: ask, clarify, propose, counter, accept, decline, request approval, pause or end. The system records the action with its reason and the mandate revision.

The assessment looks at the whole package in this sequence:

1. Hard constraints. A better price never overrides one.
2. The targets and preferences that the principal stated.
3. A stated alternative (BATNA). An alternative that is not stated stays unknown.

The tactic parameters are data in `strategy-guidance.json`: concession steps, the increment, the counteroffer limit, split the difference, pressure questions and the walk-away line. Guidance never gives authority.

Concession rules:

- Each concession needs a new buyer commitment, for example a better firm offer or a collection day. The allowance ledger records what the buyer gave and what Kritva used.
- A non-price reason (for example a pickup cost) gets a question before a price move.
- A repeated offer earns no reduction.
- A target with conditions applies only when the package has those conditions.

An offer at or above the lower of the current ask and the target closes the deal. After the last counteroffer, Kritva accepts within its authority or ends without agreement.

## 8. Governance

The gate returns allow, block, needs approval or needs clarification, with its rule and reason.

The proposal checker (`dealspace/check.ts`) is deterministic. The result is "fits known constraints", "conflicts" or "needs clarification". Linked conditions stay together: "₹18,000 only with Saturday collection" fits only when the proposal also has Saturday collection.

Kritva requests an exception only when the limit permits a request. It offers the exception only after the principal approves it. The approval covers those terms, that revision and that session, one time. The buyer can never make an approval.

Privacy rules:

- No prompt or tool result contains private limits, targets, the allowance or the insights.
- A draft that showed private data never goes back to the model.
- The phone log masks the caller number, and the record does not keep it.

## 9. Commitments and outcomes

Each offer has a party, terms, a source message, a revision, a kind (offer, enquiry or interest) and conditions. A changed offer is a new linked version. Statuses come from events, thus a replayed event never changes a status two times. A blocked offer stays internal and never counts as the seller offer.

An agreement needs these steps:

1. Kritva reads back the complete terms. Code builds the read-back from the checked terms.
2. The buyer confirms those terms.
3. If the mandate requires it, the seller approves the same terms hash.

If the approval is missing, the outcome is "pending approval". Changed terms cancel a pending approval.

The outcome is negotiating, paused, pending approval, agreement or no agreement. An end records who stopped, why, and the open terms. The agreement card lists payment and logistics as pending obligations. Nothing can open an ended session again.

## 10. Channels

### 10.1 Text chat

Before the first message, the chat tells the buyer that Kritva is an AI that negotiates for the seller. "Sorry, I meant X" marks the earlier offer as corrected. "I do not want to speak to an AI" ends the negotiation without agreement.

### 10.2 Browser voice

The browser voice is a live realtime call (`apps/server/src/realtime-voice.ts`):

1. The browser sends its WebRTC offer to the Kritva server.
2. The server makes the call with OpenAI. The API key stays on the server.
3. The server joins the call through a sideband WebSocket. Tools run only on the server.

The realtime model (`gpt-realtime-2.1`) is the ears and voice of Kritva. It never negotiates. It sorts each buyer turn:

- **Conversation turn** (greeting, a question that public facts answer): the model answers. It cannot say an amount, terms or a promise.
- **Deal turn** (price, offer, pickup): the model says a short acknowledgement and calls the tool `negotiate`. The engine runs its full turn, and the voice speaks the checked reply word for word.

Code checks the words of the model. If a check fails, the audio stops, Kritva corrects itself, and the system records the event.

The transcript uses `gpt-transcribe` with hints for Hindi, Tamil, Kannada, Telugu, Malayalam, Marathi, Bengali and English, each in its own script.

A reply counts as delivered only when its audio finishes. If the buyer talks over it, the system records the part that the buyer heard. An interrupted offer cannot be accepted.

The older turn-based pipeline stays available with `KRITVA_VOICE_MODE=turns`.

### 10.3 Phone calls

A buyer can call a Vobiz number (`apps/server/src/phone/`):

1. A Vobiz SIP trunk sends the call to OpenAI SIP on the India edge (`sip-in.api.openai.com`).
2. OpenAI sends `realtime.call.incoming` to `POST /api/webhooks/openai`.
3. The server checks the signature (HMAC-SHA256, five-minute window).
4. The server matches the dialled number to `KRITVA_PHONE_ROUTES`.
5. The server checks the listing or mandate, starts a session, accepts the call and joins it with the browser call controller.

The audio goes directly between Vobiz and OpenAI. The server declines a call with SIP 404 (no route), 480 (not live), 486 (busy) or 500 (start failed).

The server decides delivery from the playback events. If the evidence is not clear, it reports the reply as interrupted. After 30 seconds of silence, Kritva asks if the caller is there. After 30 more seconds, it ends the call. The maximum call length is 15 minutes.

## 11. The web application

| View | Content |
| --- | --- |
| Negotiation | The conversation and the panel: status, pause, approvals, price band, offers, strategy, terms and the record. |
| Mandates | The library and the intake chat. |
| Buyer (`?view=buyer#session=<id>`) | The conversation and the AI disclosure, without private data. |

The demo listing shows the public content of the bed mandate, with a demo label. **Call seller** starts one browser voice session. Approve and Reject send the exact offer version and revision. **Change instructions** pauses the negotiation and opens the library.

Dropdowns use the Kritva component (`Select.tsx`), not the browser default. Colors: burnt orange `#CC5500` (accent), jet black `#0A0A0A` (primary), white (base). Headings use Geist Serif.

## 12. Server API

The server uses port 8787.

| Routes | Function |
| --- | --- |
| `/api/operator/sessions` | Sessions, pause, end, approvals and instruction drafts. |
| `/api/operator/library` | Mandates, versions, corrections, confirmation and lifecycle. |
| `/api/operator/intake` | The intake chat. |
| `/api/buyer/sessions/:id` | The public conversation, messages, deliveries and voice. |
| `/api/public/listings/:caseId` | The demo listing and **Call seller**. |
| `/api/webhooks/openai` | Phone call webhooks. |

Operator routes need `Authorization: Bearer <key>`. The server prints the key at startup. Set `KRITVA_OPERATOR_KEY` to keep it after a restart.

## 13. Models

All language model work uses OpenAI.

| Function | Default | Setting |
| --- | --- | --- |
| Mapping | `gpt-5.5` | `KRITVA_MAPPING_MODEL` |
| Turn and agent | `gpt-5.4-mini` | `KRITVA_TURN_MODEL`, `KRITVA_AGENT_MODEL` |
| Intake | `gpt-5.4-mini` | `KRITVA_INTAKE_MODEL` |
| Realtime voice | `gpt-realtime-2.1` | `KRITVA_REALTIME_MODEL` |
| Voice transcript | `gpt-transcribe` | `KRITVA_REALTIME_TRANSCRIBE_MODEL` |

The agent sends requests with `store: false`, and tracing is off.

CAUTION: OpenAI retires the Speech API models (for example `gpt-4o-mini-tts`) on 2027-01-06. If you use turn-based voice, change `KRITVA_TTS_MODEL` before that date.

## 14. Tests and evaluation

### 14.1 Deterministic tests

`npm test` runs approximately 450 unit and server tests without model calls. A bridge model puts scripted answers into the real agent loop. The recorded replays (`cases/bed-sale/replays/`) play real model answers again. A replay fails if a turn gives a different reply, decision or offer.

### 14.2 Live scenarios

`npm run scenarios` runs each buyer scenario with the real model through the chat routes. Each turn can set expectations for the decision, the offer amount and reply patterns. The last run (`agentic-turn`) passed 24 of 35 scenarios, with no private disclosure. The text turn latency was 4.8 s (p50) and 7.7 s (p90). The failures were about style and expected wording. Results change between runs, thus compare repeated runs.

### 14.3 Comparison with a plain LLM

`npm run scenarios -- --compare` runs the seven core scenarios against Kritva and a plain LLM seller with the same model, instructions and buyer simulator. Rules in `apps/server/src/eval/score.ts` count violations. Last result (`agentic-turn-compare`, one run each):

| System | Valid agreements | Invalid agreements | Disclosures | Invented facts | Median latency |
| --- | --- | --- | --- | --- | --- |
| Kritva | 4 | 0 | 0 | 0 | 4.5 s |
| Plain LLM | 3 | 2 | 0 | 0 | 2.3 s |

The sample is small, and the buyers are simulated.

### 14.4 Voice timing

Measured from the end of buyer speech on 2026-11-22: conversation turns took 1.0 to 1.4 s. Deal turns took 0.7 to 1.8 s to the acknowledgement and 6 to 10 s to the full answer. The target is 1.5 s. The engine makes three model calls in sequence, thus it is the limit. Some speed changes can decrease safety, thus the project owner must approve each one.

## 15. Operation

### 15.1 Start the application

1. Select Node.js 24: `nvm use`.
2. Install the packages: `npm install`.
3. Put `OPENAI_API_KEY` in a `.env` file at the repository root.
4. Start the server: `npm run dev -w @kritva/server`.
5. In a second terminal, start the web application: `npm run dev -w @kritva/web`.
6. Open `http://localhost:5173`, select **Open console** and enter the operator key.

### 15.2 Run the checks

1. Run `npm run typecheck`.
2. Run `npm test`.
3. Run `npm run scenarios`. This step calls OpenAI and costs money.

CAUTION: In `packages/core`, do not run a bare `npx vitest run`. It also runs live tests and changes `test-results/epic-1/`.

### 15.3 Phone calls

Phone calls start when `OPENAI_WEBHOOK_SECRET` and `KRITVA_PHONE_ROUTES` are set with realtime voice. `apps/server/scripts/phone-check.ts` checks the setup. For the account steps, see `docs/Kritva_Phone_Calls.md`, section 9.

CAUTION: A Vobiz number and each call minute cost money.

## 16. Known limits and next steps

- The checks catch a deal turn that the realtime model answers itself, but they do not prevent it.
- Hindi and Tamil read-backs keep the term names in English.
- The heard part of an interrupted voice reply is an estimate.
- Voice deal turns are slower than the 1.5 s target.
- The AWS deployment is not done. The database and service choices are open and need a decision from the project owner. A region near Bangalore (for example `ap-south-1`, Mumbai) gives low latency.
