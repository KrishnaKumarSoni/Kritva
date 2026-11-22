# Kritva technical documentation

Status: branch `epics-12-14-console-voice-demo` on 2026-11-22 (revision 2). Writing standard: ASD-STE100 (Simplified Technical English).

## 1. Scope

This document tells what Kritva is, how it works and how to operate it. The other files in `docs/` give more detail.

## 2. System overview

### 2.1 Purpose

Kritva is a negotiation capability that other applications can use. It negotiates for a person or a business (the principal), who sells or buys, with one or more counterparties. The host application gives the case and the authority of the principal. Kritva gives back the progress, the approval requests and the outcome.

Kritva does not do market research, take payments or move goods. It never makes up prices or offers.

### 2.2 The demonstration case

A seller sells a one-year-old king-size bed for ₹20,000, with pickup in Koramangala, Bangalore. Buyers use chat, a browser call or a phone call.

### 2.3 The main rule

Code decides. The model words. Code sets every amount, term, commitment and permission. The language models only read messages and write replies. The models never see private limits or targets.

## 3. Architecture

The repository is an npm workspace.

| Package | Function |
| --- | --- |
| `packages/core` | The reusable negotiation core. It has no case-specific rules. |
| `apps/server` | The HTTP API (Hono), sign-in, deal groups, voice, phone calls and evaluation tools. |
| `apps/web` | The console and the counterparty page (React 19, Vite, Motion). |

Case content is in `cases/`, outside the core, for example `bed-sale` and `bicycle-purchase` (a buying case). The stack is Node.js 24, TypeScript, Zod 4, the OpenAI Agents SDK, SQLite (`node:sqlite`) and Vitest.

## 4. The mandate

### 4.1 The schema

The schema is fixed. Terms and conditions are data. The asking price (a position), the limit and the authority (a permission) are separate records. Each item quotes its source exactly. An unknown value stays unknown.

The field `principalSide` is `receives` or `pays`. When the principal pays, a better deal is a lower price. Counteroffers then go up, but never past the maximum.

### 4.2 Setup

1. The principal chats with the intake agent (`intake/`), with text or images.
2. The agent finds the roles, the side, the public items and the private items. It asks only for data that it cannot find, usually the limit.
3. Optionally, the agent collects the known counterparties.
4. The mapper (`gpt-5.5`) changes the input into a draft. The validator checks it.
5. The principal selects **Make it live**. This confirms the exact draft version and its content hash.

An inferred permission becomes a question, never authority. A counterparty message can never confirm a mandate.

### 4.3 The library

The mandate library (`mandate/library.ts`) is append-only and keeps all versions. A mandate is live, paused, closed or deleted. Only a live mandate can start a negotiation. A new revision applies to all open negotiations, and the system checks their pending offers and approvals again.

Each live mandate also has:

- A **listing code**: three digits and a Damm check digit. A misheard code never matches a different listing.
- A **counterparty list**: names, optional phone numbers and notes. The list is outside the confirmed mandate. Thus, one counterparty never sees another in the session record. `KRITVA_MAX_COUNTERPARTIES` (default 5) is the maximum.

## 5. The shared record

The record is one validated, append-only event log for each session. SQLite (`data/kritva.sqlite`) writes with WAL and `synchronous=FULL`. Thus, a returned write is on disk.

The 28 session event types include `message`, `offer_proposed`, `decision`, `approval_requested`, `follow_up_noted`, `follow_up_attempted`, `recording_saved`, `agreement_recorded`, `reply_blocked`, `delivery_reported` and `voice_connection`.

Rules:

- The route sets the actor. Conversation text can never become an approval.
- Approvals and agreements bind to an exact terms hash and mandate revision.
- An offer counts as sent only when the channel reports delivery.
- The counterparty view never shows the mandate, limits, decisions or blocked replies.

A separate group record (`record/groups.ts`) holds the events of a deal group (section 10).

## 6. The negotiation turn

### 6.1 The agent

Each turn is one run of the agent **Kritva** (`agent/negotiator.ts`, OpenAI Agents SDK). The input is the full public conversation and the public reading context. The agent must call a tool at each step, with a maximum of six model calls.

### 6.2 The tool `read_message`

The agent gives a structured reading of the message. Then code does these steps:

