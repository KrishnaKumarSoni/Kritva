/**
 * Deterministic append rules for the negotiation record. No model calls.
 *
 * Each new event is checked against the session's existing events: references must
 * resolve inside the same session, actors must come from the right side, and
 * commitments (approvals, acceptances, agreements) must bind to the exact same terms
 * and mandate revision.
 */
import type { ConfirmedMandate } from "../schema/records.ts";
import { quoteAppearsIn } from "../schema/quotes.ts";
import { formatPath, validateDraft, type ValidationIssue } from "../schema/validate.ts";
import {
  Actor,
  CHANNEL_EVENT_TYPES,
  hashTerms,
  PAYLOADS,
  PUBLIC_EVENT_TYPES,
  type EventType,
  type NewEvent,
  type OfferTerm,
  type PayloadOf,
  type RecordedEvent,
  type SessionStatus,
} from "./events.ts";

/** Event types whose content may be corrected. Commitments are never rewritten. */
export const CORRECTABLE_TYPES = new Set<EventType>(["message", "offer_extracted", "transcript_fragment"]);

/** A read model of one session, built only from its recorded events. */
export class SessionContext {
  readonly events: RecordedEvent[];
  readonly byId: Map<string, RecordedEvent>;
  readonly effective: Map<string, unknown>;
  mandate: ConfirmedMandate | null = null;
  mandateRevision = 0;
  status: SessionStatus = "active";
  /** Drafts that were confirmed or rejected; neither can be used again. */
  readonly closedDrafts = new Set<string>();

  constructor(events: RecordedEvent[]) {
    this.events = events;
    this.byId = new Map(events.map((e) => [e.id, e]));
    this.effective = new Map(events.map((e) => [e.id, e.payload]));
    for (const e of events) this.apply(e);
  }

  apply(e: RecordedEvent): void {
    if (e.type === "session_started" || e.type === "mandate_revised") {
      const p = e.payload as PayloadOf<"session_started"> | PayloadOf<"mandate_revised">;
      this.mandate = p.mandate;
      this.mandateRevision = p.mandateRevision;
    }
    if (e.type === "status_changed") this.status = (e.payload as PayloadOf<"status_changed">).to;
    if (e.type === "mandate_draft_rejected") this.closedDrafts.add((e.payload as PayloadOf<"mandate_draft_rejected">).draftId);
    if (e.type === "mandate_revised") {
      const draftId = (e.payload as PayloadOf<"mandate_revised">).draftId;
      if (draftId) this.closedDrafts.add(draftId);
    }
    if (e.type === "correction") {
      const p = e.payload as PayloadOf<"correction">;
      this.effective.set(p.correctsEventId, p.replacement);
    }
  }

  get principalId(): string | null {
    return this.mandate?.parties.find((p) => p.isPrincipal)?.id ?? null;
  }

  /** The current content of an event, after any corrections. */
  payloadOf<T extends EventType>(id: string, type: T): PayloadOf<T> | null {
    const event = this.byId.get(id);
    if (!event || event.type !== type) return null;
    return this.effective.get(id) as PayloadOf<T>;
  }

  /** True when an outbound message carrying this offer was reported delivered in full. */
  isCommunicated(offerId: string): boolean {
    return this.events.some((e) => {
      if (e.type !== "message") return false;
      const m = this.effective.get(e.id) as PayloadOf<"message">;
      if (m.direction !== "outbound" || !m.offerIds.includes(offerId)) return false;
      return this.events.some(
        (d) => d.type === "delivery_reported" && (d.payload as PayloadOf<"delivery_reported">).messageId === e.id && (d.payload as PayloadOf<"delivery_reported">).status === "delivered",
      );
    });
  }

  offerTerms(offerId: string): { terms: OfferTerm[]; termsHash: string; type: EventType } | null {
    const event = this.byId.get(offerId);
    if (!event || (event.type !== "offer_extracted" && event.type !== "offer_proposed")) return null;
    const p = this.effective.get(offerId) as PayloadOf<"offer_extracted"> | PayloadOf<"offer_proposed">;
    return { terms: p.terms, termsHash: p.termsHash, type: event.type };
  }
}

