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
import { numericValue, withTerm } from "./mandate-view.ts";
import { checkProposal, type DealCheck } from "../dealspace/check.ts";
import type { ConfirmedMandate } from "../schema/records.ts";
import { decide, planViolations, type DealInput, type Interpretation, type Plan } from "./policy.ts";
import { checkReply, type ReplyViolation } from "./reply-check.ts";
import { fitsNow, projectState, type NegotiationState } from "./state.ts";
import { templateReply } from "./templates.ts";

export interface EngineOptions {
  record: NegotiationRecord;
  llm: StructuredLlm;
  /** Formatting locale from the host application, e.g. for currency display. */
  locale: string;
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
  code: "session_not_found" | "invalid_event" | "write_failed" | "not_pending";
  message: string;
}

const AGENT: Actor["kind"] = "agent";

export class NegotiationEngine {
  readonly #record: NegotiationRecord;
  readonly #llm: StructuredLlm;
  readonly #locale: string;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: EngineOptions) {
    this.#record = options.record;
    this.#llm = options.llm;
    this.#locale = options.locale;
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
      const resumable = after.every((e) => e.type === "offer_extracted" || e.type === "decision");
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
        interp = await interpretMessage(this.#llm, { view: before.view, lastStated: before.pendingFinal ?? before.lastProposed, conversation, message: input.text, locale: this.#locale });
      } catch {
        interp = { intent: "other", offerTerms: [], acceptsStatedTerms: false, asksPrivateInfo: false, claimsAuthority: false, questions: [], newTerms: [] };
        rephrase = true;
      }
      const interpretMs = Math.round(performance.now() - interpretStarted);

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
          { id: newEventId(), type: "offer_extracted", channel: null, payload: { sourceMessageId: inbound.event.id, byPartyId: counterpartyId, terms: interp.offerTerms, termsHash: hashTerms(interp.offerTerms) } },
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