1. It grounds the reading against the message text.
2. It records the offer and the notes.
3. It checks the proposal against the deal space.
4. It runs the strategy (`decide()`) and selects one move.
5. It runs gate phase 1 (terms) and records the decision.
6. It returns the wording brief: the permitted amounts, the public facts and the requirements of the reply.

### 6.3 The tool `send_reply`

Code runs gate phase 2 (wording). Code checks find private amounts, amounts outside the plan, false claims of agreement and invented competition. A reviewer model finds disclosure, invented facts, deadlines and promises outside the terms.

A draft that breaks a hard limit goes back to the agent. After two rejected drafts, the tool sends checked template wording. A style problem gets only one rewrite request.

### 6.4 Failures

If the model fails before `read_message`, the system sends nothing, and a retry continues the turn. If the model fails after the plan, the system sends the template wording. Counterparty words are data, never instructions.

### 6.5 The conversation guide

A plain-text file (`negotiation/conversation-guide.md`) controls the wording. It never changes a limit. Its main rules:

- Acknowledge first. Give a reason when the position does not move. Always give a way forward.
- Tell the counterparty one time that Kritva is an AI assistant for the principal.
- The default language is Hindi. Kritva changes to the language of the counterparty immediately. It uses everyday urban speech and feminine forms for itself.
- Never use internal words (for example "mandate"). Code removes all em and en dashes.

## 7. Strategy

The strategy selects one action for each turn: ask, clarify, propose, counter, accept, decline, request approval, pause or end. The assessment uses this sequence: hard constraints, then the stated targets and preferences, then a stated alternative (BATNA).

The tactic parameters (concession steps, the counteroffer limit, the walk-away line) are data in `strategy-guidance.json`. Guidance never gives authority. Each concession needs a new commitment from the counterparty, and a repeated offer earns no reduction. An offer at or above the lower of the current ask and the target closes the deal.

## 8. Governance

The gate returns allow, block, needs approval or needs clarification. The proposal checker (`dealspace/check.ts`) is deterministic. Linked conditions stay together: "₹18,000 only with Saturday collection" fits only with Saturday collection.

Kritva requests an exception only when the limit permits a request. The approval covers those terms, that revision and that session, one time.

No prompt or tool result contains private limits, targets or the allowance. Phone numbers stay on the counterparty list or in memory, and logs mask them.

## 9. Approvals and outcomes

### 9.1 Agreement without approval

When the mandate gives Kritva the authority, Kritva reads back the complete terms from the checked fields. The counterparty confirms them. Then the system records the agreement.

### 9.2 Agreement with approval

When the terms need the approval of the principal, these steps occur:

1. Kritva does a wrap-up. It asks how long the offer stands and how and when to contact the counterparty. It says that the deal is not final. On a call, it then ends the call.
2. The approval card in the console shows the terms, the wrap-up data and the call recording.
3. The principal approves, counters or declines, with an optional message.
4. Kritva follows up: in the chat, on a live call, or with a call-back through Twilio. A call-back has one retry. Then the follow-up lapses.
5. The system records the agreement only when the counterparty says yes again after the approval.

The record refuses an agreement whose acceptance came before the approval. Changed terms cancel a pending approval.

### 9.3 Outcomes

The outcome is negotiating, paused, pending approval, agreement or no agreement. An end records who stopped and why. Payment and logistics stay pending obligations.

## 10. Several counterparties on one deal

### 10.1 The deal group

A saved mandate has one deal. All sessions under it are in one deal group (`DealGroups`). The group record has these events: `group_opened`, `counterparty_joined`, `deal_reserved`, `deal_released`, `deal_concluded` and `principal_time`. The cap applies to the open sessions in the group.

### 10.2 Competition

For each session, the effective limit is the better of the mandate limit and the best live offer from another open session. That offer must be within limits and on the same other terms. The effective limit stops further concessions. It never withdraws an offer that Kritva already made.

Kritva can cite another offer only with the permission `mention_other_offers` in mode `autonomous`. It can cite only the amount, never the name or the channel. The reply check blocks a cited amount that is better than the real offer.

### 10.3 The lock

1. **Reserve.** The first approval of an accepted package reserves the deal. The server refuses a second approval.
2. **Conclude.** When the reserved counterparty says yes again, the system records the agreement and the conclusion in one transaction.
3. **Close the others.** Each other session goes to "no agreement". Kritva tells them that the deal went elsewhere and asks to keep their number. Then the mandate closes.

If a reserved counterparty declines or changes the terms, the reservation is released.