export function validateNewEvent(event: NewEvent, actorInput: unknown, ctx: SessionContext): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (path: string, reason: string) => errors.push({ path, reason });

  if (!(event.type in PAYLOADS)) return [{ path: "type", reason: "unknown event type" }];
  if (typeof event.id !== "string" || event.id.length === 0 || event.id.length > 128) add("id", "expected a non-empty ID");

  const actorParsed = Actor.safeParse(actorInput);
  if (!actorParsed.success) return [...errors, { path: "actor", reason: "actor metadata is missing or invalid" }];
  const actor = actorParsed.data;

  const parsed = PAYLOADS[event.type].safeParse(event.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      add(`payload.${formatPath(issue.path)}`, issue.code === "invalid_type" ? `expected ${issue.expected}` : issue.message);
    }
    return errors;
  }

  if (event.channel !== null && event.channel !== "text" && event.channel !== "voice") add("channel", "expected text, voice or null");
  if (CHANNEL_EVENT_TYPES.has(event.type) && event.channel === null) add("channel", "this event type needs a channel");

  if (event.type === "session_started") {
    if (ctx.events.length > 0) add("type", "a session starts only once");
    return errors;
  }
  if (!ctx.mandate) return [...errors, { path: "sessionId", reason: "session has no starting mandate" }];

  const principalId = ctx.principalId;
  const partyIds = new Set(ctx.mandate.parties.map((p) => p.id));
  const termTypes = new Map(ctx.mandate.terms.map((t) => [t.id, t.valueType]));
  const isAgentSide = actor.kind === "agent" || actor.kind === "system";

  const requireActor = (allowed: Actor["kind"][]) => {
    if (!allowed.includes(actor.kind)) add("actor.kind", `this event can only be recorded by: ${allowed.join(", ")}`);
  };
  const refOf = (path: string, id: string, types: EventType[]): RecordedEvent | null => {
    const target = ctx.byId.get(id);
    if (!target) {
      add(path, "references an event that is not in this session");
      return null;
    }
    if (!types.includes(target.type)) {
      add(path, `must reference ${types.join(" or ")}`);
      return null;
    }
    return target;
  };
  const checkTerms = (terms: OfferTerm[], termsHash: string, path: string) => {
    const seen = new Set<string>();
    terms.forEach((t, i) => {
      const valueType = termTypes.get(t.termId);
      if (!valueType) add(`${path}.terms[${i}].termId`, "references a term that is not in the current mandate");
      else if (valueType !== t.value.type) add(`${path}.terms[${i}].value.type`, `does not match the term's value type (${valueType})`);
      if (seen.has(t.termId)) add(`${path}.terms[${i}].termId`, "term appears twice in one offer");
      seen.add(t.termId);
    });
    if (hashTerms(terms) !== termsHash) add(`${path}.termsHash`, "does not match the terms");
  };
  const checkCurrentRevision = (revision: number, path: string) => {
    if (revision !== ctx.mandateRevision) add(path, "does not match the current mandate revision");
  };

  switch (event.type) {
    case "mandate_revised": {
      const p = parsed.data as PayloadOf<"mandate_revised">;
      requireActor(["principal"]);
      if (actor.partyId !== principalId) add("actor.partyId", "only the principal can revise the mandate");
      if (p.mandateRevision !== ctx.mandateRevision + 1) add("payload.mandateRevision", "must be the next revision number");
      if (p.mandate.caseId !== ctx.mandate.caseId) add("payload.mandate.caseId", "a revision cannot switch cases");
      if (p.draftId !== null) {
        const draft = ctx.payloadOf(p.draftId, "mandate_draft_proposed");
        if (!draft) add("payload.draftId", "references a draft that is not in this session");
        else {
          if (ctx.closedDrafts.has(p.draftId)) add("payload.draftId", "this draft was already confirmed or rejected");
          if (draft.basedOnRevision !== ctx.mandateRevision) add("payload.draftId", "the draft was prepared for an earlier mandate revision");
          const { approval: _a, ...confirmedBody } = p.mandate;
          const { approval: _b, ...draftBody } = draft.draft;
          if (JSON.stringify(confirmedBody) !== JSON.stringify(draftBody)) add("payload.mandate", "must be exactly the reviewed draft");
        }
      }
      break;
    }
    case "mandate_draft_proposed": {
      const p = parsed.data as PayloadOf<"mandate_draft_proposed">;
      requireActor(["principal"]);
      if (actor.partyId !== principalId) add("actor.partyId", "only the principal can propose a mandate change");
      if (p.basedOnRevision !== ctx.mandateRevision) add("payload.basedOnRevision", "does not match the current mandate revision");
      if (p.draft.caseId !== ctx.mandate.caseId) add("payload.draft.caseId", "a draft cannot switch cases");
      const checked = validateDraft(p.draft);
      if (!checked.ok) add("payload.draft", `the draft is not valid (${checked.errors[0]?.path}: ${checked.errors[0]?.reason})`);
      break;
    }
    case "mandate_draft_rejected": {
      const p = parsed.data as PayloadOf<"mandate_draft_rejected">;
      requireActor(["principal"]);
      if (!ctx.payloadOf(p.draftId, "mandate_draft_proposed")) add("payload.draftId", "references a draft that is not in this session");
      else if (ctx.closedDrafts.has(p.draftId)) add("payload.draftId", "this draft was already confirmed or rejected");
      break;
    }
    case "message": {
      const p = parsed.data as PayloadOf<"message">;
      if (!partyIds.has(p.speakerPartyId)) add("payload.speakerPartyId", "references an unknown party");
      if (p.direction === "inbound") {
        requireActor(["counterparty"]);
        if (actor.partyId !== p.speakerPartyId) add("payload.speakerPartyId", "must match the actor from application metadata");
        if (p.speakerPartyId === principalId) add("payload.speakerPartyId", "inbound messages come from the counterparty");
        if (p.offerIds.length > 0) add("payload.offerIds", "only outbound messages carry offers");
      } else {
        requireActor(["agent"]);
        if (p.speakerPartyId !== principalId) add("payload.speakerPartyId", "the agent speaks for the principal");
        p.offerIds.forEach((id, i) => refOf(`payload.offerIds[${i}]`, id, ["offer_proposed"]));
      }
      break;
    }
    case "transcript_fragment": {
      const p = parsed.data as PayloadOf<"transcript_fragment">;
      if (event.channel !== "voice") add("channel", "transcript fragments come from voice");
      if (!partyIds.has(p.speakerPartyId)) add("payload.speakerPartyId", "references an unknown party");
      if (actor.kind === "counterparty" && actor.partyId !== p.speakerPartyId) add("payload.speakerPartyId", "must match the actor");
      break;
    }
    case "offer_extracted": {
      const p = parsed.data as PayloadOf<"offer_extracted">;
      if (!isAgentSide) add("actor.kind", "offers are extracted by the agent or system");
      const source = refOf("payload.sourceMessageId", p.sourceMessageId, ["message"]);
      if (source) {
        const m = ctx.payloadOf(source.id, "message")!;
        if (m.direction !== "inbound") add("payload.sourceMessageId", "offers are extracted from inbound messages");
        if (m.speakerPartyId !== p.byPartyId) add("payload.byPartyId", "must be the speaker of the source message");
      }
      checkTerms(p.terms, p.termsHash, "payload");
      if (p.previousOfferId) {
        const prev = refOf("payload.previousOfferId", p.previousOfferId, ["offer_extracted"]);
        if (prev && ctx.payloadOf(prev.id, "offer_extracted")!.byPartyId !== p.byPartyId) add("payload.previousOfferId", "must be the same party's earlier offer");
      }
      break;
    }
    case "term_requested": {
      const p = parsed.data as PayloadOf<"term_requested">;
      if (!isAgentSide) add("actor.kind", "term requests are extracted by the agent or system");
      const source = refOf("payload.sourceMessageId", p.sourceMessageId, ["message"]);
      if (source) {
        const m = ctx.payloadOf(source.id, "message")!;
        if (m.direction !== "inbound" || m.speakerPartyId !== p.byPartyId) add("payload.sourceMessageId", "must be the requesting party's own message");
      }
      if (p.byPartyId === principalId) add("payload.byPartyId", "term requests come from the counterparty");
      break;
    }
    case "proposal_checked": {
      const p = parsed.data as PayloadOf<"proposal_checked">;
      if (!isAgentSide) add("actor.kind", "checks are recorded by the agent or system");
      const offer = ctx.offerTerms(p.offerId);
      if (!offer) add("payload.offerId", "references an offer that is not in this session");
      else if (offer.type === "offer_proposed" && offer.termsHash !== p.termsHash) add("payload.termsHash", "an agent proposal is checked exactly as proposed");
      checkTerms(p.checkedTerms, p.termsHash, "payload.checkedTerms");
      checkCurrentRevision(p.mandateRevision, "payload.mandateRevision");
      p.requestedTermIds.forEach((id, i) => refOf(`payload.requestedTermIds[${i}]`, id, ["term_requested"]));
      p.findings.forEach((f, i) => {
        if (f.termId !== null && !termTypes.has(f.termId) && f.basis !== "new_term") add(`payload.findings[${i}].termId`, "references a term that is not in the current mandate");
      });
      const expected = p.findings.some((f) => f.status === "conflict") ? "conflicts" : p.findings.some((f) => f.status === "needs_clarification") ? "needs_clarification" : "fits";
      if (p.result !== expected) add("payload.result", "does not follow from the findings");
      break;
    }
    case "offer_proposed": {
      const p = parsed.data as PayloadOf<"offer_proposed">;
      requireActor(["agent"]);
      if (p.byPartyId !== principalId) add("payload.byPartyId", "the agent proposes on the principal's behalf");
      checkTerms(p.terms, p.termsHash, "payload");
      if (p.previousOfferId) refOf("payload.previousOfferId", p.previousOfferId, ["offer_proposed"]);
      break;
    }
    case "counterparty_noted": {
      const p = parsed.data as PayloadOf<"counterparty_noted">;
      if (!isAgentSide) add("actor.kind", "only the agent or system records this");
      const source = refOf("payload.sourceMessageId", p.sourceMessageId, ["message"]);
      if (source) {
        const m = ctx.payloadOf(source.id, "message")!;
        if (m.direction !== "inbound") add("payload.sourceMessageId", "notes come from the counterparty's own messages");
        p.items.forEach((item, i) => {
          // The counterparty's words are kept exactly; the agent's reading goes in summary.
          if (!quoteAppearsIn(m.text, item.quote)) add(`payload.items[${i}].quote`, "quote does not appear in the message");
          if (item.termId !== null && !termTypes.has(item.termId)) add(`payload.items[${i}].termId`, "references a term that is not in the current mandate");
        });
      }
      break;
    }
    case "question_prepared": {
      if (!isAgentSide) add("actor.kind", "only the agent or system records this");
      const p = parsed.data as PayloadOf<"question_prepared">;
      p.relatedEventIds.forEach((id, i) => {
        if (!ctx.byId.has(id)) add(`payload.relatedEventIds[${i}]`, "references an event that is not in this session");
      });
      break;
    }
    case "question_asked": {
      if (!isAgentSide) add("actor.kind", "only the agent or system records this");
      const p = parsed.data as PayloadOf<"question_asked">;
      refOf("payload.questionId", p.questionId, ["question_prepared"]);
      const m = refOf("payload.messageId", p.messageId, ["message"]);
      if (m && ctx.payloadOf(m.id, "message")!.direction !== "outbound") add("payload.messageId", "questions are asked in outbound messages");
      break;
    }
    case "question_answered": {
      if (!isAgentSide) add("actor.kind", "only the agent or system records this");
      const p = parsed.data as PayloadOf<"question_answered">;
      refOf("payload.questionId", p.questionId, ["question_prepared"]);
      const m = refOf("payload.sourceMessageId", p.sourceMessageId, ["message"]);
      if (m) {
        const msg = ctx.payloadOf(m.id, "message")!;
        if (msg.direction !== "inbound") add("payload.sourceMessageId", "answers come from the counterparty");
        if (p.quote !== null && !quoteAppearsIn(msg.text, p.quote)) add("payload.quote", "quote does not appear in the message");
      }
      if (!ctx.events.some((e) => e.type === "question_asked" && (e.payload as PayloadOf<"question_asked">).questionId === p.questionId)) {
        add("payload.questionId", "the question was never asked");
      }
      break;
    }
    case "action_checked": {
      const p = parsed.data as PayloadOf<"action_checked">;
      if (!isAgentSide) add("actor.kind", "only the agent or system records this");
      if (p.offerId !== null && !ctx.offerTerms(p.offerId)) add("payload.offerId", "references an offer that is not in this session");
      // A check may record that authority changed under it, so it may name the revision it was prepared for.
      if (p.mandateRevision > ctx.mandateRevision) add("payload.mandateRevision", "names a revision that does not exist yet");
      break;
    }
    case "decision":
    case "reply_blocked": {
      if (!isAgentSide) add("actor.kind", "only the agent or system records this");
      if (event.type === "decision") {
        (parsed.data as PayloadOf<"decision">).relatedEventIds.forEach((id, i) => {
          if (!ctx.byId.has(id)) add(`payload.relatedEventIds[${i}]`, "references an event that is not in this session");
        });
      }
      break;
    }
    case "approval_requested": {
      const p = parsed.data as PayloadOf<"approval_requested">;
      if (!isAgentSide) add("actor.kind", "approval is requested by the agent or system");
      const offer = ctx.offerTerms(p.offerId);
      if (!offer) add("payload.offerId", "references an offer that is not in this session");
      else if (offer.termsHash !== p.termsHash) add("payload.termsHash", "does not match the offer's current terms");
      checkCurrentRevision(p.mandateRevision, "payload.mandateRevision");
      if (p.acceptanceId !== null) {
        const acceptance = ctx.payloadOf(p.acceptanceId, "acceptance_recorded");
        if (!acceptance) add("payload.acceptanceId", "references an acceptance that is not in this session");
        else if (acceptance.termsHash !== p.termsHash) add("payload.acceptanceId", "acceptance is for different terms");
      }
      break;
    }
    case "approval_responded": {
      const p = parsed.data as PayloadOf<"approval_responded">;
      requireActor(["principal"]);
      if (actor.partyId !== principalId) add("actor.partyId", "only the principal can approve or reject");
      const request = ctx.payloadOf(p.requestId, "approval_requested");
      if (!request) {
        add("payload.requestId", "references an approval request that is not in this session");
        break;
      }
      if (request.offerId !== p.offerId) add("payload.offerId", "does not match the approval request");
      if (request.termsHash !== p.termsHash) add("payload.termsHash", "does not match the terms that were put up for approval");
      if (request.mandateRevision !== p.mandateRevision) add("payload.mandateRevision", "does not match the approval request");
      checkCurrentRevision(p.mandateRevision, "payload.mandateRevision");
      const answered = ctx.events.some(
        (e) => e.type === "approval_responded" && (e.payload as PayloadOf<"approval_responded">).requestId === p.requestId,
      );
      if (answered) add("payload.requestId", "this approval request was already answered");
      break;
    }
    case "acceptance_recorded": {
      const p = parsed.data as PayloadOf<"acceptance_recorded">;
      if (!isAgentSide) add("actor.kind", "acceptances are recorded by the agent or system");
      const offer = ctx.offerTerms(p.offerId);
      if (!offer || offer.type !== "offer_proposed") add("payload.offerId", "must reference terms the agent stated");
      else {
        if (offer.termsHash !== p.termsHash) add("payload.termsHash", "does not match the stated terms");
        if (!ctx.isCommunicated(p.offerId)) add("payload.offerId", "terms were not delivered to the counterparty");
      }
      const message = refOf("payload.messageId", p.messageId, ["message"]);
      if (message) {
        const m = ctx.payloadOf(message.id, "message")!;
        if (m.direction !== "inbound" || m.speakerPartyId !== p.byPartyId) add("payload.messageId", "must be the counterparty's own message");
      }
      if (p.byPartyId === principalId) add("payload.byPartyId", "acceptance comes from the counterparty");
      break;
    }
    case "agreement_recorded": {
      const p = parsed.data as PayloadOf<"agreement_recorded">;
      if (!isAgentSide) add("actor.kind", "agreements are recorded by the agent or system");
      if (ctx.status === "agreed") add("type", "this session already has an agreement");
      if (ctx.status === "no_agreement" || ctx.status === "ended") add("type", "this session ended without agreement");
      checkTerms(p.terms, p.termsHash, "payload");
      checkCurrentRevision(p.mandateRevision, "payload.mandateRevision");
      const offer = ctx.offerTerms(p.offerId);
      if (!offer || offer.type !== "offer_proposed") add("payload.offerId", "must reference terms the agent stated");
      else if (offer.termsHash !== p.termsHash) add("payload.termsHash", "does not match the stated terms");
      const acceptance = ctx.payloadOf(p.acceptanceId, "acceptance_recorded");
      if (!acceptance) add("payload.acceptanceId", "references an acceptance that is not in this session");
      else if (acceptance.termsHash !== p.termsHash) add("payload.acceptanceId", "acceptance is for different terms");
      const acceptPermission = ctx.mandate.permissions.find((perm) => perm.action === "accept_agreement");
      const approvalRequired = acceptPermission?.mode !== "autonomous";
      if (p.approvalId === null) {
        if (approvalRequired) add("payload.approvalId", "the mandate requires the principal's approval");
      } else {
        const approval = ctx.payloadOf(p.approvalId, "approval_responded");
        if (!approval) add("payload.approvalId", "references an approval that is not in this session");
        else {
          if (approval.decision !== "approved") add("payload.approvalId", "the principal did not approve");
          if (approval.termsHash !== p.termsHash) add("payload.approvalId", "approval is for different terms");
          if (approval.mandateRevision !== p.mandateRevision) add("payload.approvalId", "approval is for a different mandate revision");
        }
      }
      break;
    }
    case "delivery_reported": {
      const p = parsed.data as PayloadOf<"delivery_reported">;
      requireActor(["system"]);
      const message = refOf("payload.messageId", p.messageId, ["message"]);
      if (message) {
        const m = ctx.payloadOf(message.id, "message")!;
        if (m.direction !== "outbound") add("payload.messageId", "delivery is reported for outbound messages");
        if (message.channel !== event.channel) add("channel", "must match the message's channel");
      }
      if (p.status === "interrupted" && p.deliveredText === null) add("payload.deliveredText", "an interruption must report what was delivered");
      break;
    }
    case "status_changed": {
      const p = parsed.data as PayloadOf<"status_changed">;
      if (actor.kind === "counterparty") add("actor.kind", "the counterparty cannot change session status");
      if (p.from !== ctx.status) add("payload.from", "does not match the current status");
      if (p.from === p.to) add("payload.to", "status is unchanged");
      // Agreement and no agreement are final outcomes.
      if (ctx.status === "agreed" || ctx.status === "no_agreement" || ctx.status === "ended") add("payload.from", "the negotiation has finished");
      break;
    }
    case "correction": {
      const p = parsed.data as PayloadOf<"correction">;
      const target = ctx.byId.get(p.correctsEventId);
      if (!target) {
        add("payload.correctsEventId", "references an event that is not in this session");
        break;
      }
      if (!CORRECTABLE_TYPES.has(target.type)) {
        add("payload.correctsEventId", `${target.type} events cannot be corrected; record a new event instead`);
        break;
      }
      const replacement = PAYLOADS[target.type].safeParse(p.replacement);
      if (!replacement.success) {
        for (const issue of replacement.error.issues) add(`payload.replacement.${formatPath(issue.path)}`, issue.message);
        break;
      }
      if (target.type === "offer_extracted") {
        const r = replacement.data as PayloadOf<"offer_extracted">;
        const original = target.payload as PayloadOf<"offer_extracted">;
        if (r.sourceMessageId !== original.sourceMessageId || r.byPartyId !== original.byPartyId) {
          add("payload.replacement", "a correction keeps the original source and party");
        }
        checkTerms(r.terms, r.termsHash, "payload.replacement");
      }
      if (target.type === "message") {
        const r = replacement.data as PayloadOf<"message">;
        const original = target.payload as PayloadOf<"message">;
        if (r.direction !== original.direction || r.speakerPartyId !== original.speakerPartyId) {
          add("payload.replacement", "a correction keeps the original direction and speaker");
        }
      }
      if (JSON.stringify(ctx.effective.get(target.id)) === JSON.stringify(replacement.data)) {
        add("payload.replacement", "the correction changes nothing");
      }
      break;
    }
  }
  return errors;
}

/** Visibility comes from the event type, never from the caller. Corrections inherit it. */
export function visibilityFor(type: EventType, ctx: SessionContext, payload: unknown): "public" | "private" {
  if (type === "correction") {
    const target = ctx.byId.get((payload as PayloadOf<"correction">).correctsEventId);
    return target?.visibility ?? "private";
  }
  return PUBLIC_EVENT_TYPES.has(type) ? "public" : "private";
}