      const state = projectState(await this.#record.context(sessionId));
      const deal = counterpartyDeal(state, interp);
      if (offerExtractedId) {
        const check = await this.#recordCheck(writes, state, offerExtractedId, deal.package, deal.check, requestedIds, agent);
        related.push(check.id);
      }
      const plan = decide(state, interp, deal);
      if (rephrase) plan.notice = "rephrase";

      // Every offer the agent makes must fit the deal space of the mandate in force.
      let agentCheck: DealCheck | null = null;
      if (plan.offer) {
        agentCheck = checkProposal(state.space, plan.offer.terms);
        if (agentCheck.result !== "fits") {
          for (const f of agentCheck.findings) {
            if (f.status === "needs_clarification" && f.basis === "condition" && f.relatedTermId) {
              const name = state.space.terms.find((t) => t.termId === f.relatedTermId)?.name;
              if (name && !plan.clarify.includes(name)) plan.clarify.push(name);
            }
          }
          plan.decision = { kind: "hold", reason: `The planned offer does not fit the deal space (${agentCheck.result.replace("_", " ")}); no offer made.` };
          plan.move = "answer";
          plan.offer = null;
          agentCheck = null;
        }
      }

      // A change while waiting for approval supersedes the pending request.
      if (state.status === "awaiting_approval" && plan.move !== "await_approval" && plan.move !== "closed") {
        await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: "awaiting_approval", to: "active", reason: "The counterparty changed the terms; the pending approval no longer applies." } }, agent);
        plan.notice ??= "terms_changed";
      }

      const problems = planViolations(state, plan);
      if (problems.length > 0) {
        // Never expected: the policy only proposes inside the mandate. Refuse rather than send.
        await writes.put({ id: newEventId(), type: "decision", channel: null, payload: { kind: "hold", reason: `Plan rejected by mandate check: ${problems[0]}`.slice(0, 500), relatedEventIds: related } }, agent);
        plan.move = "answer";
        plan.offer = null;
      } else {
        await writes.put({ id: newEventId(), type: "decision", channel: null, payload: { kind: plan.decision.kind, reason: plan.decision.reason, relatedEventIds: related } }, agent);
      }

      const offerIds = await this.#recordCommitments(writes, state, plan, inbound.event.id, agent, agentCheck);
      const composeStarted = performance.now();
      const text = await this.#wordAndCheck(writes, state, plan, conversation, agent);
      const composeMs = Math.round(performance.now() - composeStarted);
      const reply = await writes.put(
        { id: newEventId(), type: "message", channel, payload: { direction: "outbound", speakerPartyId: state.view.principalId, text, utteranceId: null, offerIds } },
        agent,
      );
      return {
        ok: true,
        reply: { messageId: reply.id, text, offerIds, channel },
        events: writes.created,
        state: projectState(await this.#record.context(sessionId)),
        timings: { interpretMs, composeMs, totalMs: Math.round(performance.now() - started) },
      };
    } catch (error) {
      if (error instanceof WriteFailure) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  /** Records offers, acceptance, approval requests and agreements implied by the plan. */
  async #recordCommitments(writes: Writer, state: NegotiationState, plan: Plan, messageId: string, agent: Actor, check: DealCheck | null): Promise<string[]> {
    const offerIds: string[] = [];
    if (plan.offer) {
      const hash = hashTerms(plan.offer.terms);
      const reuse = state.lastProposed && state.lastProposed.termsHash === hash && state.lastProposed.basis === plan.offer.basis;
      const offerId = reuse
        ? state.lastProposed!.offerId
        : (await writes.put({ id: newEventId(), type: "offer_proposed", channel: null, payload: { byPartyId: state.view.principalId, basis: plan.offer.basis, terms: plan.offer.terms, termsHash: hash } }, agent)).id;
      if (!fitsNow(state, offerId, hash)) {
        await this.#recordCheck(writes, state, offerId, plan.offer.terms, check ?? checkProposal(state.space, plan.offer.terms), [], agent);
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
          { id: newEventId(), type: "approval_requested", channel: null, payload: { offerId: accepted.offerId, termsHash: accepted.termsHash, mandateRevision: state.mandateRevision, acceptanceId: acceptance.id } },
          agent,
        );
        await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: state.status, to: "awaiting_approval", reason: "Counterparty accepted; waiting for the principal's approval." } }, agent);
      } else {
        await writes.put(
          { id: newEventId(), type: "agreement_recorded", channel: null, payload: { offerId: accepted.offerId, terms: accepted.terms, termsHash: accepted.termsHash, mandateRevision: state.mandateRevision, acceptanceId: acceptance.id, approvalId: null } },
          agent,
        );
        await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: state.status, to: "agreed", reason: "Counterparty accepted terms the mandate allows." } }, agent);
        plan.offer = { terms: accepted.terms, basis: "final_terms" };
      }
    }
    return offerIds;
  }

  /** Composes wording, checks it in code, and falls back to checked template wording. */
  async #wordAndCheck(writes: Writer, state: NegotiationState, plan: Plan, conversation: Conversation, agent: Actor): Promise<string> {
    const checkCtx = { view: state.view, plan, counterpartyAmounts: state.counterpartyAmounts };
    let draft: string | null = null;
    try {
      draft = await composeReply(this.#llm, { view: state.view, plan, conversation, locale: this.#locale });
    } catch {
      draft = null;
    }
    if (draft !== null) {
      const violations = checkReply(draft, checkCtx);
      if (violations.length === 0) return draft;
      await this.#block(writes, draft, violations, agent);
    }
    const fallback = templateReply(state.view, plan, this.#locale);
    const fallbackViolations = checkReply(fallback, checkCtx);
    if (fallbackViolations.length === 0) return fallback;
    await this.#block(writes, fallback, fallbackViolations, agent);
    return "Let me check on that and get back to you.";
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
  reviseMandate(input: { sessionId: string; mandate: ConfirmedMandate; reason: string }): Promise<{ ok: true; state: NegotiationState; events: RecordedEvent[] } | TurnError> {
    return this.#serialize(input.sessionId, async () => {
      const before = projectState(await this.#record.context(input.sessionId));
      const principal: Actor = { kind: "principal", partyId: before.view.principalId };
      const agent: Actor = { kind: AGENT, partyId: before.view.principalId };
      const writes = new Writer(this.#record, input.sessionId);
      try {
        await writes.put({ id: newEventId(), type: "mandate_revised", channel: null, payload: { mandate: input.mandate, mandateRevision: before.mandateRevision + 1, reason: input.reason } }, principal);
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
        if (after.status === "awaiting_approval" && after.pendingApproval && results.get(after.pendingApproval.offerId)?.result !== "fits") {
          await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: "awaiting_approval", to: "active", reason: "The mandate changed and the pending terms no longer fit it." } }, agent);
        }
        return { ok: true as const, state: projectState(await this.#record.context(input.sessionId)), events: writes.created };
      } catch (error) {
        if (error instanceof WriteFailure) return { ok: false as const, code: error.code, message: error.message };
        throw error;
      }
    });
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
      const pending = state.pendingApproval;
      if (!pending || pending.requestId !== input.requestId) {
        return { ok: false, code: "not_pending", message: "That approval request is no longer pending." };
      }
      const principal: Actor = { kind: "principal", partyId: state.view.principalId };
      const agent: Actor = { kind: AGENT, partyId: state.view.principalId };
      const writes = new Writer(this.#record, input.sessionId);
      const channel = input.channel ?? lastChannel(await this.#record.read(input.sessionId, { viewer: "operator" }));
      try {
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
        } else {
          await writes.put({ id: newEventId(), type: "status_changed", channel: null, payload: { from: state.status, to: "active", reason: "The principal did not approve the terms." } }, agent);
          const fallbackAsk = previousAsk(state, pending.offerId);
          plan = basePlan("hold", { kind: "reject_offer", reason: "Principal rejected the terms; return to the previous ask." }, fallbackAsk ? { terms: fallbackAsk, basis: "counter" } : null);
          plan.notice = "approval_rejected";
        }
        await writes.put({ id: newEventId(), type: "decision", channel: null, payload: { kind: plan.decision.kind, reason: plan.decision.reason, relatedEventIds: [response.id] } }, agent);
        const after = projectState(await this.#record.context(input.sessionId));
        const offerIds: string[] = [];
        if (plan.move === "hold" && plan.offer) {
          offerIds.push((await writes.put({ id: newEventId(), type: "offer_proposed", channel: null, payload: { byPartyId: after.view.principalId, basis: "counter", terms: plan.offer.terms, termsHash: hashTerms(plan.offer.terms) } }, agent)).id);
        }
        const conversation = await this.#conversation(input.sessionId, null);
        const text = await this.#wordAndCheck(writes, after, plan, conversation, agent);
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
  return { move, decision, offer, acceptanceOf: null, declined: [], refuseDisclosure: false, ignoreAuthorityClaim: false, questions: [], respondingTo: null, notice: null, clarify: [], unresolved: [] };
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