On a live call, Kritva finishes its current sentence (or lets the counterparty finish), says a short filler and then the closing message.

### 10.4 The board

The **Deals** page shows one row for each counterparty: status, channel, the latest offer, the gap to the limit and a star on the best score. **Start negotiations** sends private links or calls the listed numbers. The header shows the negotiations run, the time the principal used and the deals outside limits (always 0).

## 11. Channels

### 11.1 Text chat

The chat tells the counterparty that Kritva is an AI. A refusal to speak to an AI ends the negotiation.

### 11.2 Browser voice

The browser voice is a live WebRTC call (`apps/server/src/realtime-voice.ts`). The server makes the call with OpenAI and joins it through a sideband WebSocket. The API key and the tools stay on the server.

The realtime model (`gpt-realtime-2.1`) is the ears and voice of Kritva. It never negotiates.

- **Conversation turn** (a greeting, a question about public facts): the model answers. It cannot say an amount or a promise.
- **Deal turn** (a price, an offer, pickup): the model says a short acknowledgement and calls `negotiate`. The voice speaks the engine reply word for word.

Code checks the words of the model. If a check fails, Kritva corrects itself.

During a wait, code tells the model how long the line was quiet. The model says a few words or calls `stay_quiet` (`voice-waiting-guide.md`). When the conversation is over, the model says a goodbye and calls `end_call` (`voice-ending-guide.md`). Code hangs up only after the goodbye plays.

A reply counts as delivered only when its audio finishes. An interrupted offer cannot be accepted.

### 11.3 Inbound phone calls

1. The counterparty calls the Twilio number.
2. Twilio asks the Voice URL (`POST /api/phone/twilio/voice`). The server checks the Twilio signature.
3. The server answers with TwiML that sends the call to OpenAI SIP (`sip.api.openai.com`), with the numbers in `X-Kritva-` headers.
4. OpenAI sends `realtime.call.incoming` to `POST /api/webhooks/openai`. The server checks the signature.
5. The server routes the call with `KRITVA_PHONE_ROUTES` and starts a session.
6. The server accepts the call with the model, instructions and voice only. After `KRITVA_PHONE_SETUP_DELAY_MS`, it joins the call and sends the other settings. This prevents silent calls.

The audio goes directly between Twilio and OpenAI.

The server decides delivery from the playback events. If the evidence is not clear, it reports the reply as interrupted.

### 11.4 The front desk

On a `code` route, one number serves all mandates. The front desk agent (`phone/front-desk.ts`) asks for the listing code. The tool `find_listing` checks it in code. On a match, the same call continues as the negotiation. Before the match, the agent knows nothing about any listing.

### 11.5 Outbound calls

Kritva can call a counterparty (`phone/outbound.ts`):

1. Twilio dials the number.
2. When the counterparty answers, Twilio sends the call to OpenAI with `X-Kritva-Call=<token>`.
3. The server joins the call to its session. Kritva says who calls, for whom and why.

Calls over `KRITVA_PHONE_MAX_CALLS` wait in a queue. There are no automatic retries.

WARNING: Indian rules prohibit cold calls and need consent for numbers on the Do-Not-Disturb registry. Kritva can call only the numbers in `KRITVA_PHONE_OUTBOUND_ALLOW`. Do not add a number without the consent of its owner.

## 12. The console and sign-in

### 12.1 Pages

| Page | Content |
| --- | --- |
| `/deals` | The deal board (section 10.4) and the approval cards. |
| `/negotiations` | A log of all negotiations. Each shows its conversation and a panel with tabs. |
| `/mandates` | The library, the intake chat, the listing code and the counterparty list. |
| `?view=buyer#session=<id>` | The counterparty page, without private data. |

All dropdowns use the Kritva component (`Select.tsx`). Colors: burnt orange `#CC5500` (accent), jet black `#0A0A0A` (primary), white (base). Headings use Geist Serif.

### 12.2 Sign-in

The principal enters an email on the curtain screen. Amazon SES sends a one-time link (15 minutes). Locally, the server log shows it. The link sets the cookie `kritva_session` (HttpOnly, SameSite=Strict, 30 days). Only addresses in `KRITVA_SIGNIN_EMAILS` get a link, and the server keeps only token hashes. Scripts use `Authorization: Bearer <KRITVA_OPERATOR_KEY>`.

## 13. Server API

The server uses port 8787.

