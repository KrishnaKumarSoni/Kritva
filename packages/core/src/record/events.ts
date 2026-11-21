/**
 * The shared negotiation record: one ordered list of events per session that text, voice,
 * the console, strategy, commitments and evaluations all read.
 *
 * Event content reuses Epic 1 structures (term IDs and typed values). Nothing here is
 * specific to any case.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { ConfirmedMandate, MandateDraft, Value } from "../schema/records.ts";

const Id = z.string().min(1).max(128);
const ShortText = z.string().trim().min(1).max(500);

export const Channel = z.enum(["text", "voice"]);
export type Channel = z.infer<typeof Channel>;

/**
 * Who caused an event. Always taken from application metadata (which route, which
 * signed-in role), never from conversation content.
 */
export const ActorKind = z.enum(["principal", "counterparty", "agent", "system"]);
export const Actor = z.strictObject({ kind: ActorKind, partyId: Id.nullable() });
export type Actor = z.infer<typeof Actor>;

/** One term in an offer, in Epic 1 terms: a mandate term ID and a typed value. */
export const OfferTerm = z.strictObject({ termId: Id, value: Value });
export type OfferTerm = z.infer<typeof OfferTerm>;
export const OfferTerms = z.array(OfferTerm).min(1).max(50);

export const SessionStatus = z.enum(["active", "paused", "awaiting_approval", "agreed", "no_agreement", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const DecisionKind = z.enum([
  "counter",
  "state_final_terms",
  "request_approval",
  "record_agreement",
  "decline_request",
  "answer",
  "hold",
  "reject_offer",
  "end",
]);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const PAYLOADS = {
  session_started: z.strictObject({
    mandate: ConfirmedMandate,
    mandateRevision: z.literal(1),
    previousSessionId: Id.nullable(),
    /** The saved case-level mandate and revision this session started from (Epic 11), if any. */
    mandateSource: z.strictObject({ mandateId: z.string().min(1).max(100), revision: z.number().int().min(1) }).nullable().default(null),
  }),
  mandate_revised: z.strictObject({
    mandate: ConfirmedMandate,
    mandateRevision: z.number().int().min(2),
    /** The saved case-level revision applied (Epic 11), when the change came from the mandate library. */
    mandateSource: z.strictObject({ mandateId: z.string().min(1).max(100), revision: z.number().int().min(1) }).nullable().default(null),
    reason: ShortText,
    /** The reviewed draft this revision confirms, when it came through the draft flow. */
    draftId: Id.nullable().default(null),
  }),
  /**
   * A mapped draft of changed principal instructions. It is never in force: it waits for the
   * principal's confirmation or rejection, and goes stale if the mandate changes first.
   */
  mandate_draft_proposed: z.strictObject({
    draft: MandateDraft,
    basedOnRevision: z.number().int().min(1),
    instructions: z.string().trim().min(1).max(10_000),
  }),
  mandate_draft_rejected: z.strictObject({
    draftId: Id,
    reason: ShortText,
  }),
  /** A completed turn. Voice turns are stored only once the transcript is final. */
  message: z.strictObject({
    direction: z.enum(["inbound", "outbound"]),
    speakerPartyId: Id,
    text: z.string().trim().min(1).max(10_000),
    /** Links a final voice transcript to its fragments. */
    utteranceId: Id.nullable(),
    /** Offers this outbound message communicates. */
    offerIds: z.array(Id).max(10),
  }),
  /** Interim speech-to-text output. Never counts as a message. */
  transcript_fragment: z.strictObject({
    utteranceId: Id,
    speakerPartyId: Id,
    text: z.string().max(10_000),
  }),
  /** Terms a counterparty stated, linked to the message they came from. */
  offer_extracted: z.strictObject({
    sourceMessageId: Id,
    byPartyId: Id,
    terms: OfferTerms,
    termsHash: z.string().length(64),
    /** An offer, a question about a price ("would you take X?"), or interest without a commitment. */
    kind: z.enum(["offer", "enquiry", "interest"]).default("offer"),
    /** The counterparty corrected their previous offer ("sorry, I meant X"): it replaces that one as a mistake. */
    correctsPrevious: z.boolean().default(false),
    /** The counterparty's previous offer this one changes. History is never overwritten. */
    previousOfferId: Id.nullable().default(null),
    /** Conditions in the counterparty's words that the terms cannot express ("if I get a truck"). */
    conditions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  }),
  /** Terms the agent intends to put forward. Proposed is not communicated. */
  offer_proposed: z.strictObject({
    byPartyId: Id,
    basis: z.enum(["counter", "final_terms"]),
    terms: OfferTerms,
    termsHash: z.string().length(64),
    /** The agent's previous offer this one changes. */
    previousOfferId: Id.nullable().default(null),
    /** How the strategy reached this value (Epic 8), when it was a tactic from guidance. */
    tactic: z.enum(["concession_step", "split_difference", "halve_distance"]).nullable().default(null),
  }),
  /** A term the counterparty asked about that the mandate does not cover (e.g. an added service). */
  term_requested: z.strictObject({
    sourceMessageId: Id,
    byPartyId: Id,
    name: ShortText.max(120),
    description: z.string().max(500).nullable(),
    value: Value.nullable(),
  }),
  /**
   * A deal-space check of one proposal against the mandate revision in force. Bound to the
   * exact terms checked; a later change needs a new check. Passing is not permission.
   */
  proposal_checked: z.strictObject({
    offerId: Id,
    checkedTerms: OfferTerms,
    termsHash: z.string().length(64),
    mandateRevision: z.number().int().min(1),
    requestedTermIds: z.array(Id).max(20),
    result: z.enum(["fits", "conflicts", "needs_clarification"]),
    findings: z
      .array(
        z.strictObject({
          termId: Id.nullable(),
          termName: z.string().min(1).max(120),
          status: z.enum(["fits", "conflict", "needs_clarification"]),
          basis: z.enum(["rule", "condition", "principal_value", "unaddressed", "new_term", "issue", "descriptive"]),
          ruleId: Id.nullable(),
          relatedTermId: Id.nullable(),
          detail: ShortText,
        }),
      )
      .max(100),
  }),
  /**
   * The outgoing gate's result for one action, with the mandate revision it used. Private: the
   * operator sees the rule and reason; the counterparty only ever sees a neutral status.
   */
  action_checked: z.strictObject({
    move: z.string().min(1).max(40),
    phase: z.enum(["terms", "wording", "send"]),
    offerId: Id.nullable(),
    termsHash: z.string().length(64).nullable(),
    mandateRevision: z.number().int().min(1),
    decision: z.enum(["allow", "block", "needs_approval", "needs_clarification"]),
    reasons: z.array(z.strictObject({ rule: z.string().min(1).max(80), detail: ShortText })).max(30),
  }),
  /**
   * What the counterparty said beyond offers: needs, constraints, reasons, preferences, claims,
   * stated authority, budgets and alternatives. Each item quotes the message word for word, keeps
   * the agent's reading separate, and is the counterparty's claim, never a verified fact.
   */
  counterparty_noted: z.strictObject({
    sourceMessageId: Id,
    /** True when the message could not be read; earlier context stays as it was. */
    failed: z.boolean().default(false),
    items: z
      .array(
        z.strictObject({
          kind: z.enum(["need", "constraint", "preference", "reason", "authority", "claim", "alternative", "budget", "final_position"]),
          quote: z.string().trim().min(1).max(500),
          summary: ShortText,
          termId: Id.nullable(),
          value: Value.nullable(),
          /** A condition the counterparty attached ("if I can get a vehicle"). Never dropped. */
          condition: z.string().max(300).nullable(),
          basis: z.enum(["stated", "inferred"]),
        }),
      )
      .max(20),
  }),
  /** A question that would resolve an unknown or conflict affecting a possible agreement. Strategy decides whether to ask it. */
  question_prepared: z.strictObject({
    issueKey: z.string().min(1).max(200),
    issueKind: z.enum(["budget_scope", "obstacle", "authority", "conditional", "contradiction", "terms_probe", "comparison"]),
    purpose: ShortText,
    text: ShortText,
    relatedEventIds: z.array(Id).max(10),
  }),
  question_asked: z.strictObject({ questionId: Id, messageId: Id }),
  question_answered: z.strictObject({
    questionId: Id,
    sourceMessageId: Id,
    quote: z.string().max(500).nullable(),
    resolution: z.enum(["answered", "partial", "refused"]),
  }),
  /** A short, user-facing reason. Hidden model reasoning is never stored. */
  decision: z.strictObject({
    kind: DecisionKind,
    reason: ShortText,
    relatedEventIds: z.array(Id).max(20),
    /** The strategy action chosen (Epic 8). */
    action: z.enum(["ask", "clarify", "propose", "counter", "accept", "decline", "request_approval", "pause", "end", "wait", "answer"]).nullable().default(null),
    /** The package assessment behind the action: hard constraints first, then stated interests. */
    assessment: z
      .strictObject({
        verdict: z.enum(["acceptable", "unacceptable", "needs_clarification", "not_assessed"]),
        drivers: z.array(ShortText).max(12),
      })
      .nullable()
      .default(null),
    mandateRevision: z.number().int().min(1).nullable().default(null),
    guidance: z.string().max(120).nullable().default(null),
  }),
  approval_requested: z.strictObject({
    offerId: Id,
    termsHash: z.string().length(64),
    mandateRevision: z.number().int().min(1),
    acceptanceId: Id.nullable(),
    /**
     * acceptance: the counterparty accepted these terms and the mandate needs approval to agree.
     * exception: the terms cross a limit whose exception the mandate lets the principal approve.
     */
    purpose: z.enum(["acceptance", "exception"]).default("acceptance"),
    /** For exceptions: the mandate rules these exact terms cross. */
    breachedRuleIds: z.array(Id).max(20).default([]),
    /** What approval allows, in plain words, for the principal reviewing it. */
    requestedAction: z.string().max(500).default(""),
  }),
  approval_responded: z.strictObject({
    requestId: Id,
    offerId: Id,
    termsHash: z.string().length(64),
    mandateRevision: z.number().int().min(1),
    decision: z.enum(["approved", "rejected"]),
    note: z.string().max(500).nullable(),
  }),
  /** The counterparty accepted exactly these stated terms. */
  acceptance_recorded: z.strictObject({
    offerId: Id,
    termsHash: z.string().length(64),
    messageId: Id,
    byPartyId: Id,
  }),
  agreement_recorded: z.strictObject({
    offerId: Id,
    terms: OfferTerms,
    termsHash: z.string().length(64),
    mandateRevision: z.number().int().min(1),
    acceptanceId: Id,
    approvalId: Id.nullable(),
  }),
  /** A drafted reply that failed the outgoing check and was never shown. */
  reply_blocked: z.strictObject({
    draftText: z.string().max(10_000),
    violations: z.array(z.strictObject({ rule: z.string().min(1).max(80), detail: ShortText })).min(1).max(20),
  }),
  /** What the channel reports it actually delivered. Approved wording alone proves nothing. */
  delivery_reported: z.strictObject({
    messageId: Id,
    status: z.enum(["delivered", "interrupted", "failed"]),
    /** For voice, the part actually spoken before an interruption. */
    deliveredText: z.string().max(10_000).nullable(),
    /** For voice: milliseconds from the end of the counterparty's speech to the start of this reply's audio. */
    audioStartMs: z.number().int().min(0).max(600_000).nullable().default(null),
  }),
  status_changed: z.strictObject({
    from: SessionStatus,
    to: SessionStatus,
    reason: ShortText,
    /** Who asked for this change, where known (e.g. the counterparty declined to continue). */
    requestedBy: z.enum(["principal", "counterparty", "agent", "system"]).nullable().default(null),
    /** Terms still open when the negotiation paused or ended. */
    unresolved: z.array(ShortText).max(20).default([]),
  }),
  /** Appends a corrected payload for an earlier event. The original stays. */
  correction: z.strictObject({
    correctsEventId: Id,
    replacement: z.record(z.string(), z.unknown()),
    reason: ShortText,
  }),
} as const;

export type EventType = keyof typeof PAYLOADS;
export const EVENT_TYPES = Object.keys(PAYLOADS) as EventType[];
export type PayloadOf<T extends EventType> = z.infer<(typeof PAYLOADS)[T]>;
/** What a caller may supply: fields with defaults can be left out. */
export type PayloadInput<T extends EventType> = z.input<(typeof PAYLOADS)[T]>;

/**
 * Events a counterparty may read. Everything else (mandates, private limits, decisions,
 * approvals, blocked replies, unsent proposals, internal status) is private.
 */
export const PUBLIC_EVENT_TYPES = new Set<EventType>([
  "message",
  "transcript_fragment",
  "offer_extracted",
  "term_requested",
  "acceptance_recorded",
  "agreement_recorded",
  "delivery_reported",
]);

/** Types whose channel must be stated. */
export const CHANNEL_EVENT_TYPES = new Set<EventType>(["message", "transcript_fragment", "delivery_reported"]);

/** What a caller supplies. ID is the idempotency key; the store assigns order and time. */
export interface NewEvent<T extends EventType = EventType> {
  id: string;
  type: T;
  channel: Channel | null;
  payload: PayloadInput<T>;
}

export interface RecordedEvent<T extends EventType = EventType> {
  id: string;
  sessionId: string;
  seq: number;
  recordedAt: string;
  type: T;
  actor: Actor;
  channel: Channel | null;
  visibility: "public" | "private";
  payload: PayloadOf<T>;
}

/** Order-independent fingerprint of offer terms. Approvals and agreements bind to it. */
export function hashTerms(terms: OfferTerm[]): string {
  const canonical = [...terms]
    .sort((a, b) => a.termId.localeCompare(b.termId))
    .map((t) => [t.termId, canonicalValue(t.value)]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function canonicalValue(value: Value): unknown {
  switch (value.type) {
    case "money":
      return ["money", value.amount, value.currency];
    case "quantity":
      return ["quantity", value.amount, value.unit?.toLowerCase() ?? null];
    case "boolean":
      return ["boolean", value.value];
    case "text":
    case "date_text":
      return [value.type, value.value.trim().toLowerCase()];
  }
}

/** Stable JSON for content comparison (idempotent retries). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
