/**
 * The negotiation turn engine. One path serves the chat page, the scenario script and,
 * later, voice: record the counterparty's message, interpret it, decide, word the reply,
 * check it in code, and record every step in the shared record.
 *
 * Every decision reads recorded state. A reply that fails the outgoing check is blocked,
 * recorded, and replaced by checked template wording.
 */
import type { StructuredLlm } from "../llm/types.ts";
import { hashTerms, type Actor, type Channel, type NewEvent, type OfferTerm, type PayloadOf, type RecordedEvent } from "../record/events.ts";
import { newEventId, type NegotiationRecord } from "../record/store.ts";
import { composeBrief, EXACT_TERMS_SLOT } from "./compose.ts";
import { interpretRequest, readInterpretation, type FulfillmentTerms, type InterpretInput } from "./interpret.ts";
import { user, type Model, type ModelSettings } from "@openai/agents";
import { eventItem, historyItems, readingContextItem, runNegotiator, StructuredLlmAgentModel, type AgentConfig, type SendOutcome } from "../agent/negotiator.ts";
import { formatValue, numericValue, withTerm, type MandateView } from "./mandate-view.ts";
import { checkProposal, type DealCheck } from "../dealspace/check.ts";
import type { ConfirmedMandate } from "../schema/records.ts";
import { projectCounterparty, type CounterpartyModel } from "../counterparty/model.ts";
import { prepareQuestions } from "../counterparty/questions.ts";
import { gateTerms, gateWording, type GateResult } from "../governance/gate.ts";
import { normalizeForQuoteMatch, quoteAppearsIn } from "../schema/quotes.ts";
import { languageCheck } from "../governance/language-check.ts";
import { decide, type DealInput, type Interpretation, type Plan } from "./policy.ts";
import { checkReply, findAmounts, type ReplyViolation } from "./reply-check.ts";
import { approvedFor, projectState, publicDealTerms, type NegotiationState } from "./state.ts";
import { MINIMAL_GUIDANCE, type StrategyGuidance } from "../strategy/guidance.ts";
import { projectAllowance } from "../strategy/allowance.ts";
import { clean, introduction, principalLabel, speakTerms, templateReply } from "./templates.ts";

interface PublicListingDetails {
  publicPrincipalName?: string;
  available?: boolean;
  fulfillment?: FulfillmentTerms;
}

export interface EngineOptions {
  record: NegotiationRecord;
  llm: StructuredLlm;
  /** Formatting locale from the host application, e.g. for currency display. */
  locale: string;
  /** Tactic parameters from a strategy document. Never overrides the mandate or governance. */
  guidance?: StrategyGuidance;
  /** Optional strategy guidance scoped to each case by the host. */
  guidanceByCase?: ReadonlyMap<string, StrategyGuidance>;
  /** Optional public subject fact IDs supplied by the host for final-terms wording. */
  subjectFacts?: ReadonlyMap<string, string>;
  listingDetails?: ReadonlyMap<string, PublicListingDetails>;
  /**
   * The agent's model (a model name for the OpenAI Agents SDK, or a Model). Without one, the
   * structured model answers the agent's decisions through the bridge (tests and replays).
   */
  agentModel?: Model | string;
  agentModelSettings?: ModelSettings;
}

export interface TurnResult {
  ok: true;
  reply: { messageId: string; text: string; offerIds: string[]; channel: Channel } | null;
  events: RecordedEvent[];
  state: NegotiationState;
  timings: { interpretMs: number; composeMs: number; totalMs: number };
}
export interface TurnError {
  ok: false;
  code: "session_not_found" | "invalid_event" | "write_failed" | "not_pending" | "model_unavailable";
  message: string;
}

const AGENT: Actor["kind"] = "agent";

export class NegotiationEngine {
  readonly #record: NegotiationRecord;
  readonly #llm: StructuredLlm;
  readonly #locale: string;
  readonly #guidance: StrategyGuidance;
  readonly #guidanceByCase: ReadonlyMap<string, StrategyGuidance>;
  readonly #subjectFacts: ReadonlyMap<string, string>;
  readonly #listingDetails: ReadonlyMap<string, PublicListingDetails>;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #agentModel: Model | string | undefined;
  readonly #agentModelSettings: ModelSettings | undefined;

  constructor(options: EngineOptions) {
    this.#record = options.record;
    this.#llm = options.llm;
    this.#locale = options.locale;
    this.#guidance = options.guidance ?? MINIMAL_GUIDANCE;
    this.#guidanceByCase = options.guidanceByCase ?? new Map();
    this.#subjectFacts = options.subjectFacts ?? new Map();
    this.#listingDetails = options.listingDetails ?? new Map();
    this.#agentModel = options.agentModel;
    this.#agentModelSettings = options.agentModelSettings;
  }

  guidanceFor(caseId: string): StrategyGuidance {
    return this.#guidanceByCase.get(caseId) ?? this.#guidance;
  }

