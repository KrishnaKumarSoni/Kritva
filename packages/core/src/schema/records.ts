/**
 * Kritva shared schema.
 *
 * One fixed structure holds any negotiation case. Case content (term names, values,
 * units, conditions) lives in the data, never in these definitions. Adding or removing
 * a term is a data change, not a schema change.
 *
 * This module defines structure only. Cross-record rules (IDs, references, authority,
 * disclosure, provenance) live in `validate.ts`.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "kritva.draft/1" as const;

/** Who may see a piece of content. Governance enforces this before any reply is sent. */
export const Disclosure = z.enum(["public", "private"]);
export type Disclosure = z.infer<typeof Disclosure>;

/**
 * How we know a piece of content.
 * - stated: a source says it.
 * - inferred: derived from a source, but not said outright. Can never grant permission.
 * - unknown: not supplied. Carries no value.
 */
export const Epistemic = z.enum(["stated", "inferred", "unknown"]);
export type Epistemic = z.infer<typeof Epistemic>;

const Id = z.string().min(1).max(128);
const NonEmptyText = z.string().trim().min(1);

/** A link from an extracted item back to the exact source text it came from. */
export const SourceRef = z.strictObject({
  sourceId: Id,
  quote: NonEmptyText.max(2_000),
});
export type SourceRef = z.infer<typeof SourceRef>;

/** Case input as supplied by the host application. The app, not the model, sets author and disclosure. */
export const SourceFormat = z.enum(["prose", "list", "key_value", "mixed", "unspecified"]);
export const Source = z.strictObject({
  id: Id,
  authorPartyId: Id,
  disclosure: Disclosure,
  format: SourceFormat,
  label: z.string().max(200).nullable(),
  text: NonEmptyText.max(50_000),
});
export type Source = z.infer<typeof Source>;

export const Party = z.strictObject({
  id: Id,
  /** Free text supplied by the host app. Never assumed or defaulted by the core. */
  role: NonEmptyText.max(100),
  name: z.string().max(200).nullable(),
  isPrincipal: z.boolean(),
});
export type Party = z.infer<typeof Party>;

/** Typed values. Case meaning lives in the term the value belongs to. */
export const MoneyValue = z.strictObject({
  type: z.literal("money"),
  amount: z.number().finite().nonnegative(),
  /** ISO 4217 code when the source indicates one; null when the source does not say. */
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
});
export const QuantityValue = z.strictObject({
  type: z.literal("quantity"),
  amount: z.number().finite(),
  unit: z.string().trim().min(1).max(50).nullable(),
});
export const BooleanValue = z.strictObject({ type: z.literal("boolean"), value: z.boolean() });
export const TextValue = z.strictObject({ type: z.literal("text"), value: NonEmptyText.max(1_000) });
/** A date or time as written. Resolution to a calendar date is deferred. */
export const DateTextValue = z.strictObject({ type: z.literal("date_text"), value: NonEmptyText.max(200) });

export const Value = z.discriminatedUnion("type", [
  MoneyValue,
  QuantityValue,
  BooleanValue,
  TextValue,
  DateTextValue,
]);
export type Value = z.infer<typeof Value>;
export const ValueType = z.enum(["money", "quantity", "boolean", "text", "date_text"]);
export type ValueType = z.infer<typeof ValueType>;

const recordBase = {
  id: Id,
  status: Epistemic,
  disclosure: Disclosure,
  sourceRefs: z.array(SourceRef).max(20),
};

/** A negotiable dimension of the deal: price, pickup location, revision rounds, anything. */
export const Term = z.strictObject({
  ...recordBase,
  name: NonEmptyText.max(120),
  description: z.string().max(1_000).nullable(),
  valueType: ValueType,
  /** Default unit for quantity terms, when the source gives one. */
  unit: z.string().trim().min(1).max(50).nullable(),
  /** Currency for money terms, when the source gives one. */
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
});
export type Term = z.infer<typeof Term>;

export const GoalKind = z.enum(["objective", "need", "reason"]);
/**
 * What a party wants (objective), needs (e.g. "the room cleared soon"), or a reason it gives.
 * A need never implies a deadline, and urgency never grants permission to concede or disclose.
 */
export const Goal = z.strictObject({
  ...recordBase,
  partyId: Id,
  kind: GoalKind.default("objective"),
  description: NonEmptyText.max(1_000),
  /** Terms this goal concerns, when the source ties it to them. */
  termIds: z.array(Id).max(20).default([]),
  /** 1 is the highest priority. Null when the source gives no ordering. Never invented. */
  priority: z.number().int().min(1).max(100).nullable(),
});
export type Goal = z.infer<typeof Goal>;

/** A statement about the world, attributed to the party that asserted it. Recorded, not verified. */
export const Fact = z.strictObject({
  ...recordBase,
  partyId: Id,
  statement: NonEmptyText.max(1_000),
  termId: Id.nullable(),
  value: Value.nullable(),
});
export type Fact = z.infer<typeof Fact>;

/** A value a party puts forward for a term, such as an asking price or "delivery excluded". */
export const Position = z.strictObject({
  ...recordBase,
  partyId: Id,
  termId: Id,
  value: Value.nullable(),
  conditionIds: z.array(Id).max(20),
});
export type Position = z.infer<typeof Position>;

/**
 * minimum / maximum: a bound on a numeric term. must_equal / must_not_equal: a fixed value or an
 * excluded one. allowed_value: one permitted option; several on the same term form an option set.
 */