| Routes | Function |
| --- | --- |
| `/api/auth/*` | Sign-in. |
| `/api/operator/*` | Sessions, approvals, the log, mandates, intake and calls. |
| `/api/buyer/sessions/:id` | The public conversation and voice. |
| `/api/public/listings/:caseId` | The demo listing. |
| `/api/phone/twilio/*`, `/api/webhooks/openai` | Phone webhooks. |

## 14. Models

| Function | Default | Setting |
| --- | --- | --- |
| Mapping | `gpt-5.5` | `KRITVA_MAPPING_MODEL` |
| Turn and agent | `gpt-5.4-mini` | `KRITVA_TURN_MODEL`, `KRITVA_AGENT_MODEL` |
| Intake | `gpt-5.4-mini` | `KRITVA_INTAKE_MODEL` |
| Realtime voice | `gpt-realtime-2.1`, voice `marin` | `KRITVA_REALTIME_MODEL` |
| Voice transcript | `gpt-transcribe` | `KRITVA_REALTIME_TRANSCRIBE_MODEL` |

## 15. Deployment

The server runs on one AWS EC2 instance in `us-west-2`, as the systemd service `kritva`, with HTTPS. `scripts/deploy-aws.sh` copies committed `main` to `/opt/kritva`, builds the web application, restarts the service and checks `/api/health`. With `--env`, it also copies `.env` merged with `.env.production`, thus secrets never go through git. The script does not change the SQLite data.

The region is next to OpenAI, because deal turns wait on OpenAI. From there, the server joined phone calls too early and the calls were silent. Thus, `KRITVA_PHONE_SETUP_DELAY_MS` is 1500 on AWS.

## 16. Tests and evaluation

### 16.1 Deterministic tests

`npm test` runs approximately 590 unit and server tests without model calls. A bridge model puts scripted answers into the real agent loop. The recorded replays play real model answers again and fail on any changed reply, decision or offer.

### 16.2 Live scenarios

`npm run scenarios` runs each buyer scenario with the real model through the chat routes. `run-group-scenarios.ts` runs the scenarios for several counterparties.

| Run | Passed | Safety failures |
| --- | --- | --- |
| `tone-final` (35 scenarios) | 32 | 0 |
| `approval-full-2` (39 scenarios, with approvals) | 35 | 0 |

The failures were about expected wording. Results change between runs.

### 16.3 Comparison with a plain LLM

`npm run scenarios -- --compare` runs the seven core scenarios against Kritva and a plain LLM seller with the same model and buyer simulator. Rules in `eval/score.ts` count violations. In the last comparison, Kritva made 4 valid agreements and 0 invalid agreements. The plain LLM made 3 valid agreements and 2 invalid agreements. Neither disclosed a private limit. The sample is small, and the buyers are simulated.

## 17. Operation

### 17.1 Start locally

1. Select Node.js 24: `nvm use`.
2. Install the packages: `npm install`.
3. Put `OPENAI_API_KEY` in a `.env` file at the repository root.
4. Start the server: `npm run dev -w @kritva/server`.
5. In a second terminal, start the web application: `npm run dev -w @kritva/web`.
6. Open `http://localhost:5173` and sign in with the link from the server log.

### 17.2 Run the checks

1. Run `npm run typecheck`.
2. Run `npm test`.
3. Run `npm run scenarios`. This step calls OpenAI and costs money.

CAUTION: In `packages/core`, do not run a bare `npx vitest run`. It also runs live tests and changes `test-results/epic-1/`.

### 17.3 Phone calls and email

- Phone: see `docs/Kritva_Phone_Calls.md`, section 9. `phone-check.ts` checks the setup.
- Email: run `npm run email:setup -- <address>`, then click the verification email from AWS.

CAUTION: A Twilio number, each call minute and each realtime minute cost money.

## 18. Known limits and next steps

- The checks catch a deal turn that the realtime model answers itself, but they do not prevent it.
- On voice, a deal turn takes 0.7 to 1.8 s to the acknowledgement and 6 to 10 s to the full answer. The target is 1.5 s. The engine (three model calls in sequence) is the limit.
- Callers in India call a US Twilio number on an international route.
- The front desk hand-over and keypad digits are not tested on a live call.
- Outbound calls need a decision about Indian consent rules before Kritva calls anyone other than the owner.
- The fallback turn-based voice (`KRITVA_VOICE_MODE=turns`) needs a new `KRITVA_TTS_MODEL` before 2027-01-06.
