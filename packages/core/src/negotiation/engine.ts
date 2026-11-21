/**
 * The negotiation turn engine. One path serves the chat page, the scenario script and,
 * later, voice: record the counterparty's message, interpret it, decide, word the reply,
 * check it in code, and record every step in the shared record.
 *
 * Every decision reads recorded state. A reply that fails the outgoing check is blocked,
 * recorded, and replaced by checked template wording.
 */
import type { StructuredLlm } from "../llm/types.ts";
import { hashTerms, type Actor, type Channel, type NewEvent, type OfferTerm, type RecordedEvent } from "../record/events.ts";
import { newEventId, type NegotiationRecord } from "../record/store.ts";
import { composeReply } from "./compose.ts";
import { interpretMessage } from "./interpret.ts";
import { formatValue, numericValue, withTerm } from "./mandate-view.ts";
import { checkProposal, type DealCheck } from "../dealspace/check.ts";
import type { ConfirmedMandate } from "../schema/records.ts";
import { projectCounterparty, type CounterpartyModel } from "../counterparty/model.ts";
import { prepareQuestions } from "../counterparty/questions.ts";
import { gateTerms, gateWording, type GateResult } from "../governance/gate.ts";
import { quoteAppearsIn } from "../schema/quotes.ts";
import { languageCheck } from "../governance/language-check.ts";
import { decide, type DealInput, type Interpretation, type Plan } from "./policy.ts";
import { checkReply, type ReplyViolation } from "./reply-check.ts";
import { approvedFor, projectState, type NegotiationState } from "./state.ts";
import { MINIMAL_GUIDANCE, type StrategyGuidance } from "../strategy/guidance.ts";
import { templateReply } from "./templates.ts";