export const LimitKind = z.enum(["minimum", "maximum", "must_equal", "must_not_equal", "allowed_value"]);
/**
 * Whether an exception to a limit may be requested from the principal.
 * unspecified behaves like not_allowed: silence never authorizes an exception.
 */
export const LimitException = z.enum(["not_allowed", "with_approval", "unspecified"]);
/** A boundary the agent must not cross, such as a minimum acceptable price. */
export const Limit = z.strictObject({
  ...recordBase,
  partyId: Id,
  termId: Id,
  kind: LimitKind,
  value: Value.nullable(),
  conditionIds: z.array(Id).max(20),
  exception: LimitException.default("unspecified"),
});
export type Limit = z.infer<typeof Limit>;

/** The value a party hopes to reach on a term. Distinct from its asking value and from its limit. */
export const Target = z.strictObject({
  ...recordBase,
  partyId: Id,
  termId: Id,
  value: Value.nullable(),
  conditionIds: z.array(Id).max(20),
});
export type Target = z.infer<typeof Target>;

export const PreferenceStrength = z.enum(["preferred", "acceptable", "avoid"]);
/** A preference on a term. Never a fixed condition: other values stay possible unless a limit says otherwise. */
export const Preference = z.strictObject({
  ...recordBase,
  partyId: Id,
  termId: Id,
  value: Value.nullable(),
  strength: PreferenceStrength,
  conditionIds: z.array(Id).max(20),
});
export type Preference = z.infer<typeof Preference>;

/**
 * What a party says it will do if there is no agreement (its BATNA). Always the party's own
 * attributed statement, never a verified fact. An absent alternative stays unknown.
 */
export const Alternative = z.strictObject({
  ...recordBase,
  partyId: Id,
  description: NonEmptyText.max(1_000),
  value: Value.nullable(),
});
export type Alternative = z.infer<typeof Alternative>;

export const PermissionAction = z.enum([
  "accept_agreement",
  "propose_terms",
  "make_concession",
  "disclose_information",
  "end_without_agreement",
  "other",
]);
export const PermissionMode = z.enum(["autonomous", "requires_approval", "prohibited"]);
/** Authority the principal explicitly granted or withheld. Never inferred. */
export const Permission = z.strictObject({
  ...recordBase,
  partyId: Id,
  action: PermissionAction,
  mode: PermissionMode,
  /** Terms this permission covers. Empty means it applies to the whole deal. */
  termIds: z.array(Id).max(50),
  description: NonEmptyText.max(1_000),
  conditionIds: z.array(Id).max(20),
});
export type Permission = z.infer<typeof Permission>;

export const ConditionOperator = z.enum(["equals", "not_equals", "at_least", "at_most", "includes"]);
/** A condition attached to a position, limit or permission. */
export const Condition = z.strictObject({
  ...recordBase,
  description: NonEmptyText.max(1_000),
  termId: Id.nullable(),
  operator: ConditionOperator.nullable(),
  value: Value.nullable(),
});
export type Condition = z.infer<typeof Condition>;

export const IssueKind = z.enum(["missing", "conflict", "unsupported", "ambiguous"]);
/** Something the principal needs to resolve before the draft can be relied on. */
export const Issue = z.strictObject({
  id: Id,
  kind: IssueKind,
  message: NonEmptyText.max(2_000),
  relatedIds: z.array(Id).max(50),
  sourceRefs: z.array(SourceRef).max(20),
});
export type Issue = z.infer<typeof Issue>;

/**
 * A mandate draft. Mapping produces only unapproved drafts; approval and activation
 * belong to a later confirmation flow and cannot be expressed here.
 */
const mandateBody = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  caseId: Id,
  parties: z.array(Party).min(1).max(20),
  sources: z.array(Source).min(1).max(50),
  terms: z.array(Term).max(200),
  goals: z.array(Goal).max(100),
  facts: z.array(Fact).max(500),
  positions: z.array(Position).max(500),
  limits: z.array(Limit).max(500),
  targets: z.array(Target).max(200).default([]),
  preferences: z.array(Preference).max(200).default([]),
  alternatives: z.array(Alternative).max(50).default([]),
  permissions: z.array(Permission).max(200),
  conditions: z.array(Condition).max(200),
  issues: z.array(Issue).max(200),
};

export const MandateDraft = z.strictObject({
  ...mandateBody,
  approval: z.strictObject({ status: z.literal("unapproved") }),
});
export type MandateDraft = z.infer<typeof MandateDraft>;
/** A draft as written by hand or by a converter: fields with defaults may be left out. */
export type MandateDraftInput = z.input<typeof MandateDraft>;

/**
 * A mandate the principal reviewed and confirmed. Only a confirmed mandate can start a
 * negotiation. Every open issue must have been acknowledged at confirmation.
 */
export const ConfirmedMandate = z.strictObject({
  ...mandateBody,
  approval: z.strictObject({
    status: z.literal("confirmed"),
    /** Who confirmed, from application metadata. */
    confirmedBy: Id,
    confirmedAt: z.iso.datetime(),
    acknowledgedIssueIds: z.array(Id).max(200),
  }),
});
export type ConfirmedMandate = z.infer<typeof ConfirmedMandate>;

/** The record collections that carry case content, in a fixed order. */
export const RECORD_COLLECTIONS = [
  "terms",
  "goals",
  "facts",
  "positions",
  "limits",
  "targets",
  "preferences",
  "alternatives",
  "permissions",
  "conditions",
] as const;
export type RecordCollection = (typeof RECORD_COLLECTIONS)[number];
