/**
 * The shared negotiation record: one ordered list of events per session that text, voice,
 * the console, strategy, commitments and evaluations all read.
 *
 * Event content reuses Epic 1 structures (term IDs and typed values). Nothing here is
 * specific to any case.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { ConfirmedMandate, Value } from "../schema/records.ts";

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
  }),
  mandate_revised: z.strictObject({
    mandate: ConfirmedMandate,
    mandateRevision: z.number().int().min(2),
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
  }),
  /** Terms the agent intends to put forward. Proposed is not communicated. */
  offer_proposed: z.strictObject({
    byPartyId: Id,
    basis: z.enum(["counter", "final_terms"]),
    terms: OfferTerms,
    termsHash: z.string().length(64),
  }),
  /** A short, user-facing reason. Hidden model reasoning is never stored. */
  decision: z.strictObject({
    kind: DecisionKind,
    reason: ShortText,
    relatedEventIds: z.array(Id).max(20),
  }),
  approval_requested: z.strictObject({
    offerId: Id,
    termsHash: z.string().length(64),
    mandateRevision: z.number().int().min(1),
    acceptanceId: Id.nullable(),
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
  }),
  status_changed: z.strictObject({
    from: SessionStatus,
    to: SessionStatus,
    reason: ShortText,
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

/**
 * Events a counterparty may read. Everything else (mandates, private limits, decisions,
 * approvals, blocked replies, unsent proposals, internal status) is private.
 */
export const PUBLIC_EVENT_TYPES = new Set<EventType>([
  "message",
  "transcript_fragment",
  "offer_extracted",
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
  payload: PayloadOf<T>;
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