export interface EngineOptions {
  record: NegotiationRecord;
  llm: StructuredLlm;
  /** Formatting locale from the host application, e.g. for currency display. */
  locale: string;
  /** Tactic parameters from a strategy document. Never overrides the mandate or governance. */
  guidance?: StrategyGuidance;
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
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: EngineOptions) {
    this.#record = options.record;
    this.#llm = options.llm;
    this.#locale = options.locale;
    this.#guidance = options.guidance ?? MINIMAL_GUIDANCE;
  }

  get guidance(): StrategyGuidance {
    return this.#guidance;
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

  /** Handles one completed counterparty turn (a typed message or a final voice transcript). */
  handleCounterpartyMessage(input: {
    sessionId: string;
    text: string;
    channel: Channel;
    /** Client-supplied ID makes retries safe: a repeated message is not processed twice. */
    messageId?: string;
    utteranceId?: string | null;
  }): Promise<TurnResult | TurnError> {
    return this.#serialize(input.sessionId, () => this.#counterpartyTurn(input));
  }

  async #counterpartyTurn(input: { sessionId: string; text: string; channel: Channel; messageId?: string; utteranceId?: string | null }): Promise<TurnResult | TurnError> {
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
    let existingOfferId: string | null = null;
    if (!inbound.created) {
      // A retry. If the turn finished, return it. If it was cut off before any commitment
      // (offer, acceptance, approval, agreement), resume it; otherwise return what was recorded.
      const after = (await this.#record.read(sessionId, { viewer: "operator" })).filter((e) => e.seq > inbound.event.seq);
      // A turn whose message could not be read (recorded as a failed read) is resumed too.
      const resumable = after.every((e) => e.type === "offer_extracted" || e.type === "decision" || e.type === "question_prepared" || (e.type === "counterparty_noted" && (e.payload as { failed: boolean }).failed));
      if (!resumable || after.some((e) => e.type === "message")) return this.#replay(sessionId, inbound.event, started);
      existingOfferId = after.find((e) => e.type === "offer_extracted")?.id ?? null;
    } else {
      writes.created.push(inbound.event);
    }

    try {
      const conversation = await this.#conversation(sessionId, inbound.event.id);
      const interpretStarted = performance.now();
      let interp: Interpretation;
      let rephrase = false;
      try {
        const openQuestions = projectCounterparty(await this.#record.context(sessionId), before.view.negotiable?.termId ?? null)
          .questions.filter((q) => q.status === "asked" || q.status === "partial")
          .map((q) => ({ id: q.id, text: q.text }));
        interp = await interpretMessage(this.#llm, { view: before.view, lastStated: before.pendingFinal ?? before.lastProposed, conversation, message: input.text, locale: this.#locale, openQuestions });
      } catch {
        // The message could not be read. Record that for the operator, keep the session as it was and
        // send nothing: no guessed reply, no offer. Retrying the same message ID resumes this turn.
        interp = emptyInterpretation();
        if (!existingFailure(await this.#record.read(sessionId, { viewer: "operator" }), inbound.event.seq)) {
          await this.#recordCounterparty(writes, { sessionId, inboundId: inbound.event.id, text: input.text, interp, failed: true, agent, counterpartyId });
        }
        return { ok: false, code: "model_unavailable", message: "Kritva couldn't read that message just now. Nothing was sent. Try again." };
      }
      const interpretMs = Math.round(performance.now() - interpretStarted);

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
      if (n && awaitingDetail && !interp.offerTerms.some((t) => t.termId === n.termId) && interp.offerTerms.length > 0) {
        const earlier = before.lastCounterpartyCheck!.checkedTerms.find((t) => t.termId === n.termId);
        if (earlier) interp.offerTerms = [...interp.offerTerms, earlier];
      }

      const related: string[] = [inbound.event.id];
      let offerExtractedId: string | null = existingOfferId;
      if (existingOfferId) {
        related.push(existingOfferId);
      } else if (interp.offerTerms.length > 0) {
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
              kind: interp.offerKind ?? "offer",
              previousOfferId: lastCounterpartyOfferId(await this.#record.context(sessionId)),
              conditions: interp.offerConditions ?? [],
              correctsPrevious: interp.correctsPrevious === true && lastCounterpartyOfferId(await this.#record.context(sessionId)) !== null,
            },
          },
          agent,
        );
        offerExtractedId = offer.id;
        related.push(offer.id);
      }
      // Requests the mandate does not cover are recorded as the counterparty's, never as the principal's terms.
      const requestedIds: string[] = [];
      for (const t of interp.newTerms) {
        const requested = await writes.put(
          { id: newEventId(), type: "term_requested", channel: null, payload: { sourceMessageId: inbound.event.id, byPartyId: counterpartyId, name: t.name, description: t.description, value: t.value } },
          agent,
        );
        requestedIds.push(requested.id);
        related.push(requested.id);
      }

      await this.#recordCounterparty(writes, { sessionId, inboundId: inbound.event.id, text: input.text, interp, failed: rephrase, agent, counterpartyId });

      const state = projectState(await this.#record.context(sessionId));
      const deal = counterpartyDeal(state, interp);
      if (offerExtractedId) {
        const check = await this.#recordCheck(writes, state, offerExtractedId, deal.package, deal.check, requestedIds, agent);
        related.push(check.id);
      }
      const actStarted = performance.now();
      const reply = await this.#act(writes, { sessionId, channel, agent, interp, inboundId: inbound.event.id, related, conversation, rephrase });
      const composeMs = Math.round(performance.now() - actStarted);
      return {
        ok: true,
        reply,
        events: writes.created,
        state: projectState(await this.#record.context(sessionId)),
        timings: { interpretMs, composeMs, totalMs: Math.round(performance.now() - started) },
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
  async #act(writes: Writer, ctx: ActContext): Promise<TurnResult["reply"]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let state = projectState(await this.#record.context(ctx.sessionId));
      const deal = counterpartyDeal(state, ctx.interp);
      // Questions this message raised (prepared just now), which the strategy may ask before conceding.
      const freshQuestions = writes.created
        .filter((e) => e.type === "question_prepared")
        .map((e) => ({ questionId: e.id, text: (e.payload as { text: string }).text, kind: (e.payload as { issueKind: string }).issueKind }));
      let plan: Plan;
      try {
        plan = state.status === "paused"
          ? { ...basePlan("answer", { kind: "hold", reason: "The principal paused the negotiation." }, null), action: "pause" }
          : decide(state, ctx.interp, deal, { guidance: this.#guidance, freshQuestions, conditionAsked: conditionAlreadyAsked(projectCounterparty(await this.#record.context(ctx.sessionId), state.view.negotiable?.termId ?? null)), locale: this.#locale });
      } catch {
        // A strategy failure never improvises: hold, offer nothing, and say we will come back.
        plan = { ...basePlan("answer", { kind: "hold", reason: "The strategy could not choose a move; nothing was offered." }, null), action: "wait", notice: "check_with_principal" };
      }
      if (state.status === "paused") plan.notice = "paused";
      if (ctx.rephrase) plan.notice ??= "rephrase";
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
        plan.acceptanceOf = null;
        if (plan.move !== "await_approval" && plan.move !== "closed") plan.move = "answer";
      }
      await writes.put({ id: newEventId(), type: "decision", channel: null, payload: this.#decisionPayload(plan, state, ctx.related) }, ctx.agent);
      const model = projectCounterparty(await this.#record.context(ctx.sessionId), state.view.negotiable?.termId ?? null);
      if (!plan.ask && plan.strategyQuestion) plan.ask = await this.#strategyQuestion(writes, model, plan.strategyQuestion, ctx.inboundId, ctx.agent);
      plan.ask ??= selectQuestion(model, plan);

      const offerIds = await this.#recordCommitments(writes, state, plan, ctx.inboundId, ctx.agent);
      // Phase 2: the words, built only from checked terms and permitted facts.
      const text = await this.#word(writes, state, plan, ctx.conversation, ctx.agent, ctx.interp);

      // Send: the action may go only under the authority it was prepared with.
      const now = projectState(await this.#record.context(ctx.sessionId));
      const changed = now.mandateRevision !== prepared ? "stale_authority" : now.status === "paused" && plan.notice !== "paused" ? "paused" : null;
      if (changed) {
        await this.#recordGate(writes, plan, { decision: "block", reasons: [{ rule: changed, detail: changed === "paused" ? "The principal paused before sending." : "The mandate changed before sending; planning again." }], mandateRevision: prepared, termsHash: null, breachedRuleIds: [] }, "send", offerIds[0] ?? null, ctx.agent);
        continue;
      }
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
      if (plan.ask && text.includes(plan.ask.text)) {
        await writes.put({ id: newEventId(), type: "question_asked", channel: null, payload: { questionId: plan.ask.questionId, messageId: reply.id } }, ctx.agent);
      }
      return { messageId: reply.id, text, offerIds, channel: ctx.channel };
    }
    const text = "Let me check on that and get back to you.";
    const state = projectState(await this.#record.context(ctx.sessionId));
    const reply = await writes.put({ id: newEventId(), type: "message", channel: ctx.channel, payload: { direction: "outbound", speakerPartyId: state.view.principalId, text, utteranceId: null, offerIds: [] } }, ctx.agent);
    return { messageId: reply.id, text, offerIds: [], channel: ctx.channel };
  }

  /**
   * The terms cross a limit the principal may waive. Record them as proposed but unsent, ask
   * the principal, and tell the counterparty only that we are checking. Nothing is offered.
   */
  async #requestException(writes: Writer, state: NegotiationState, plan: Plan, gate: GateResult, ctx: ActContext): Promise<TurnResult["reply"]> {
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
    const text = await this.#word(writes, state, holding, ctx.conversation, ctx.agent, ctx.interp);
    await this.#recordGate(writes, holding, { decision: "allow", reasons: [], mandateRevision: state.mandateRevision, termsHash: null, breachedRuleIds: [] }, "send", null, ctx.agent);
    const reply = await writes.put({ id: newEventId(), type: "message", channel: ctx.channel, payload: { direction: "outbound", speakerPartyId: state.view.principalId, text, utteranceId: null, offerIds: [] } }, ctx.agent);
    return { messageId: reply.id, text, offerIds: [], channel: ctx.channel };
  }

  /** Records what the counterparty said and answered, then prepares questions from the updated context. */
  async #recordCounterparty(writes: Writer, input: { sessionId: string; inboundId: string; text: string; interp: Interpretation; failed: boolean; agent: Actor; counterpartyId: string }): Promise<void> {
    const kinds = new Set(["need", "constraint", "preference", "reason", "authority", "claim", "alternative", "budget", "final_position"]);
    // Only items whose quote really is in the message are kept; the counterparty's words are never paraphrased into a quote.
    const items = (input.interp.notes ?? [])
      .filter((n) => kinds.has(n.kind) && quoteAppearsIn(input.text, n.quote))
      .map((n) => ({ kind: n.kind as never, quote: n.quote, summary: n.summary, termId: n.termId, value: n.value, condition: n.condition, basis: n.basis }));
    if (items.length > 0 || input.failed) {
      await writes.put({ id: newEventId(), type: "counterparty_noted", channel: null, payload: { sourceMessageId: input.inboundId, failed: input.failed, items } }, input.agent);
    }
    const before = projectCounterparty(await this.#record.context(input.sessionId), null);
    for (const a of input.interp.answers ?? []) {
      const q = before.questions.find((x) => x.id === a.questionId && (x.status === "asked" || x.status === "partial"));
      if (!q) continue;
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
    for (const q of prepareQuestions(model, nameOf, format)) {
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

  /**
   * Words for a planned action. Read-backs of complete terms and agreements are rendered from the
   * checked fields, never written by the model. Other replies may be composed, then must pass the
   * code checks and the language check; otherwise checked template wording is used.
   */
  async #word(writes: Writer, state: NegotiationState, plan: Plan, conversation: Conversation, agent: Actor, interp: Interpretation): Promise<string> {
    const templateOnly = plan.move === "state_final_terms" || plan.move === "confirm_agreement" || plan.move === "end_negotiation" || plan.notice === "paused" || plan.notice === "check_with_principal" || plan.notice === "ended";
    if (!templateOnly) {
      let draft: string | null = null;
      try {
        draft = await composeReply(this.#llm, { view: state.view, plan, conversation, locale: this.#locale });
      } catch {
        draft = null;
      }
      if (draft !== null && plan.ask && !draft.includes(plan.ask.text)) draft = `${draft} ${plan.ask.text}`;
      if (draft !== null) {
        const wording = gateWording(state, plan, draft);
        if (wording.decision !== "allow") {
          await this.#block(writes, draft, wording.reasons.map((r) => ({ rule: r.rule as ReplyViolation["rule"], detail: r.detail })), agent);
        } else {
          const checkedTerms = (plan.offer?.terms ?? []).map((t) => `${state.space.terms.find((x) => x.termId === t.termId)?.name ?? t.termId}: ${formatValue(t.value, this.#locale)}`);
          const language = await languageCheck(this.#llm, {
            reply: draft,
            checkedTerms,
            permittedFacts: state.view.publicFacts,
            declinedTerms: plan.declined.map((d) => state.space.terms.find((t) => t.termId === d.termId)?.name ?? d.termId),
            counterpartyWords: conversation.filter((c) => c.speaker === "counterparty").map((c) => c.text),
          });
          if (language.ok && language.concerns.length === 0) return draft;
          const violations = language.ok
            ? language.concerns.map((c) => ({ rule: `language_${c.type}` as ReplyViolation["rule"], detail: `Language check: ${c.type.replace(/_/g, " ")} ("${c.quote.slice(0, 120)}")` }))
            : [{ rule: "language_unavailable" as ReplyViolation["rule"], detail: "The language check could not run, so the composed reply was not used." }];
          await this.#block(writes, draft, violations, agent);
        }
      }
    }
    let fallback = templateReply(state.view, plan, this.#locale);
    if (plan.ask && !fallback.includes(plan.ask.text)) fallback = `${fallback} ${plan.ask.text}`;
    const fallbackGate = gateWording(state, plan, fallback);
    if (fallbackGate.decision === "allow") return fallback;
    await this.#block(writes, fallback, fallbackGate.reasons.map((r) => ({ rule: r.rule as ReplyViolation["rule"], detail: r.detail })), agent);
    void interp;
    return "Let me check on that and get back to you.";
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
  #decisionPayload(plan: Plan, state: NegotiationState, related: string[]) {
    return {
      kind: plan.decision.kind,
      reason: plan.decision.reason.slice(0, 500),
      relatedEventIds: related.slice(0, 20),
      action: plan.action ?? null,
      assessment: plan.assessment ? { verdict: plan.assessment.verdict, drivers: plan.assessment.drivers.map((d) => d.slice(0, 500)) } : null,
      mandateRevision: state.mandateRevision,
      guidance: this.#guidance.id,
    };
  }

  /** A guidance question (e.g. for "what's your lowest?"): prepared once, asked at most once. */
  async #strategyQuestion(writes: Writer, model: CounterpartyModel, q: NonNullable<Plan["strategyQuestion"]>, inboundId: string, agent: Actor): Promise<Plan["ask"]> {
    const issueKey = q.key ?? `strategy:${q.kind}`;
    const existing = model.questions.find((x) => x.issueKey === issueKey);
    if (existing) return existing.status === "open" ? { questionId: existing.id, text: existing.text } : null;
    const prepared = await writes.put({ id: newEventId(), type: "question_prepared", channel: null, payload: { issueKey, issueKind: q.kind, purpose: q.purpose, text: q.text, relatedEventIds: [inboundId] } }, agent);
    return { questionId: prepared.id, text: q.text };
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
  async reportDelivery(input: { sessionId: string; messageId: string; channel: Channel; status: "delivered" | "interrupted" | "failed"; deliveredText?: string | null }): Promise<RecordedEvent | TurnError> {
    const result = await this.#record.append(
      input.sessionId,
      { id: `delivery_${input.messageId}`, type: "delivery_reported", channel: input.channel, payload: { messageId: input.messageId, status: input.status, deliveredText: input.deliveredText ?? null } },
      { kind: "system", partyId: null },
    );
    if (!result.ok) return { ok: false, code: result.error.code === "write_failed" ? "write_failed" : "invalid_event", message: result.error.message };
    return result.event;
  }

  /** The principal answers a pending approval request. Identity comes from the calling route. */
  respondToApproval(input: { sessionId: string; requestId: string; decision: "approved" | "rejected"; note?: string | null; channel?: Channel }): Promise<TurnResult | TurnError> {
    return this.#serialize(input.sessionId, async () => {
      const started = performance.now();
      const state = projectState(await this.#record.context(input.sessionId));
      if (state.status === "paused") return { ok: false, code: "not_pending", message: "Resume the negotiation before answering approvals." };
      const pending = state.pendingApproval;
      if (!pending || pending.requestId !== input.requestId) {
        return { ok: false, code: "not_pending", message: "That approval request is no longer pending." };
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
        const text = await this.#word(writes, after, plan, conversation, agent, emptyInterpretation());
        await this.#recordGate(writes, plan, { decision: "allow", reasons: [], mandateRevision: after.mandateRevision, termsHash: plan.offer ? hashTerms(plan.offer.terms) : null, breachedRuleIds: [] }, "send", offerIds[0] ?? null, agent);
        const reply = await writes.put(
          { id: newEventId(), type: "message", channel, payload: { direction: "outbound", speakerPartyId: after.view.principalId, text, utteranceId: null, offerIds } },
          agent,
        );
        return {
          ok: true,
          reply: { messageId: reply.id, text, offerIds, channel },
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
        const text = templateReply(state.view, plan, this.#locale);
        await this.#recordGate(writes, plan, { decision: "allow", reasons: [], mandateRevision: state.mandateRevision, termsHash: null, breachedRuleIds: [] }, "send", null, agent);
        const reply = await writes.put({ id: newEventId(), type: "message", channel, payload: { direction: "outbound", speakerPartyId: state.view.principalId, text, utteranceId: null, offerIds: [] } }, agent);
        return {
          ok: true,
          reply: { messageId: reply.id, text, offerIds: [], channel },
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

interface ActContext {
  sessionId: string;
  channel: Channel;
  agent: Actor;
  interp: Interpretation;
  inboundId: string;
  related: string[];
  conversation: Conversation;
  rephrase: boolean;
}

/** Placeholder until strategy (Epic 8): ask at most one never-asked question, only while holding or answering. */
function selectQuestion(model: CounterpartyModel, plan: Plan): Plan["ask"] {
  if (plan.move !== "hold" && plan.move !== "answer") return null;
  if (plan.notice || plan.clarify.length > 0 || plan.unresolved.length > 0 || plan.questions.length > 0 || plan.refuseDisclosure) return null;
  const q = model.questions.find((x) => x.status === "open");
  return q ? { questionId: q.id, text: q.text } : null;
}

/** A conditional question was already put to the counterparty in this session. */
function conditionAlreadyAsked(model: CounterpartyModel): boolean {
  return model.questions.some((q) => q.issueKind === "conditional" && q.status !== "open");
}

/** True when this inbound message already has a recorded failed read (so a retry does not record it twice). */
function existingFailure(events: RecordedEvent[], inboundSeq: number): boolean {
  return events.some((e) => e.seq > inboundSeq && e.type === "counterparty_noted" && (e.payload as { failed: boolean }).failed);
}

/** The counterparty's latest offer, so a new one is recorded as its next version. */
function lastCounterpartyOfferId(ctx: { events: RecordedEvent[] }): string | null {
  for (let i = ctx.events.length - 1; i >= 0; i -= 1) if (ctx.events[i]!.type === "offer_extracted") return ctx.events[i]!.id;
  return null;
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

function basePlan(move: Plan["move"], decision: Plan["decision"], offer: Plan["offer"]): Plan {
  return { move, decision, offer, acceptanceOf: null, declined: [], refuseDisclosure: false, ignoreAuthorityClaim: false, questions: [], respondingTo: null, notice: null, clarify: [], unresolved: [], ask: null };
}

/**
 * The counterparty's proposal as a whole: their terms placed on the agent's current
 * package (so unchanged terms keep the agent's values), checked against the deal space.
 */
function counterpartyDeal(state: NegotiationState, interp: Interpretation): DealInput {
  const base = state.pendingFinal?.terms ?? state.lastProposed?.terms ?? state.view.defaultPackage;
  let pkg = [...base];
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