  /** Turns for one session run one at a time, in arrival order. */
  #serialize<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.#locks.set(sessionId, next.catch(() => undefined));
    return next;
  }

  async state(sessionId: string): Promise<NegotiationState> {
    return projectState(await this.#record.context(sessionId));
  }

  publicSubject(view: MandateView): string | null {
    const id = this.#subjectFacts.get(view.mandate.caseId);
    const fact = view.mandate.facts.find((f) => f.id === id && f.status === "stated" && f.disclosure === "public" && f.partyId === view.principalId);
    return fact?.value?.type === "text" ? fact.value.value : null;
  }

  /**
   * Realtime voice: what the voice model may say on its own. Public facts and the public terms
   * that are not negotiated, with no amount of the negotiated term (price questions go to the engine).
   */
  async voiceBriefing(sessionId: string): Promise<{ status: NegotiationState["status"]; subject: string | null; principalName: string | null; principalRole: string; counterpartyRole: string; facts: string[]; terms: string[] } | null> {
    const ctx = await this.#record.context(sessionId);
    if (!ctx.mandate) return null;
    const state = projectState(ctx);
    const { view } = state;
    const negotiated = view.negotiable?.termId ?? null;
    const terms = publicDealTerms(state)
      .filter((t) => t.termId !== negotiated)
      .map((t) => `${view.terms.get(t.termId)?.name ?? t.termId}: ${formatValue(t.value, this.#locale)}`);
    return {
      status: state.status,
      subject: this.publicSubject(view),
      principalName: this.#listingDetails.get(view.mandate.caseId)?.publicPrincipalName?.trim() || null,
      principalRole: view.principalRole,
      counterpartyRole: view.counterpartyRole,
      facts: view.publicFacts,
      terms,
    };
  }

  /** Handles one completed counterparty turn (a typed message or a final voice transcript). */
  handleCounterpartyMessage(input: {
    sessionId: string;
    text: string;
    channel: Channel;
    /** Client-supplied ID makes retries safe: a repeated message is not processed twice. */
    messageId?: string;
    utteranceId?: string | null;
    /** The language they spoke (ISO 639-1), when a live voice call knows it. The reply uses it. */
    language?: string | null;
  }): Promise<TurnResult | TurnError> {
    return this.#serialize(input.sessionId, () => this.#counterpartyTurn(input));
  }

  async #counterpartyTurn(input: { sessionId: string; text: string; channel: Channel; messageId?: string; utteranceId?: string | null; language?: string | null }): Promise<TurnResult | TurnError> {
    const started = performance.now();
    const { sessionId, channel } = input;
    const session = await this.#record.getSession(sessionId);
    if (!session) return { ok: false, code: "session_not_found", message: "The session does not exist." };
    const before = projectState(await this.#record.context(sessionId));
    const counterpartyId = before.view.counterpartyId;
    const counterparty: Actor = { kind: "counterparty", partyId: counterpartyId };
    const agent: Actor = { kind: AGENT, partyId: before.view.principalId };
    const writes = new Writer(this.#record, sessionId);

    const inbound = await this.#record.append(
      sessionId,
      {
        id: input.messageId ?? newEventId(),
        type: "message",
        channel,
        payload: { direction: "inbound", speakerPartyId: counterpartyId, text: input.text, utteranceId: input.utteranceId ?? null, offerIds: [] },
      },
      counterparty,
    );
    if (!inbound.ok) return { ok: false, code: inbound.error.code === "session_not_found" ? "session_not_found" : inbound.error.code === "write_failed" ? "write_failed" : "invalid_event", message: inbound.error.message };
    const currentMessage = (inbound.event.payload as PayloadOf<"message">).text;
    let existingOfferId: string | null = null;
    if (!inbound.created) {
      // A retry. If the turn finished, return it. If it was cut off before any commitment
      // (offer, acceptance, approval, agreement), resume it; otherwise return what was recorded.
      const after = (await this.#record.read(sessionId, { viewer: "operator" })).filter((e) => e.seq > inbound.event.seq);
      // A turn whose message could not be read (recorded as a failed read) is resumed too.
      // Records of the reading and the decision commit nothing; anything sent, offered or agreed does.
      const resumable = after.every((e) => ["offer_extracted", "decision", "question_prepared", "counterparty_noted", "question_answered", "proposal_checked", "term_requested", "reply_blocked"].includes(e.type));
      if (!resumable || after.some((e) => e.type === "message")) return this.#replay(sessionId, inbound.event, started);
      existingOfferId = after.find((e) => e.type === "offer_extracted")?.id ?? null;
    } else {
      writes.created.push(inbound.event);
    }

    try {
      const conversation = await this.#conversation(sessionId, inbound.event.id);
      const openQuestions = projectCounterparty(await this.#record.context(sessionId), before.view.negotiable?.termId ?? null)
        .questions.filter((q) => q.status === "asked" || q.status === "partial")
        .map((q) => ({ id: q.id, text: q.text }));
      const fulfillment = this.#listingDetails.get(before.view.mandate.caseId)?.fulfillment;
      const readingInput: InterpretInput = { view: before.view, publicTerms: publicDealTerms(before), subject: this.publicSubject(before.view), fulfillment, lastStated: before.lastCommunicated, conversation, message: currentMessage, locale: this.#locale, openQuestions };
      const reading = interpretRequest(readingInput);
      const capture: { error: unknown } = { error: null };
      const turn: { planned: Planned | null; ctx: ActContext | null; interpretMs: number } = { planned: null, ctx: null, interpretMs: 0 };
      const rephrase = false;

      // read_message: the agent's reading goes through the same grounding, recording and planning as before.
      const readMessage = async (json: unknown): Promise<Record<string, unknown>> => {
        if (turn.planned) return turn.planned.drafting.brief;
        turn.interpretMs = Math.round(performance.now() - started);
        const interp = readInterpretation(readingInput, json);
        // An earlier, higher ask of ours quoted back ("X is too much") is never the counterparty offering more than the current ask.
        const n0 = before.view.negotiable;
        if (n0 && before.currentAsk !== null) {
          const quoted = (t: OfferTerm) =>
            t.termId === n0.termId && "amount" in t.value && (t.value.amount as number) !== before.currentAsk && before.askHistory.includes(t.value.amount as number);
          interp.offerTerms = interp.offerTerms.filter((t) => !quoted(t));
        }

        // A detail given now may settle an earlier offer that was waiting on it: carry that offer's amount forward.
        const n = before.view.negotiable;
        const awaitingDetail = before.lastCounterpartyCheck?.findings.some((f) => f.termId === n?.termId && f.status === "needs_clarification" && f.basis === "condition");
        if (n && awaitingDetail && (interp.offerKind === undefined || interp.offerKind === "offer") && !interp.offerTerms.some((t) => t.termId === n.termId) && interp.offerTerms.length > 0) {
          const earlier = before.lastCounterpartyCheck!.checkedTerms.find((t) => t.termId === n.termId);
          if (earlier) interp.offerTerms = [...interp.offerTerms, earlier];
        }

        const related: string[] = [inbound.event.id];
        let offerExtractedId: string | null = existingOfferId;
        if (existingOfferId) {
          related.push(existingOfferId);
        } else if (interp.offerTerms.length > 0 && interp.offerKind !== "budget_ceiling") {
          const previousOfferId = lastCounterpartyOfferId(await this.#record.context(sessionId), interp.offerKind ?? "offer");
          const offer = await writes.put(
            {
              id: newEventId(),
              type: "offer_extracted",
              channel: null,
              payload: {
                sourceMessageId: inbound.event.id,
                byPartyId: counterpartyId,
                terms: interp.offerTerms,
                termsHash: hashTerms(interp.offerTerms),
                kind: interp.offerKind === "enquiry" || interp.offerKind === "interest" ? interp.offerKind : "offer",
                previousOfferId,
                conditions: interp.offerConditions ?? [],
                correctsPrevious: interp.correctsPrevious === true && previousOfferId !== null,
              },
            },
            agent,
          );
          offerExtractedId = offer.id;
          related.push(offer.id);
        }
        // Requests the mandate does not cover are recorded as the counterparty's, never as the principal's terms.
        const requestedIds: string[] = [];
        const alreadyRequested = (await this.#record.read(sessionId, { viewer: "operator" })).filter((e) => e.type === "term_requested" && (e.payload as { sourceMessageId: string }).sourceMessageId === inbound.event.id);
        for (const t of interp.newTerms) {
          const previous = alreadyRequested.find((e) => (e.payload as { name: string }).name === t.name);
          if (previous) {
            requestedIds.push(previous.id);
            related.push(previous.id);
            continue;
          }
          const requested = await writes.put(
            { id: newEventId(), type: "term_requested", channel: null, payload: { sourceMessageId: inbound.event.id, byPartyId: counterpartyId, name: t.name, description: t.description, value: t.value } },
            agent,
          );
          requestedIds.push(requested.id);
          related.push(requested.id);
        }

        await this.#recordCounterparty(writes, { sessionId, inboundId: inbound.event.id, text: currentMessage, interp, failed: rephrase, agent, counterpartyId });

        const state = projectState(await this.#record.context(sessionId));
        const deal = counterpartyDeal(state, interp);
        if (offerExtractedId) {
          const check = await this.#recordCheck(writes, state, offerExtractedId, deal.package, deal.check, requestedIds, agent);
          related.push(check.id);
        }
        turn.ctx = { sessionId, channel, agent, interp, inboundId: inbound.event.id, related, conversation, currentMessage, rephrase, language: input.language ?? null };
        turn.planned = await this.#plan(writes, turn.ctx);
        return turn.planned.drafting.brief;
      };

      let worded: { text: string; question: string | null } | null = null;
      try {
        const { payload } = reading;
        const { recent_conversation: _history, counterparty_message: _message, ...context } = payload;
        void _history;
        void _message;
        worded = await runNegotiator(
          this.#agentConfig(reading),
          {
            readMessage: { schema: reading.schema, execute: (json) => this.#guard(capture, () => readMessage(json)) },
            sendReply: (draft) => (turn.planned ? this.#guard(capture, () => this.#review(writes, turn.planned!.drafting, draft, agent)) : Promise.resolve({ status: "not_ready" as const, problems: ["Call read_message with your reading of their latest message first."] })),
          },
          [...historyItems(conversation), readingContextItem(context), user(currentMessage)],
        );
      } catch {
        worded = null;
      }
      if (capture.error) throw capture.error;
      if (!turn.planned || !turn.ctx) {
        // The message could not be read. Record that for the operator, keep the session as it was and
        // send nothing: no guessed reply, no offer. Retrying the same message ID resumes this turn.
        if (!existingFailure(await this.#record.read(sessionId, { viewer: "operator" }), inbound.event.seq)) {
          await this.#recordCounterparty(writes, { sessionId, inboundId: inbound.event.id, text: currentMessage, interp: emptyInterpretation(), failed: true, agent, counterpartyId });
        }
        return { ok: false, code: "model_unavailable", message: "Kritva couldn't read that message just now. Nothing was sent. Try again." };
      }
      // A planned move always gets governed wording: the agent's accepted reply, or the checked fallback.
      if (worded && !worded.text) worded = null;
      else if (!worded && turn.planned.drafting.attempts < 2) worded = await this.#fallback(writes, turn.planned.drafting, agent);
      const interpretMs = turn.interpretMs;
      const actStarted = performance.now();
      const reply = await this.#deliver(writes, turn.ctx, turn.planned, worded);
      void actStarted;
      const composeMs = Math.round(performance.now() - started) - interpretMs;
      return {
        ok: true,
        reply,
        events: writes.created,
        state: projectState(await this.#record.context(sessionId)),
        timings: { interpretMs, composeMs: Math.max(0, composeMs), totalMs: Math.round(performance.now() - started) },
      };
    } catch (error) {
      if (error instanceof WriteFailure) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  /**
   * Plans, gates and sends one action. Authority is read fresh on every attempt and again just
   * before sending; if the mandate changed meanwhile, the action is planned again under the new
   * revision. Nothing reaches the counterparty without passing both gate phases.
   */
  async #plan(writes: Writer, ctx: ActContext): Promise<Planned> {
    let state = projectState(await this.#record.context(ctx.sessionId));
    const deal = counterpartyDeal(state, ctx.interp);
    // Questions this message raised (prepared just now), which the strategy may ask before conceding.
    const history = await this.#record.context(ctx.sessionId);
    const counterparty = projectCounterparty(history, state.view.negotiable?.termId ?? null);
    const freshQuestions = writes.created
      .filter((e) => e.type === "question_prepared" && counterparty.questions.some((q) => q.id === e.id && q.status === "open"))
      .map((e) => {
        const q = e.payload as PayloadOf<"question_prepared">;
        return { questionId: e.id, text: q.text, kind: q.issueKind, purpose: q.purpose };
      });
    let plan: Plan;
    const allowance = projectAllowance(history, state.view, this.guidanceFor(state.view.mandate.caseId));
    try {
      plan = state.status === "paused"
        ? { ...basePlan("answer", { kind: "hold", reason: "The principal paused the negotiation." }, null), action: "pause" }
        : decide(state, ctx.interp, deal, { guidance: this.guidanceFor(state.view.mandate.caseId), freshQuestions, counterparty, listingAvailable: this.#listingDetails.get(state.view.mandate.caseId)?.available, allowance, locale: this.#locale });
    } catch {
      // A strategy failure never improvises: hold, offer nothing, and say we will come back.
      plan = { ...basePlan("answer", { kind: "hold", reason: "The strategy could not choose a move; nothing was offered." }, null), action: "wait", notice: "check_with_principal" };
    }
    plan.allowance = allowance;
    if (state.status === "paused") plan.notice = "paused";
    if (ctx.rephrase) plan.notice ??= "rephrase";
    // Kritva introduces itself once, on its first real reply (a pause notice doesn't count).
    plan.turnIndex = outboundCount(history);
    plan.introduce = !alreadyIntroduced(history) && plan.notice !== "paused" && plan.notice !== "ended";
    const prepared = state.mandateRevision;

    // A change while waiting for approval supersedes the pending request.
    if (state.status === "awaiting_approval" && plan.move !== "await_approval" && plan.move !== "closed") {
      await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: "awaiting_approval", to: "active", reason: "The counterparty changed the terms; the pending approval no longer applies." } }, ctx.agent);
      plan.notice ??= "terms_changed";
      state = projectState(await this.#record.context(ctx.sessionId));
    }

    // Phase 1: the structured action against the mandate in force.
    const termsGate = gateTerms(state, plan, prepared);
    if (termsGate.decision !== "allow") {
      if (termsGate.decision === "needs_approval" && plan.offer) {
        await this.#recordGate(writes, plan, termsGate, "terms", null, ctx.agent);
        return this.#requestException(writes, state, plan, termsGate, ctx);
      }
      // A blocked offer stays in the record as an internal offer, never as one the counterparty received.
      const blockedId = plan.offer && plan.offer.terms.length > 0 && hashTerms(plan.offer.terms) !== state.lastProposed?.termsHash ? await this.#recordOffer(writes, state, plan.offer, ctx.agent) : null;
      await this.#recordGate(writes, plan, termsGate, "terms", blockedId, ctx.agent);
      plan.action = termsGate.reasons.some((r) => r.rule === "paused") ? "pause" : termsGate.decision === "needs_clarification" ? "clarify" : "wait";
      if (termsGate.reasons.some((r) => r.rule === "paused")) plan.notice = "paused";
      else if (termsGate.decision === "needs_clarification") {
        for (const name of clarifyNames(state, plan)) if (!plan.clarify.includes(name)) plan.clarify.push(name);
        if (plan.clarify.length === 0) plan.notice ??= "check_with_principal";
      }
      plan.decision = { kind: "hold", reason: `No offer sent: ${termsGate.decision.replace("_", " ")} (${termsGate.reasons[0]?.detail ?? "gate"})`.slice(0, 500) };
      plan.offer = null;
      plan.referenceAmount = undefined;
      plan.publicTermAnswers = undefined;
      plan.acceptanceOf = null;
      if (plan.move !== "await_approval" && plan.move !== "closed") plan.move = "answer";
    }
    if (!plan.ask && plan.strategyQuestion) plan.ask = await this.#strategyQuestion(writes, counterparty, plan.strategyQuestion, ctx.inboundId, ctx.agent);
    plan.ask ??= selectQuestion(freshQuestions, plan);
    if (plan.ask && plan.action === "decline" && plan.declined.length === 0) plan.action = "ask";
    if (!plan.ask && plan.strategyQuestion && (plan.action === "ask" || plan.action === "clarify")) {
      plan.action = "answer";
      plan.decision.reason += " This question was already put to the counterparty.";
    }
    await writes.put({ id: newEventId(), type: "decision", channel: null, payload: this.#decisionPayload(plan, state, plan.ask ? [...ctx.related, plan.ask.questionId] : ctx.related, ctx.interp) }, ctx.agent);

    if (plan.move === "confirm_agreement" && plan.acceptanceOf) plan.approvalGranted = Boolean(approvedFor(state, plan.acceptanceOf.termsHash));
    const offerIds = await this.#recordCommitments(writes, state, plan, ctx.inboundId, ctx.agent);
    return { plan, state, prepared, offerIds, exception: false, drafting: this.#drafting(state, plan, ctx.conversation, ctx.currentMessage, ctx.channel, ctx.language) };
  }

  /**
   * Sends the worded move under the authority it was prepared with. If the mandate changed or the
   * principal paused while the reply was being written, the move is planned again and worded again.
   */
  async #deliver(writes: Writer, ctx: ActContext, planned: Planned, worded: { text: string; question: string | null } | null): Promise<TurnResult["reply"]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { plan, prepared, offerIds } = planned;
      if (planned.exception) {
        if (!worded) return null;
        await this.#recordGate(writes, plan, { decision: "allow", reasons: [], mandateRevision: planned.state.mandateRevision, termsHash: null, breachedRuleIds: [] }, "send", null, ctx.agent);
        const held = await writes.put({ id: newEventId(), type: "message", channel: ctx.channel, payload: { direction: "outbound", speakerPartyId: planned.state.view.principalId, text: worded.text, utteranceId: null, offerIds: [] } }, ctx.agent);
        return { messageId: held.id, text: worded.text, offerIds: [], channel: ctx.channel };
      }
      // Send: the action may go only under the authority it was prepared with.
      const now = projectState(await this.#record.context(ctx.sessionId));
      const changed = now.mandateRevision !== prepared ? "stale_authority" : now.status === "paused" && plan.notice !== "paused" ? "paused" : null;
      if (changed) {
        await this.#recordGate(writes, plan, { decision: "block", reasons: [{ rule: changed, detail: changed === "paused" ? "The principal paused before sending." : "The mandate changed before sending; planning again." }], mandateRevision: prepared, termsHash: null, breachedRuleIds: [] }, "send", offerIds[0] ?? null, ctx.agent);
        planned = await this.#plan(writes, ctx);
        worded = await this.#speak(writes, planned.drafting, ctx.agent, "The situation changed while your reply was being written. Word this move instead; the earlier draft was not sent.");
        continue;
      }
      if (!worded) return null;
      const { text, question } = worded;
      await this.#recordGate(writes, plan, { decision: "allow", reasons: [], mandateRevision: prepared, termsHash: plan.offer ? hashTerms(plan.offer.terms) : null, breachedRuleIds: [] }, "send", offerIds[0] ?? null, ctx.agent);
      if (plan.move === "end_negotiation" && plan.end) {
        await writes.put(
          { id: newEventId(), type: "status_changed", channel: null, payload: { from: now.status, to: "no_agreement", reason: plan.end.reason, requestedBy: plan.end.requestedBy, unresolved: plan.end.unresolved } },
          ctx.agent,
        );
      }
      const reply = await writes.put(
        { id: newEventId(), type: "message", channel: ctx.channel, payload: { direction: "outbound", speakerPartyId: now.view.principalId, text, utteranceId: null, offerIds } },
        ctx.agent,
      );
      if (plan.ask && question) {
        await writes.put({ id: newEventId(), type: "question_asked", channel: null, payload: { questionId: plan.ask.questionId, messageId: reply.id, text: question } }, ctx.agent);
      }
      return { messageId: reply.id, text, offerIds, channel: ctx.channel };
    }
    return null;
  }

  /**
   * The terms cross a limit the principal may waive. Record them as proposed but unsent, ask
   * the principal, and tell the counterparty only that we are checking. Nothing is offered.
   */
  async #requestException(writes: Writer, state: NegotiationState, plan: Plan, gate: GateResult, ctx: ActContext): Promise<Planned> {
    const terms = plan.offer!.terms;
    const hash = hashTerms(terms);
    const reuse = state.lastProposed && state.lastProposed.termsHash === hash;
    const offerId = reuse
      ? state.lastProposed!.offerId
      : (await writes.put({ id: newEventId(), type: "offer_proposed", channel: null, payload: { byPartyId: state.view.principalId, basis: "final_terms", terms, termsHash: hash, previousOfferId: state.lastProposed?.offerId ?? null } }, ctx.agent)).id;
    await this.#recordCheck(writes, state, offerId, terms, checkProposal(state.space, terms), [], ctx.agent);
    await writes.put(
      {
        id: newEventId(),
        type: "approval_requested",
        channel: null,
        payload: {
          offerId,
          termsHash: hash,
          mandateRevision: state.mandateRevision,
          acceptanceId: null,
          purpose: "exception",
          breachedRuleIds: gate.breachedRuleIds,
          requestedAction: "Offer these exact terms as a one-off exception. Your standing limits do not change.",
        },
      },
      ctx.agent,
    );
    await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: state.status, to: "awaiting_approval", reason: "These terms need the principal's exception approval." } }, ctx.agent);
    await writes.put({ id: newEventId(), type: "decision", channel: null, payload: { kind: "request_approval", reason: "The terms cross a limit the principal may approve an exception to; asking before offering.", relatedEventIds: [...ctx.related, offerId] } }, ctx.agent);
    const holding = basePlan("await_approval", { kind: "request_approval", reason: "Waiting for the principal's exception decision." }, null);
    holding.notice = "check_with_principal";
    return { plan: holding, state, prepared: state.mandateRevision, offerIds: [], exception: true, drafting: this.#drafting(state, holding, ctx.conversation, ctx.currentMessage, ctx.channel, ctx.language) };
  }

  /** Records what the counterparty said and answered, then prepares questions from the updated context. */
  async #recordCounterparty(writes: Writer, input: { sessionId: string; inboundId: string; text: string; interp: Interpretation; failed: boolean; agent: Actor; counterpartyId: string }): Promise<void> {
    const kinds = new Set(["need", "constraint", "preference", "reason", "authority", "claim", "alternative", "budget", "final_position"]);
    // Only items whose quote really is in the message are kept; the counterparty's words are never paraphrased into a quote.
    const items = (input.interp.notes ?? [])
      .filter((n) => kinds.has(n.kind) && quoteAppearsIn(input.text, n.quote))
      .map((n) => ({ kind: n.kind as never, quote: n.quote, summary: n.summary, termId: n.termId, value: n.value, condition: n.condition, basis: n.basis }));
    // A resumed turn (its first attempt was cut off) keeps the reading it already recorded.
    const earlier = (await this.#record.context(input.sessionId)).events.filter((e) => (e.payload as { sourceMessageId?: string }).sourceMessageId === input.inboundId);
    const noted = earlier.some((e) => e.type === "counterparty_noted" && !(e.payload as { failed: boolean }).failed);
    if ((items.length > 0 || input.failed) && !noted) {
      await writes.put({ id: newEventId(), type: "counterparty_noted", channel: null, payload: { sourceMessageId: input.inboundId, failed: input.failed, items } }, input.agent);
    }
    const before = projectCounterparty(await this.#record.context(input.sessionId), null);
    for (const a of input.interp.answers ?? []) {
      const q = before.questions.find((x) => x.id === a.questionId && (x.status === "asked" || x.status === "partial"));
      if (!q || earlier.some((e) => e.type === "question_answered" && (e.payload as { questionId: string }).questionId === q.id)) continue;
      await writes.put(
        { id: newEventId(), type: "question_answered", channel: null, payload: { questionId: q.id, sourceMessageId: input.inboundId, quote: a.quote && quoteAppearsIn(input.text, a.quote) ? a.quote : null, resolution: a.resolution } },
        input.agent,
      );
    }
    const state = projectState(await this.#record.context(input.sessionId));
    const model = projectCounterparty(await this.#record.context(input.sessionId), state.view.negotiable?.termId ?? null);
    const n = state.view.negotiable;
    const nameOf = (id: string) => state.space.terms.find((t) => t.termId === id)?.name ?? id;
    const format = (amount: number) => (n ? formatValue(numericValue(n, amount), this.#locale) : String(amount));
    for (const q of prepareQuestions(model, nameOf, format, input.inboundId, n?.termId ?? null)) {
      await writes.put({ id: newEventId(), type: "question_prepared", channel: null, payload: q }, input.agent);
    }
  }

  async #recordGate(writes: Writer, plan: Plan, gate: GateResult, phase: "terms" | "wording" | "send", offerId: string | null, agent: Actor): Promise<void> {
    await writes.put(
      {
        id: newEventId(),
        type: "action_checked",
        channel: null,
        payload: {
          move: plan.move,
          phase,
          offerId,
          termsHash: gate.termsHash,
          mandateRevision: gate.mandateRevision,
          decision: gate.decision,
          reasons: gate.reasons.slice(0, 30).map((r) => ({ rule: r.rule.slice(0, 80), detail: r.detail.slice(0, 500) })),
        },
      },
      agent,
    );
  }

  /** Records offers, acceptance, approval requests and agreements implied by an allowed plan. */
  async #recordCommitments(writes: Writer, state: NegotiationState, plan: Plan, messageId: string, agent: Actor): Promise<string[]> {
    const offerIds: string[] = [];
    if (plan.offer) {
      const hash = hashTerms(plan.offer.terms);
      const reuse = state.lastProposed && state.lastProposed.termsHash === hash && state.lastProposed.basis === plan.offer.basis;
      const offerId = reuse ? state.lastProposed!.offerId : await this.#recordOffer(writes, state, plan.offer, agent, false);
      const existing = state.checks.get(offerId);
      if (!existing || existing.mandateRevision !== state.mandateRevision || existing.termsHash !== hash) {
        await this.#recordCheck(writes, state, offerId, plan.offer.terms, checkProposal(state.space, plan.offer.terms), [], agent);
      }
      offerIds.push(offerId);
    }

    if ((plan.move === "request_approval" || plan.move === "confirm_agreement") && plan.acceptanceOf) {
      const accepted = plan.acceptanceOf;
      const acceptance = await writes.put(
        { id: newEventId(), type: "acceptance_recorded", channel: null, payload: { offerId: accepted.offerId, termsHash: accepted.termsHash, messageId, byPartyId: state.view.counterpartyId } },
        agent,
      );
      if (plan.move === "request_approval") {
        await writes.put(
          { id: newEventId(), type: "approval_requested", channel: null, payload: { offerId: accepted.offerId, termsHash: accepted.termsHash, mandateRevision: state.mandateRevision, acceptanceId: acceptance.id, purpose: "acceptance", breachedRuleIds: [], requestedAction: "Agree to these exact terms, which the other party has accepted." } },
          agent,
        );
        await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: state.status, to: "awaiting_approval", reason: "Counterparty accepted; waiting for the principal's approval." } }, agent);
      } else {
        // An approval the principal already gave for these exact terms covers the agreement.
        const approval = approvedFor(state, accepted.termsHash);
        await writes.put(
          { id: newEventId(), type: "agreement_recorded", channel: null, payload: { offerId: accepted.offerId, terms: accepted.terms, termsHash: accepted.termsHash, mandateRevision: state.mandateRevision, acceptanceId: acceptance.id, approvalId: approval?.responseId ?? null } },
          agent,
        );
        await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: state.status, to: "agreed", reason: "Counterparty accepted terms the principal authorized." } }, agent);
        plan.offer = { terms: accepted.terms, basis: "final_terms" };
      }
    }
    return offerIds;
  }

  /** Everything one reply's wording depends on: the plan, public content and the brief the agent reads. */
  #drafting(state: NegotiationState, plan: Plan, conversation: Conversation, currentMessage: string | null = null, channel: Channel = "text", language: string | null = null): Drafting {
    const subject = this.publicSubject(state.view);
    const publicPrincipalName = this.#listingDetails.get(state.view.mandate.caseId)?.publicPrincipalName?.trim();
    const publicTerms = publicDealTerms(state);
    const offerInvitedRecently = invitedOfferRecently(conversation);
    const brief = composeBrief({ view: state.view, plan, publicTerms, publicPrincipalName, conversation, theirMessage: currentMessage, locale: this.#locale, outcome: state.outcome.kind, offerInvitedRecently, channel: channel === "voice" ? "voice" : "text", language });
    return {
      state, plan, conversation, currentMessage, subject, publicPrincipalName, publicTerms, offerInvitedRecently, brief,
      previousReply: [...conversation].reverse().find((c) => c.speaker === "agent")?.text ?? null,
      attempts: 0,
    };
  }

  /** The agent's model and settings for a run. Without a configured model, the structured model answers through the bridge. */
  #agentConfig(reading: { payload: Record<string, unknown>; schema: Record<string, unknown> } | null): AgentConfig {
    return this.#agentModel !== undefined
      ? { model: this.#agentModel, modelSettings: this.#agentModelSettings }
      : { model: new StructuredLlmAgentModel(this.#llm, reading) };
  }

  /**
   * A reply that code starts (a greeting, an approval result, an end, a re-planned move): the agent
   * words the brief through send_reply only. Any failure uses the checked fallback for the move.
   */
  async #speak(writes: Writer, d: Drafting, agent: Actor, event: string): Promise<{ text: string; question: string | null } | null> {
    const capture: { error: unknown } = { error: null };
    let worded: { text: string; question: string | null } | null = null;
    try {
      worded = await runNegotiator(this.#agentConfig(null), { sendReply: (draft) => this.#guard(capture, () => this.#review(writes, d, draft, agent)) }, [...historyItems(d.conversation), eventItem(event, d.brief)]);
    } catch {
      worded = null;
    }
    if (capture.error) throw capture.error;
    if (worded && worded.text) return worded;
    if (worded && !worded.text) return null;
    return d.attempts >= 2 ? null : this.#fallback(writes, d, agent);
  }

  /** Runs a tool body and keeps a record write failure, which must stop the turn rather than reach the model. */
  async #guard<T>(capture: { error: unknown }, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof WriteFailure) capture.error = error;
      throw error;
    }
  }

  /**
   * send_reply: check the agent's draft. Accepted wording ends the turn; a rejected draft goes back
   * with the reasons; after two rejected drafts the checked fallback is used. Nothing is relaxed.
   */
  async #review(writes: Writer, d: Drafting, draft: { text: string; question: string | null; skipQuestionBecause?: string | null }, agent: Actor): Promise<SendOutcome> {
    d.attempts += 1;
    const checked = await this.#checkDraft(writes, d, draft, agent);
    if (checked.ok) return { status: "accepted", text: checked.text, question: checked.question };
    if (d.attempts >= 2) {
      const fallback = await this.#fallback(writes, d, agent);
      return { status: "fallback", text: fallback?.text ?? "", question: fallback?.question ?? null };
    }
    // A draft that exposed something private never goes back to the model: only the reasons do.
    const exposed = checked.violations.some((v) => PRIVATE_RULES.has(v.rule));
    return {
      status: "rejected",
      problems: checked.violations.map((v) => (exposed ? v.detail.replace(/\s*\(".*"\)$/, "") : v.detail)),
      rejected_draft: exposed ? null : checked.draft,
    };
  }

  /**
   * The code checks and the reviewer on one draft. Two kinds of problem:
   * - hard limits (amounts, commitments, private content, the exact read-back, invented facts or claims):
   *   the draft is blocked and recorded, and the checked fallback is used if a rewrite still breaks one;
   * - style (an unasked question, a repeated sentence or opener, a fragment, a turn not answered): the
   *   writer is asked once for a better reply, and the rewrite is sent even if it still has them. Style
   *   never forces the template fallback; the conversation guide is what shapes it.
   */
  async #checkDraft(writes: Writer, d: Drafting, composed: { text: string; question: string | null; skipQuestionBecause?: string | null }, agent: Actor): Promise<{ ok: true; text: string; question: string | null } | { ok: false; violations: Array<{ rule: string; detail: string }>; draft: string }> {
    const { state, plan, conversation, currentMessage, subject, publicPrincipalName, publicTerms, previousReply } = d;
    const fail = async (text: string, violations: Array<{ rule: ReplyViolation["rule"]; detail: string }>, record = true) => {
      if (record) await this.#block(writes, text, violations, agent);
      return { ok: false as const, violations, draft: text };
    };
    const style: Array<{ rule: ReplyViolation["rule"]; detail: string }> = [];
    const styleRule = (detail: string) => style.push({ rule: "style", detail });
    let draft = clean(composed.text);
    if (!draft) return fail(composed.text, [{ rule: "action_mismatch", detail: "The reply was empty." }], false);
    let insertedTerms: string | null = null;
    let question = plan.ask?.text ?? null;
    if (plan.ask) {
      // The agent words the selected question itself; a single closing question in the text is the question.
      const lastSentence = draft.split(/(?<=[.!?])\s+/).at(-1);
      const embedded = lastSentence?.endsWith("?") && draft.indexOf("?") === draft.lastIndexOf("?") ? lastSentence : null;
      const separate = composed.question ? clean(composed.question) : null;
      const phrased = embedded ?? separate;
      if (phrased && /^[^?]+\?$/.test(phrased) && phrased.length <= 500 && (embedded || !draft.includes("?"))) question = phrased;
      // The writer may leave out a selected question the conversation already answers, saying why; it stays unasked.
      else if (!phrased && !draft.includes("?") && composed.skipQuestionBecause) question = null;
      else if (plan.ask.purpose || phrased || draft.includes("?")) {
        styleRule("The reply did not ask exactly one question for the selected objective.");
        question = null;
      }
    }
    if (question) draft = dropDuplicateInvitation(draft, question);
    if (previousReply && opener(draft) === opener(previousReply)) styleRule("The reply opened the same way as your previous reply. Open differently.");
    // While paused or ended, nothing that negotiates reaches them.
    if ((plan.notice === "paused" || plan.notice === "ended") && (findAmounts(draft).length > 0 || draft.includes("?"))) {
      return fail(draft, [{ rule: "action_mismatch", detail: `The conversation is ${plan.notice}: mention no amount, offer or question.` }]);
    }
    const exactTerms = plan.move === "state_final_terms" || plan.move === "confirm_agreement";
    const framing = draft.split(EXACT_TERMS_SLOT);
    if (exactTerms && plan.offer && framing.length === 2 && !findAmounts(framing.join(" ")).length && (plan.move !== "state_final_terms" || framing[1]!.includes("?") || /\bconfirm\b/i.test(framing[1]!))) {
      const terms = speakTerms(state.view, plan.offer.terms, this.#locale);
      const [before, after] = framing as [string, string];
      // Inside a sentence ("The agreed terms are ...") the subject is not capitalised.
      const midSentence = before.trim().length > 0 && !/[.!?:]\s*$/.test(before);
      const lead = subject && midSentence ? subject.charAt(0).toLowerCase() + subject.slice(1) : subject;
      insertedTerms = clean(lead ? `${lead}, ${terms}` : terms);
      // A comma continues the sentence; any other words after the terms start a new, capitalised one.
      const rest = after.trimStart();
      const ending = !rest || /^[.!?,;:]/.test(rest) ? after : `. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
      draft = clean(before + insertedTerms + ending);
      if (!/[.!?]["'”’)]?$/.test(draft)) draft = `${draft}.`;
    } else if (exactTerms || framing.length !== 1) {
      return fail(draft, [{ rule: "missing_condition", detail: "The reply did not leave one slot for the complete checked terms." }]);
    }
    if (question && !draft.includes(question)) {
      if (draft.includes("?")) {
        styleRule("The reply asked a different question from the selected move.");
        question = null;
      } else draft = `${draft} ${question}`;
    }
    // Checked on the words the other party will read, after the terms are in place.
    const repeated = repeatedSentence(insertedTerms ? draft.replace(insertedTerms, "") : draft, conversation);
    if (repeated) styleRule(`You already said "${repeated}". Say it in new words or leave it out.`);
    // A clarifying question the plan itself needs (a missing detail an offer depends on) is never a new question.
    if (!question && plan.clarify.length === 0 && (plan.action === "decline" || ["answer_public_terms", "explore_objection", "explain_price", "acknowledge_budget", "answer_enquiry", "price_pressure", "compare_terms"].includes(plan.move)) && draft.includes("?")) {
      styleRule("This move did not call for a new question.");
    }
    const ownWords = draft;
    if (plan.introduce) {
      const opening = draft.split(/(?<=[.!?])\s+/, 2).join(" ");
      if (!/\bkritva\b/i.test(opening)) draft = `${introduction(state.view, publicPrincipalName)} ${draft}`;
      else if (!quoteAppearsIn(opening, publicPrincipalName || principalLabel(state.view))) styleRule("The introduction must say whose assistant Kritva is, using who_you_represent.");
    }
    const wording = gateWording(state, plan, draft);
    if (wording.decision !== "allow") return fail(draft, wording.reasons.map((r) => ({ rule: r.rule as ReplyViolation["rule"], detail: r.detail })));
    if (ownWords.replace(/\p{Sc}?\s?[\d,]+(?:\.\d+)?/gu, " ").split(/\s+/).filter((w) => /\p{L}/u.test(w)).length < 4) {
      styleRule("Reply in a complete, friendly sentence that responds to what they said, not a bare amount or fragment.");
    }
    // The value they asked about belongs in the answer; a general terms question right after the price was said skips the price.
    const lastReply = [...conversation].reverse().find((m) => m.speaker === "agent")?.text ?? "";
    const priceJustSaid = state.currentAsk !== null && findAmounts(lastReply).includes(state.currentAsk);
    // The first time the price matters to the answer, they hear it.
    const priceNeverSaid = state.currentAsk !== null && !conversation.some((m) => m.speaker === "agent" && findAmounts(m.text).includes(state.currentAsk!));
    if (priceNeverSaid && ["answer_enquiry", "price_pressure", "explain_price", "compare_terms", "hold"].includes(plan.move) && !findAmounts(draft).includes(state.currentAsk!)) {
      styleRule("They have not heard the current price from you yet: tell them what it is.");
    }
    const answers = plan.publicTermAnswers ?? [];
    for (const answer of answers) {
      if (priceJustSaid && answers.length > 1 && answer.termId === state.view.negotiable?.termId) continue;
      const value = answer.value;
      const given = value.type === "money" ? findAmounts(draft).includes(value.amount as number) : (value.type === "text" || value.type === "date_text") ? normalizeForQuoteMatch(draft).includes(normalizeForQuoteMatch(value.value)) : true;
      if (!given) styleRule("Give the value they asked about.");
    }
    // A figure they gave (an offer, a budget, an amount they asked about) is acknowledged as theirs before ours.
    const theirFigure = plan.move === "counter" ? (plan.respondingTo ?? plan.statedBudget ?? plan.enquiredAmount) : undefined;
    if (theirFigure !== undefined && theirFigure !== null && !findAmounts(draft).includes(theirFigure)) {
      styleRule(`Acknowledge the figure they gave (${state.view.negotiable ? formatValue(numericValue(state.view.negotiable, theirFigure), this.#locale) : theirFigure}) as theirs before your offer.`);
    }
    const checkedTerms = (plan.offer?.terms ?? []).map((t) => `${state.space.terms.find((x) => x.termId === t.termId)?.name ?? t.termId}: ${formatValue(t.value, this.#locale)}`);
    const permittedFacts = [...state.view.publicFacts];
    // Every current public term is shared with the other party, so restating it is never an invented fact.
    for (const term of publicTerms) {
      const definition = state.view.terms.get(term.termId)!;
      permittedFacts.push(`Current public ${definition.name}: ${formatValue(term.value, this.#locale)}${definition.description ? ` (${definition.description})` : ""}`);
    }
    const arrangement = fulfillmentFact(state, publicTerms, this.#listingDetails.get(state.view.mandate.caseId)?.fulfillment, this.#locale);
    if (arrangement) permittedFacts.push(arrangement);
    permittedFacts.push(`Kritva is the assistant of ${publicPrincipalName || principalLabel(state.view)}.`);
    for (const answer of plan.publicTermAnswers ?? []) {
      const name = state.view.terms.get(answer.termId)!.name;
      permittedFacts.push(`${answer.basis === "opening" ? "Originally listed" : "Current public"} ${name}: ${formatValue(answer.value, this.#locale)}`);
    }
    const n = state.view.negotiable;
    if (n && state.currentAsk !== null && state.currentAsk !== n.opening) {
      permittedFacts.push(`The original public price was ${formatValue(numericValue(n, n.opening), this.#locale)}; ${formatValue(numericValue(n, state.currentAsk), this.#locale)} is the current offer to them, lowered from it.`);
    }
    if (plan.openForDiscussion) permittedFacts.push("The current terms are still open for discussion.");
    if (plan.move === "confirm_agreement") permittedFacts.push("With the agreement recorded, payment and handover are the remaining steps, to be arranged between the parties.");
    if (plan.move === "end_negotiation" && plan.end?.requestedBy === "principal") permittedFacts.push(`${publicPrincipalName || principalLabel(state.view)} decided not to go ahead; there is no agreement.`);
    if (plan.listingAvailable !== undefined) permittedFacts.push(`The listed subject is ${plan.listingAvailable ? "still available" : "no longer available"}.`);
    if (subject) permittedFacts.push(subject);
    const language = await languageCheck(this.#llm, {
      // The checker reviews generated words. The inserted terms already passed the structured gate and the final code check.
      reply: insertedTerms ? draft.replace(insertedTerms, EXACT_TERMS_SLOT) : draft,
      principal: publicPrincipalName || principalLabel(state.view),
      validatedTermsMarker: insertedTerms ? EXACT_TERMS_SLOT : undefined,
      checkedTerms,
      permittedFacts,
      declinedTerms: plan.declined.map((x) => state.space.terms.find((t) => t.termId === x.termId)?.name ?? x.termId),
      currentMessage,
      counterpartyWords: conversation.filter((c) => c.speaker === "counterparty").map((c) => c.text),
      publicAmounts: state.view.negotiable ? [...new Set(state.askHistory)].map((amount) => formatValue(numericValue(state.view.negotiable!, amount), this.#locale)) : [],
      statedBudget: plan.statedBudget !== undefined && state.view.negotiable ? formatValue(numericValue(state.view.negotiable, plan.statedBudget), this.#locale) : null,
      questionObjective: question ? (plan.ask?.purpose ?? null) : null,
      selectedQuestion: question,
      action: { move: plan.move, notice: plan.notice, opening: plan.opening === true, approvalGranted: plan.approvalGranted === true, outcome: state.outcome.kind },
    });
    if (!language.ok) return fail(draft, [{ rule: "language_unavailable" as ReplyViolation["rule"], detail: "The language check could not run, so the composed reply was not used." }]);
    const hard = language.concerns.filter((c) => !STYLE_CONCERNS.has(c.type));
    for (const c of language.concerns.filter((x) => STYLE_CONCERNS.has(x.type))) styleRule(`Language check: ${c.type.replace(/_/g, " ")} ("${c.quote.slice(0, 120)}")`);
    if (hard.length > 0) {
      return fail(draft, hard.map((c) => ({ rule: `language_${c.type}` as ReplyViolation["rule"], detail: `Language check: ${c.type.replace(/_/g, " ")} ("${c.quote.slice(0, 120)}")` })));
    }
    // Style is asked about once; a rewrite is sent as written.
    if (style.length > 0 && d.attempts < 2) return fail(draft, style, false);
    return { ok: true, text: draft, question };
  }

  /** Checked template wording for the planned move, built only from the plan and public content. */
  async #fallback(writes: Writer, d: Drafting, agent: Actor): Promise<{ text: string; question: string | null } | null> {
    const { state, plan, subject, publicPrincipalName, offerInvitedRecently, previousReply } = d;
    const priceJustSaid = state.currentAsk !== null && previousReply !== null && previousReply !== undefined && findAmounts(previousReply).includes(state.currentAsk);
    let fallback = templateReply(state.view, plan, this.#locale, subject, publicPrincipalName, { offerInvitedRecently, priceJustSaid });
    for (let shift = 1; previousReply && shift < 3 && (opener(fallback) === opener(previousReply) || repeatedSentence(fallback, d.conversation)); shift += 1) {
      fallback = templateReply(state.view, { ...plan, turnIndex: (plan.turnIndex ?? 0) + shift }, this.#locale, subject, publicPrincipalName, { offerInvitedRecently, priceJustSaid });
    }
    if (plan.ask && !fallback.includes(plan.ask.text)) fallback = `${fallback} ${plan.ask.text}`;
    const fallbackGate = gateWording(state, plan, fallback);
    if (fallbackGate.decision === "allow") return { text: fallback, question: plan.ask && fallback.includes(plan.ask.text) ? plan.ask.text : null };
    await this.#block(writes, fallback, fallbackGate.reasons.map((r) => ({ rule: r.rule as ReplyViolation["rule"], detail: r.detail })), agent);
    // Never leave the turn silent because one checked sentence failed: send the rest when it passes on its own.
    const sentences = fallback.split(/(?<=[.!?])\s+/);
    for (let i = 0; i < sentences.length && sentences.length > 1; i += 1) {
      const rest = sentences.filter((_, j) => j !== i).join(" ");
      if (gateWording(state, plan, rest).decision === "allow") return { text: rest, question: plan.ask && rest.includes(plan.ask.text) ? plan.ask.text : null };
    }
    return null;
  }

  /** Records an agent offer (with its previous version and tactic). With check: also its deal-space check. */
  async #recordOffer(writes: Writer, state: NegotiationState, offer: NonNullable<Plan["offer"]>, agent: Actor, check = true): Promise<string> {
    const hash = hashTerms(offer.terms);
    const event = await writes.put(
      { id: newEventId(), type: "offer_proposed", channel: null, payload: { byPartyId: state.view.principalId, basis: offer.basis, terms: offer.terms, termsHash: hash, previousOfferId: state.lastProposed?.offerId ?? null, tactic: offer.tactic ?? null } },
      agent,
    );
    if (check) await this.#recordCheck(writes, state, event.id, offer.terms, checkProposal(state.space, offer.terms), [], agent);
    return event.id;
  }

  /** The decision record: the action, the package assessment behind it, and what it was decided under. */
  #decisionPayload(plan: Plan, state: NegotiationState, related: string[], interp?: Interpretation) {
    return {
      kind: plan.decision.kind,
      reason: plan.decision.reason.slice(0, 500),
      relatedEventIds: related.slice(0, 20),
      action: plan.action ?? null,
      assessment: plan.assessment ? { verdict: plan.assessment.verdict, drivers: plan.assessment.drivers.map((d) => d.slice(0, 500)) } : null,
      mandateRevision: state.mandateRevision,
      guidance: this.guidanceFor(state.view.mandate.caseId).id,
      allowance: plan.allowance
        ? { earned: plan.allowance.earned, used: plan.allowance.used, remaining: plan.allowance.remaining, entries: plan.allowance.entries.slice(-30).map((e) => ({ offerId: e.offerId, kind: e.kind, commitment: e.commitment.slice(0, 500), earned: e.earned, used: e.used })) }
        : null,
      ...(interp ? { interpretation: { intent: interp.intent, offerKind: interp.offerKind ?? null, pressure: interp.pressure ?? null, priceConcern: interp.priceConcern ?? null, asksPrivateInfo: interp.asksPrivateInfo } } : {}),
    };
  }

  /** A guidance question (e.g. for "what's your lowest?"): prepared once, asked at most once. */
  async #strategyQuestion(writes: Writer, model: CounterpartyModel, q: NonNullable<Plan["strategyQuestion"]>, inboundId: string, agent: Actor): Promise<Plan["ask"]> {
    const issueKey = q.key ?? `strategy:${q.kind}`;
    const existing = model.questions.find((x) => x.issueKey === issueKey);
    if (existing) return existing.status === "open" ? { questionId: existing.id, text: existing.text, purpose: existing.purpose } : null;
    const prepared = await writes.put({ id: newEventId(), type: "question_prepared", channel: null, payload: { issueKey, issueKind: q.kind, purpose: q.purpose, text: q.text, relatedEventIds: [inboundId] } }, agent);
    return { questionId: prepared.id, text: q.text, purpose: q.purpose };
  }

  async #recordCheck(writes: Writer, state: NegotiationState, offerId: string, terms: OfferTerm[], check: DealCheck, requestedTermIds: string[], agent: Actor): Promise<RecordedEvent> {
    return writes.put(
      {
        id: newEventId(),
        type: "proposal_checked",
        channel: null,
        payload: {
          offerId,
          checkedTerms: terms,
          termsHash: hashTerms(terms),
          mandateRevision: state.mandateRevision,
          requestedTermIds,
          result: check.result,
          findings: check.findings.map((f) => ({ ...f, termId: f.basis === "new_term" && f.termId !== null && !state.space.terms.some((t) => t.termId === f.termId) ? null : f.termId, detail: f.detail.slice(0, 500) })),
        },
      },
      agent,
    );
  }

  /**
   * The principal changes the mandate. Earlier checks are never reused: the latest proposals
   * from both sides are checked again against the new revision, and a pending approval whose
   * terms no longer fit stops being pending.
   */
  reviseMandate(input: { sessionId: string; mandate: ConfirmedMandate; reason: string; draftId?: string | null; mandateSource?: { mandateId: string; revision: number } | null }): Promise<{ ok: true; state: NegotiationState; events: RecordedEvent[] } | TurnError> {
    // Not queued behind a running turn: a confirmed revision takes effect at once, and a turn in
    // flight re-reads authority before it sends anything.
    return (async () => {
      const before = projectState(await this.#record.context(input.sessionId));
      const principal: Actor = { kind: "principal", partyId: before.view.principalId };
      const agent: Actor = { kind: AGENT, partyId: before.view.principalId };
      const writes = new Writer(this.#record, input.sessionId);
      try {
        await writes.put({ id: newEventId(), type: "mandate_revised", channel: null, payload: { mandate: input.mandate, mandateRevision: before.mandateRevision + 1, mandateSource: input.mandateSource ?? null, reason: input.reason, draftId: input.draftId ?? null } }, principal);
        const after = projectState(await this.#record.context(input.sessionId));
        const rechecks: Array<{ offerId: string; terms: OfferTerm[] }> = [];
        if (after.lastProposed) rechecks.push({ offerId: after.lastProposed.offerId, terms: after.lastProposed.terms });
        if (after.lastCounterpartyCheck) rechecks.push({ offerId: after.lastCounterpartyCheck.offerId, terms: after.lastCounterpartyCheck.checkedTerms });
        const results = new Map<string, DealCheck>();
        for (const r of rechecks) {
          const check = checkProposal(after.space, r.terms);
          results.set(r.offerId, check);
          await this.#recordCheck(writes, after, r.offerId, r.terms, check, [], agent);
        }
        const pending = after.pendingApproval;
        if (after.status === "awaiting_approval" && pending) {
          const recheck = results.get(pending.offerId);
          const stillWaivable = recheck?.result === "conflicts" && pending.purpose === "exception" && recheck.findings.every((f) => f.status !== "conflict" || (f.ruleId !== null && after.view.authority.exceptionFor(f.ruleId) === "with_approval"));
          if (recheck?.result === "fits" || stillWaivable) {
            // The request was made under the old revision; ask again under the new one.
            await writes.put(
              { id: newEventId(), type: "approval_requested", channel: null, payload: { offerId: pending.offerId, termsHash: pending.termsHash, mandateRevision: after.mandateRevision, acceptanceId: pending.acceptanceId, purpose: pending.purpose, breachedRuleIds: stillWaivable ? recheck!.findings.filter((f) => f.status === "conflict").map((f) => f.ruleId!) : [], requestedAction: pending.requestedAction || "Approve these exact terms under the revised mandate." } },
              agent,
            );
          } else {
            await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: "awaiting_approval", to: "active", reason: "The mandate changed and the pending terms no longer fit it." } }, agent);
          }
        }
        return { ok: true as const, state: projectState(await this.#record.context(input.sessionId)), events: writes.created };
      } catch (error) {
        if (error instanceof WriteFailure) return { ok: false as const, code: error.code, message: error.message };
        throw error;
      }
    })();
  }

  async #block(writes: Writer, draftText: string, violations: ReplyViolation[], agent: Actor): Promise<void> {
    await writes.put({ id: newEventId(), type: "reply_blocked", channel: null, payload: { draftText, violations } }, agent);
  }

  /** The channel reports what it delivered. Only then does an offer count as communicated. */
  async reportDelivery(input: { sessionId: string; messageId: string; channel: Channel; status: "delivered" | "interrupted" | "failed"; deliveredText?: string | null; audioStartMs?: number | null }): Promise<RecordedEvent | TurnError> {
    const result = await this.#record.append(
      input.sessionId,
      { id: `delivery_${input.messageId}`, type: "delivery_reported", channel: input.channel, payload: { messageId: input.messageId, status: input.status, deliveredText: input.deliveredText ?? null, audioStartMs: input.audioStartMs ?? null } },
      { kind: "system", partyId: null },
    );
    if (!result.ok) return { ok: false, code: result.error.code === "write_failed" ? "write_failed" : "invalid_event", message: result.error.message };
    return result.event;
  }

  /**
   * Realtime voice: checks words the voice model said on its own (a conversation answer or a short
   * acknowledgement before a deal turn). Only public amounts, the counterparty's own figures and
   * amounts already offered may appear, and no agreement, approval or commitment may be claimed.
   */
  async checkVoiceWords(sessionId: string, text: string, theirWords = ""): Promise<ReplyViolation[]> {
    const ctx = await this.#record.context(sessionId);
    if (!ctx.mandate) return [];
    return voiceWordsViolations(projectState(ctx), text, findAmounts(theirWords));
  }

  /** Realtime voice: an acknowledgement spoken before a deal turn, kept as a transcript fragment (never a message). */
  async recordVoiceFragment(input: { sessionId: string; text: string; utteranceId: string }): Promise<RecordedEvent | TurnError> {
    const ctx = await this.#record.context(input.sessionId);
    if (!ctx.mandate) return { ok: false, code: "session_not_found", message: "The session does not exist." };
    const principalId = projectState(ctx).view.principalId;
    const result = await this.#record.append(
      input.sessionId,
      { id: newEventId(), type: "transcript_fragment", channel: "voice", payload: { utteranceId: input.utteranceId, speakerPartyId: principalId, text: input.text.slice(0, 10_000) } },
      { kind: AGENT, partyId: principalId },
    );
    if (!result.ok) return { ok: false, code: result.error.code === "write_failed" ? "write_failed" : "invalid_event", message: result.error.message };
    return result.event;
  }

  /**
   * Realtime voice: a conversation turn the voice model answered itself from public facts (a greeting,
   * small talk, a repeat, a listed detail). Recorded like any turn (their message, a decision, the
   * check and the reply as spoken) so the engine always sees the whole conversation. The reply was
   * already spoken, so a failed check is recorded as a block and returned for the caller to correct.
   */
  recordVoiceAnswer(input: { sessionId: string; buyerText: string; replyText: string; messageId: string; utteranceId?: string | null }): Promise<{ ok: true; violations: ReplyViolation[]; replyId: string } | TurnError> {
    return this.#serialize(input.sessionId, async () => {
      const ctx = await this.#record.context(input.sessionId);
      if (!ctx.mandate) return { ok: false, code: "session_not_found", message: "The session does not exist." };
      const state = projectState(ctx);
      const counterparty: Actor = { kind: "counterparty", partyId: state.view.counterpartyId };
      const agent: Actor = { kind: AGENT, partyId: state.view.principalId };
      const writes = new Writer(this.#record, input.sessionId);
      try {
        const inbound = await writes.put(
          { id: input.messageId, type: "message", channel: "voice", payload: { direction: "inbound", speakerPartyId: state.view.counterpartyId, text: input.buyerText.slice(0, 2_000), utteranceId: input.utteranceId ?? null, offerIds: [] } },
          counterparty,
        );
        const violations = voiceWordsViolations(state, input.replyText);
        const plan = basePlan("answer", { kind: "answer", reason: "Answered in conversation by the voice agent from public facts." }, null);
        await writes.put({ id: newEventId(), type: "decision", channel: null, payload: { kind: "answer", reason: plan.decision.reason, relatedEventIds: [inbound.id], action: "answer", assessment: null, mandateRevision: state.mandateRevision, guidance: this.guidanceFor(state.view.mandate.caseId).id } }, agent);
        await this.#recordGate(writes, plan, { decision: violations.length ? "block" : "allow", reasons: violations.map((v) => ({ rule: v.rule, detail: v.detail })), mandateRevision: state.mandateRevision, termsHash: null, breachedRuleIds: [] }, "send", null, agent);
        const reply = await writes.put({ id: newEventId(), type: "message", channel: "voice", payload: { direction: "outbound", speakerPartyId: state.view.principalId, text: input.replyText.slice(0, 10_000), utteranceId: null, offerIds: [] } }, agent);
        return { ok: true, violations, replyId: reply.id };
      } catch (error) {
        if (error instanceof WriteFailure) return { ok: false, code: error.code, message: error.message };
        throw error;
      }
    });
  }

  /** Realtime voice: a short reply the engine already checked elsewhere (a correction line), recorded as spoken. */
  recordVoiceLine(input: { sessionId: string; text: string; reason: string }): Promise<{ ok: true; replyId: string } | TurnError> {
    return this.#serialize(input.sessionId, async () => {
      const ctx = await this.#record.context(input.sessionId);
      if (!ctx.mandate) return { ok: false, code: "session_not_found", message: "The session does not exist." };
      const state = projectState(ctx);
      const agent: Actor = { kind: AGENT, partyId: state.view.principalId };
      const writes = new Writer(this.#record, input.sessionId);
      try {
        const violations = voiceWordsViolations(state, input.text);
        if (violations.length) return { ok: false, code: "invalid_event", message: "The line did not pass the outgoing check." };
        const plan = basePlan("answer", { kind: "answer", reason: input.reason }, null);
        await writes.put({ id: newEventId(), type: "decision", channel: null, payload: { kind: "answer", reason: input.reason, relatedEventIds: [], action: "answer", assessment: null, mandateRevision: state.mandateRevision, guidance: this.guidanceFor(state.view.mandate.caseId).id } }, agent);
        await this.#recordGate(writes, plan, { decision: "allow", reasons: [], mandateRevision: state.mandateRevision, termsHash: null, breachedRuleIds: [] }, "send", null, agent);
        const reply = await writes.put({ id: newEventId(), type: "message", channel: "voice", payload: { direction: "outbound", speakerPartyId: state.view.principalId, text: input.text, utteranceId: null, offerIds: [] } }, agent);
        return { ok: true, replyId: reply.id };
      } catch (error) {
        if (error instanceof WriteFailure) return { ok: false, code: error.code, message: error.message };
        throw error;
      }
    });
  }

  /** The principal answers a pending approval request. Identity comes from the calling route. */
  respondToApproval(input: { sessionId: string; requestId: string; decision: "approved" | "rejected"; note?: string | null; channel?: Channel; expected?: { offerId?: string | null; mandateRevision?: number | null } }): Promise<TurnResult | TurnError> {
    return this.#serialize(input.sessionId, async () => {
      const started = performance.now();
      const state = projectState(await this.#record.context(input.sessionId));
      if (state.status === "paused") return { ok: false, code: "not_pending", message: "Resume the negotiation before answering approvals." };
      const pending = state.pendingApproval;
      if (!pending || pending.requestId !== input.requestId) {
        return { ok: false, code: "not_pending", message: "That approval request is no longer pending." };
      }
      // The decision applies only to the exact offer version and mandate revision the principal saw.
      if ((input.expected?.offerId && input.expected.offerId !== pending.offerId) || (input.expected?.mandateRevision && input.expected.mandateRevision !== state.mandateRevision)) {
        return { ok: false, code: "not_pending", message: "The terms or instructions changed since you opened this request. Review the current request." };
      }
      const principal: Actor = { kind: "principal", partyId: state.view.principalId };
      const agent: Actor = { kind: AGENT, partyId: state.view.principalId };
      const writes = new Writer(this.#record, input.sessionId);
      const channel = input.channel ?? lastChannel(await this.#record.read(input.sessionId, { viewer: "operator" }));
      try {
        // The decision is saved before it can affect anything.
        const response = await writes.put(
          { id: newEventId(), type: "approval_responded", channel: null, payload: { requestId: pending.requestId, offerId: pending.offerId, termsHash: pending.termsHash, mandateRevision: state.mandateRevision, decision: input.decision, note: input.note ?? null } },
          principal,
        );
        const ctx = await this.#record.context(input.sessionId);
        const terms = ctx.offerTerms(pending.offerId)!.terms;
        let plan: Plan;
        if (input.decision === "approved" && pending.acceptanceId) {
          await writes.put(
            { id: newEventId(), type: "agreement_recorded", channel: null, payload: { offerId: pending.offerId, terms, termsHash: pending.termsHash, mandateRevision: state.mandateRevision, acceptanceId: pending.acceptanceId, approvalId: response.id } },
            agent,
          );
          await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: state.status, to: "agreed", reason: "The principal approved the accepted terms." } }, agent);
          plan = basePlan("confirm_agreement", { kind: "record_agreement", reason: "Principal approved the terms the counterparty accepted." }, { terms, basis: "final_terms" });
          plan.action = "accept";
          plan.approvalGranted = true;
        } else if (input.decision === "approved") {
          // A one-off exception: these exact terms may now be offered. The standing mandate is unchanged.
          await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: state.status, to: "active", reason: "The principal approved an exception for these exact terms." } }, agent);
          plan = basePlan("state_final_terms", { kind: "state_final_terms", reason: "Principal approved the exception; state the approved terms for confirmation." }, { terms, basis: "final_terms" });
          plan.action = "propose";
        } else {
          await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: state.status, to: "active", reason: "The principal did not approve the terms." } }, agent);
          const fallbackAsk = previousAsk(state, pending.offerId);
          plan = basePlan("hold", { kind: "reject_offer", reason: "Principal rejected the terms; return to the previous ask." }, fallbackAsk ? { terms: fallbackAsk, basis: "counter" } : null);
          plan.notice = "approval_rejected";
          plan.action = "counter";
        }
        await writes.put({ id: newEventId(), type: "decision", channel: null, payload: this.#decisionPayload(plan, state, [response.id]) }, agent);

        const after = projectState(await this.#record.context(input.sessionId));
        const offerIds: string[] = [];
        if (plan.move === "state_final_terms") {
          // The approved terms still go through the gate: the exception clears only its named rules.
          const gate = gateTerms(after, plan, after.mandateRevision);
          await this.#recordGate(writes, plan, gate, "terms", pending.offerId, agent);
          if (gate.decision !== "allow") {
            plan = basePlan("answer", { kind: "hold", reason: "The approved terms no longer pass the gate." }, null);
            plan.notice = "check_with_principal";
          } else {
            offerIds.push(pending.offerId);
          }
        } else if (plan.move === "hold" && plan.offer) {
          offerIds.push(await this.#recordOffer(writes, after, plan.offer, agent));
        }
        const conversation = await this.#conversation(input.sessionId, null);
        const event = input.decision === "approved" ? "The person you represent approved the request." : "The person you represent did not approve the request.";
        const text = (await this.#speak(writes, this.#drafting(after, plan, conversation, null, channel), agent, event))?.text ?? null;
        const current = projectState(await this.#record.context(input.sessionId));
        let reply: TurnResult["reply"] = null;
        if (text !== null && current.mandateRevision === after.mandateRevision && current.status !== "paused") {
          await this.#recordGate(writes, plan, { decision: "allow", reasons: [], mandateRevision: after.mandateRevision, termsHash: plan.offer ? hashTerms(plan.offer.terms) : null, breachedRuleIds: [] }, "send", offerIds[0] ?? null, agent);
          const sent = await writes.put({ id: newEventId(), type: "message", channel, payload: { direction: "outbound", speakerPartyId: after.view.principalId, text, utteranceId: null, offerIds } }, agent);
          reply = { messageId: sent.id, text, offerIds, channel };
        }
        return {
          ok: true,
          reply,
          events: writes.created,
          state: projectState(await this.#record.context(input.sessionId)),
          timings: { interpretMs: 0, composeMs: 0, totalMs: Math.round(performance.now() - started) },
        };
      } catch (error) {
        if (error instanceof WriteFailure) return { ok: false, code: error.code, message: error.message };
        throw error;
      }
    });
  }

  /** The principal pauses or resumes. While paused, no negotiation content reaches the counterparty. */
  async setPaused(input: { sessionId: string; paused: boolean }): Promise<{ ok: true; state: NegotiationState } | TurnError> {
    const state = projectState(await this.#record.context(input.sessionId));
    const principal: Actor = { kind: "principal", partyId: state.view.principalId };
    if (input.paused === (state.status === "paused")) return { ok: true, state };
    if (state.status === "agreed" || state.status === "ended" || state.status === "no_agreement") return { ok: false, code: "not_pending", message: "The negotiation has finished." };
    const to = input.paused ? "paused" : (state.statusBeforePause ?? "active");
    const result = await this.#record.append(
      input.sessionId,
      { id: newEventId(), type: "status_changed", channel: null, payload: { from: state.status, to, reason: input.paused ? "The principal paused the negotiation." : "The principal resumed the negotiation." } },
      principal,
    );
    if (!result.ok) return { ok: false, code: result.error.code === "write_failed" ? "write_failed" : "invalid_event", message: result.error.message };
    return { ok: true, state: projectState(await this.#record.context(input.sessionId)) };
  }

  /**
   * The principal ends the negotiation without agreement. Records who stopped and why, what was
   * left open, and tells the counterparty plainly. An agreement already recorded cannot be undone.
   */
  endNegotiation(input: { sessionId: string; reason?: string | null; channel?: Channel }): Promise<TurnResult | TurnError> {
    return this.#serialize(input.sessionId, async () => {
      const started = performance.now();
      const state = projectState(await this.#record.context(input.sessionId));
      if (state.status === "agreed" || state.status === "no_agreement" || state.status === "ended") return { ok: false, code: "not_pending", message: "The negotiation has already finished." };
      const principal: Actor = { kind: "principal", partyId: state.view.principalId };
      const agent: Actor = { kind: AGENT, partyId: state.view.principalId };
      const writes = new Writer(this.#record, input.sessionId);
      const channel = input.channel ?? lastChannel(await this.#record.read(input.sessionId, { viewer: "operator" }));
      const reason = (input.reason?.trim() || "The principal ended the negotiation.").slice(0, 500);
      const open = new Set<string>();
      if (state.view.negotiable) open.add(state.view.negotiable.name);
      for (const r of state.requestedTerms) open.add(r.name);
      try {
        const plan = basePlan("end_negotiation", { kind: "end", reason }, null);
        plan.action = "end";
        plan.end = { requestedBy: "principal", reason, unresolved: [...open].slice(0, 10), line: null };
        await writes.put({ id: newEventId(), type: "decision", channel: null, payload: this.#decisionPayload(plan, state, []) }, agent);
        await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: state.status, to: "no_agreement", reason, requestedBy: "principal", unresolved: plan.end.unresolved } }, principal);
        const conversation = await this.#conversation(input.sessionId, null);
        const text = (await this.#speak(writes, this.#drafting(state, plan, conversation, null, channel), agent, "The person you represent decided to end the negotiation without agreement."))?.text ?? null;
        let reply: TurnResult["reply"] = null;
        if (text !== null) {
          await this.#recordGate(writes, plan, { decision: "allow", reasons: [], mandateRevision: state.mandateRevision, termsHash: null, breachedRuleIds: [] }, "send", null, agent);
          const sent = await writes.put({ id: newEventId(), type: "message", channel, payload: { direction: "outbound", speakerPartyId: state.view.principalId, text, utteranceId: null, offerIds: [] } }, agent);
          reply = { messageId: sent.id, text, offerIds: [], channel };
        }
        return {
          ok: true,
          reply,
          events: writes.created,
          state: projectState(await this.#record.context(input.sessionId)),
          timings: { interpretMs: 0, composeMs: 0, totalMs: Math.round(performance.now() - started) },
        };
      } catch (error) {
        if (error instanceof WriteFailure) return { ok: false, code: error.code, message: error.message };
        throw error;
      }
    });
  }

  /**
   * Kritva's opening line when a conversation starts (for example a voice call): it introduces
   * itself once as the principal's assistant and invites the counterparty to speak.
   * If Kritva has already spoken in this session, nothing is sent.
   */
  greet(input: { sessionId: string; channel: Channel }): Promise<{ ok: true; reply: TurnResult["reply"] } | TurnError> {
    return this.#serialize(input.sessionId, async () => {
      const ctx = await this.#record.context(input.sessionId);
      if (!ctx.mandate) return { ok: false, code: "session_not_found", message: "The session does not exist." };
      const state = projectState(ctx);
      if (outboundCount(ctx) > 0) return { ok: true, reply: null };
      if (state.status !== "active") return { ok: false, code: "not_pending", message: "This negotiation is not active." };
      const agent: Actor = { kind: AGENT, partyId: state.view.principalId };
      const plan = basePlan("answer", { kind: "answer", reason: "Introduce Kritva at the start of the conversation." }, null);
      plan.introduce = true;
      plan.opening = true;
      const writes = new Writer(this.#record, input.sessionId);
      try {
        const text = (await this.#speak(writes, this.#drafting(state, plan, [], null, input.channel), agent, "A conversation is starting. Nobody has spoken yet."))?.text ?? null;
        if (text === null) return { ok: false, code: "invalid_event", message: "The greeting did not pass the outgoing check." };
        const current = projectState(await this.#record.context(input.sessionId));
        if (current.status !== "active" || current.mandateRevision !== state.mandateRevision) return { ok: false, code: "not_pending", message: "The negotiation changed before the greeting was ready." };
        await writes.put({ id: newEventId(), type: "decision", channel: null, payload: { kind: "answer", reason: plan.decision.reason, relatedEventIds: [], action: "answer", assessment: null, mandateRevision: state.mandateRevision, guidance: this.guidanceFor(state.view.mandate.caseId).id } }, agent);
        await this.#recordGate(writes, plan, { decision: "allow", reasons: [], mandateRevision: state.mandateRevision, termsHash: null, breachedRuleIds: [] }, "send", null, agent);
        const reply = await writes.put({ id: newEventId(), type: "message", channel: input.channel, payload: { direction: "outbound", speakerPartyId: state.view.principalId, text, utteranceId: null, offerIds: [] } }, agent);
        return { ok: true, reply: { messageId: reply.id, text, offerIds: [], channel: input.channel } };
      } catch (error) {
        if (error instanceof WriteFailure) return { ok: false, code: error.code, message: error.message };
        throw error;
      }
    });
  }

  /** A retried message returns the turn that was already recorded for it. */
  async #replay(sessionId: string, inbound: RecordedEvent, started: number): Promise<TurnResult> {
    const events = await this.#record.read(sessionId, { viewer: "operator" });
    const after = events.filter((e) => e.seq > inbound.seq);
    const nextInbound = after.find((e) => e.type === "message" && (e.payload as { direction: string }).direction === "inbound");
    const turn = nextInbound ? after.filter((e) => e.seq < nextInbound.seq) : after;
    const reply = turn.find((e) => e.type === "message" && (e.payload as { direction: string }).direction === "outbound");
    const p = reply?.payload as { text: string; offerIds: string[] } | undefined;
    return {
      ok: true,
      reply: reply && p ? { messageId: reply.id, text: p.text, offerIds: p.offerIds, channel: reply.channel ?? "text" } : null,
      events: [],
      state: projectState(await this.#record.context(sessionId)),
      timings: { interpretMs: 0, composeMs: 0, totalMs: Math.round(performance.now() - started) },
    };
  }

  async #conversation(sessionId: string, excludeId: string | null): Promise<Conversation> {
    const events = await this.#record.read(sessionId, { viewer: "counterparty" });
    return events
      .filter((e) => e.type === "message" && e.id !== excludeId)
      .map((e) => {
        const p = e.payload as { direction: string; text: string };
        return { speaker: p.direction === "inbound" ? ("counterparty" as const) : ("agent" as const), text: p.text };
      });
  }
}

type Conversation = Array<{ speaker: "agent" | "counterparty"; text: string }>;

/** Everything one reply's wording depends on, and how many drafts the agent has proposed for it. */
interface Drafting {
  state: NegotiationState;
  plan: Plan;
  conversation: Conversation;
  currentMessage: string | null;
  subject: string | null;
  publicPrincipalName: string | undefined;
  publicTerms: OfferTerm[];
  offerInvitedRecently: boolean;
  previousReply: string | null;
  brief: Record<string, unknown>;
  attempts: number;
}

/** A move code has decided and recorded, waiting for its wording. */
interface Planned {
  plan: Plan;
  state: NegotiationState;
  prepared: number;
  offerIds: string[];
  /** An exception request: only the holding message is sent. */
  exception: boolean;
  drafting: Drafting;
}

interface ActContext {
  sessionId: string;
  channel: Channel;
  agent: Actor;
  interp: Interpretation;
  inboundId: string;
  related: string[];
  conversation: Conversation;
  currentMessage: string;
  rephrase: boolean;
  language?: string | null;
}

/** Placeholder until strategy (Epic 8): ask at most one never-asked question, only while holding or answering. */
function selectQuestion(fresh: Array<NonNullable<Plan["ask"]>>, plan: Plan): Plan["ask"] {
  if (plan.move !== "hold" && plan.move !== "answer") return null;
  if (plan.strategyQuestion || plan.declined.length > 0) return null;
  if (plan.notice || plan.clarify.length > 0 || plan.unresolved.length > 0 || plan.questions.length > 0 || plan.refuseDisclosure || plan.openForDiscussion || plan.listingAvailable !== undefined) return null;
  return fresh[0] ?? null;
}

/** Reviewer findings about conversation quality, not limits: asked about once, never a reason for the fallback. */
const STYLE_CONCERNS = new Set(["turn_mismatch", "redundant_question"]);

/** Block reasons whose draft carried private content. */
const PRIVATE_RULES = new Set<string>(["private_amount", "private_text", "crosses_limit", "language_private_disclosure"]);

const OFFER_INVITATION = /\b(?:firm offer|make (?:me )?an offer|send (?:me )?an offer|an offer you(?:'d| would) like)\b/i;

/** "You can make a firm offer." followed by "Would you make a firm offer?" says the same thing twice. */
export function dropDuplicateInvitation(text: string, question: string): string {
  if (!OFFER_INVITATION.test(question)) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => sentence.includes(question) || sentence.endsWith("?") || !OFFER_INVITATION.test(sentence));
  return kept.length === sentences.length || kept.length === 0 ? text : kept.join(" ");
}

/** Removes invitation sentences; null when nothing else would be left. */
function dropInvitations(text: string): string | null {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => !OFFER_INVITATION.test(sentence));
  return kept.length === 0 ? null : kept.join(" ");
}

/** The agent invited an offer in one of its last two replies. */
export function invitedOfferRecently(conversation: Array<{ speaker: "agent" | "counterparty"; text: string }>): boolean {
  return conversation.filter((c) => c.speaker === "agent").slice(-2).some((c) => OFFER_INVITATION.test(c.text));
}

/** Who performs the fulfillment actions under the current public terms, in the host's own words. */
function fulfillmentFact(state: NegotiationState, publicTerms: OfferTerm[], terms: FulfillmentTerms | undefined, locale: string): string | null {
  if (!terms) return null;
  const responsibility = publicTerms.find((t) => t.termId === terms.responsibilityTermId)?.value;
  const location = publicTerms.find((t) => t.termId === terms.counterpartyLocationTermId)?.value;
  if (responsibility?.type !== "boolean") return null;
  const role = state.view.mandate.parties.find((p) => p.id === state.view.counterpartyId)?.role ?? "other party";
  if (responsibility.value) return `The represented side handles: ${terms.principalActions.join(", ")}.`;
  return `The ${role} handles: ${terms.counterpartyActions.join(", ")}${location ? `, at ${formatValue(location, locale)}` : ""}. The represented side does not ${terms.principalActions[0] ?? "perform it"}.`;
}

/** Kritva has already introduced itself in this session. */
function alreadyIntroduced(ctx: { events: RecordedEvent[] }): boolean {
  return ctx.events.some((e) => e.type === "message" && (e.payload as { direction: string; text: string }).direction === "outbound" && /\bKritva\b/.test((e.payload as { text: string }).text));
}

/** A sentence of four words or more that Kritva already said in this conversation, if the draft repeats one. */
function repeatedSentence(draft: string, conversation: Conversation): string | null {
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\p{Sc} ]+/gu, "").replace(/\s+/g, " ").trim();
  const said = new Set(conversation.filter((c) => c.speaker === "agent").flatMap((c) => c.text.split(/(?<=[.!?])\s+/).map(key)));
  return draft.split(/(?<=[.!?])\s+/).find((s) => key(s).split(" ").length >= 4 && said.has(key(s))) ?? null;
}

/** The first few words of a reply, ignoring the one-time introduction. */
function opener(text: string): string {
  return text.replace(/^Hi, I'm Kritva[^.]*\.\s*/, "").toLowerCase().split(/\s+/).slice(0, 3).join(" ");
}

/** Replies the agent has already sent in this session. */
function outboundCount(ctx: { events: RecordedEvent[] }): number {
  return ctx.events.filter((e) => e.type === "message" && (e.payload as { direction: string }).direction === "outbound").length;
}

/** True when this inbound message already has a recorded failed read (so a retry does not record it twice). */
function existingFailure(events: RecordedEvent[], inboundSeq: number): boolean {
  return events.some((e) => e.seq > inboundSeq && e.type === "counterparty_noted" && (e.payload as { failed: boolean }).failed);
}

/** The counterparty's latest offer, so a new one is recorded as its next version. */
function lastCounterpartyOfferId(ctx: { events: RecordedEvent[] }, kind: Interpretation["offerKind"]): string | null {
  return ctx.events.findLast((event) => event.type === "offer_extracted" && ((event.payload as PayloadOf<"offer_extracted">).kind ?? "offer") === kind)?.id ?? null;
}

function emptyInterpretation(): Interpretation {
  return { intent: "other", offerTerms: [], acceptsStatedTerms: false, asksPrivateInfo: false, claimsAuthority: false, questions: [], newTerms: [] };
}

/** Details the counterparty could supply to settle a gate that needs clarification. */
function clarifyNames(state: NegotiationState, plan: Plan): string[] {
  if (!plan.offer) return [];
  const names: string[] = [];
  for (const f of checkProposal(state.space, plan.offer.terms).findings) {
    if (f.status === "needs_clarification" && f.basis === "condition" && f.relatedTermId) {
      const name = state.space.terms.find((t) => t.termId === f.relatedTermId)?.name;
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

class WriteFailure extends Error {
  readonly code: "invalid_event" | "write_failed";
  constructor(code: "invalid_event" | "write_failed", message: string) {
    super(message);
    this.code = code;
  }
}

/** Appends events for one turn and stops the turn at the first rejected or failed write. */
class Writer {
  readonly created: RecordedEvent[] = [];
  readonly #record: NegotiationRecord;
  readonly #sessionId: string;
  constructor(record: NegotiationRecord, sessionId: string) {
    this.#record = record;
    this.#sessionId = sessionId;
  }
  async put(event: NewEvent, actor: Actor): Promise<RecordedEvent> {
    const result = await this.#record.append(this.#sessionId, event, actor);
    if (!result.ok) {
      const detail = result.error.errors.map((e) => `${e.path}: ${e.reason}`).join("; ");
      throw new WriteFailure(result.error.code === "write_failed" ? "write_failed" : "invalid_event", `${event.type} rejected: ${detail || result.error.message}`);
    }
    if (result.created) this.created.push(result.event);
    return result.event;
  }
}

/**
 * Words the realtime voice model said itself: public amounts, the counterparty's own figures and
 * amounts already offered to them are allowed; anything else, and any agreement, approval or
 * commitment claim, is a violation.
 */
function voiceWordsViolations(state: NegotiationState, text: string, theirAmounts: number[] = []): ReplyViolation[] {
  const plan = basePlan("answer", { kind: "answer", reason: "Voice model's own words." }, null);
  return checkReply(text, { view: state.view, plan, counterpartyAmounts: [...state.counterpartyAmounts, ...state.askHistory, ...theirAmounts] });
}

function basePlan(move: Plan["move"], decision: Plan["decision"], offer: Plan["offer"]): Plan {
  return { move, decision, offer, acceptanceOf: null, declined: [], refuseDisclosure: false, ignoreAuthorityClaim: false, questions: [], respondingTo: null, notice: null, clarify: [], unresolved: [], ask: null };
}

/**
 * The counterparty's proposal as a whole: their terms placed on the agent's current
 * package (so unchanged terms keep the agent's values), checked against the deal space.
 */
function counterpartyDeal(state: NegotiationState, interp: Interpretation): DealInput {
  let pkg = publicDealTerms(state);
  for (const t of interp.offerTerms) pkg = withTerm(pkg, t.termId, t.value);
  return { package: pkg, check: checkProposal(state.space, pkg, interp.newTerms.map((t) => ({ name: t.name, value: t.value }))) };
}

/** The agent's last ask before the rejected terms. Null when there is nothing earlier to return to. */
function previousAsk(state: NegotiationState, rejectedOfferId: string): OfferTerm[] | null {
  const n = state.view.negotiable;
  if (!n) return null;
  const rejected = state.lastProposed?.offerId === rejectedOfferId ? state.lastProposed : null;
  const rejectedTerm = rejected?.terms.find((t) => t.termId === n.termId);
  const rejectedAmount = rejectedTerm && "amount" in rejectedTerm.value ? (rejectedTerm.value.amount as number) : null;
  const earlier = [...state.askHistory].reverse().find((a) => a !== rejectedAmount);
  if (earlier === undefined) return null;
  return withTerm(state.view.defaultPackage, n.termId, numericValue(n, earlier));
}

function lastChannel(events: RecordedEvent[]): Channel {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type === "message" && e.channel) return e.channel;
  }
  return "text";
}
