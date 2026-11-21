/**
 * The model-facing extraction format. It is deliberately flatter than the shared schema
 * (strict JSON-schema mode needs every field present), and it is never stored: `convert.ts`
 * turns it into a draft, and the draft is what gets validated.
 *
 * Party and source IDs are enums built from the request, so the model cannot name a
 * party or source the application did not supply.
 */
export type ExtractedValueType = "money" | "quantity" | "boolean" | "text" | "date_text";
type Status = "stated" | "inferred" | "unknown";

export interface ExtractedValue {
  type: ExtractedValueType;
  amount: number | null;
  currency: string | null;
  unit: string | null;
  text: string | null;
  boolean: boolean | null;
}

export interface ExtractedQuote {
  source_id: string;
  quote: string;
}

export interface ExtractedTerm {
  ref: string;
  name: string;
  description: string | null;
  value_type: ExtractedValueType;
  unit: string | null;
  currency: string | null;
  status: Status;
  quotes: ExtractedQuote[];
}

export interface ExtractedGoal {
  ref: string;
  party_id: string;
  description: string;
  priority: number | null;
  status: Status;
  quotes: ExtractedQuote[];
}

export interface ExtractedFact {
  ref: string;
  party_id: string;
  statement: string;
  term_ref: string | null;
  value: ExtractedValue | null;
  status: Status;
  quotes: ExtractedQuote[];
}

export interface ExtractedPosition {
  ref: string;
  party_id: string;
  term_ref: string;
  value: ExtractedValue | null;
  condition_refs: string[];
  status: Status;
  quotes: ExtractedQuote[];
}

export interface ExtractedLimit {
  ref: string;
  party_id: string;
  term_ref: string;
  kind: "minimum" | "maximum" | "must_equal" | "must_not_equal" | "allowed_value";
  value: ExtractedValue | null;
  condition_refs: string[];
  status: Status;
  quotes: ExtractedQuote[];
}

export interface ExtractedPermission {
  ref: string;
  action: string;
  mode: "autonomous" | "requires_approval" | "prohibited";
  term_refs: string[];
  description: string;
  condition_refs: string[];
  status: "stated" | "inferred";
  quotes: ExtractedQuote[];
}

export interface ExtractedCondition {
  ref: string;
  description: string;
  term_ref: string | null;
  operator: string | null;
  value: ExtractedValue | null;
  status: Status;
  quotes: ExtractedQuote[];
}

export interface ExtractedIssue {
  kind: "missing" | "conflict" | "unsupported" | "ambiguous";
  message: string;
  related: Array<{ collection: string; ref: string }>;
  quotes: ExtractedQuote[];
}

export interface Extraction {
  terms: ExtractedTerm[];
  goals: ExtractedGoal[];
  facts: ExtractedFact[];
  positions: ExtractedPosition[];
  limits: ExtractedLimit[];
  permissions: ExtractedPermission[];
  conditions: ExtractedCondition[];
  issues: ExtractedIssue[];
}

export const EXTRACTION_COLLECTIONS = [
  "terms",
  "goals",
  "facts",
  "positions",
  "limits",
  "permissions",
  "conditions",
] as const;

const VALUE_TYPES = ["money", "quantity", "boolean", "text", "date_text"] as const;
const STATUS = ["stated", "inferred", "unknown"] as const;
const PERMISSION_ACTIONS = [
  "accept_agreement",
  "propose_terms",
  "make_concession",
  "disclose_information",
  "end_without_agreement",
  "other",
] as const;

const str = { type: "string" };
const nullableStr = { type: ["string", "null"] };
const enumOf = (values: readonly string[]) => ({ type: "string", enum: [...values] });
const nullableEnum = (values: readonly string[]) => ({ type: ["string", "null"], enum: [...values, null] });
const arr = (items: unknown) => ({ type: "array", items });
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export function buildExtractionJsonSchema(partyIds: string[], sourceIds: string[]): Record<string, unknown> {
  const value = obj({
    type: enumOf(VALUE_TYPES),
    amount: { type: ["number", "null"] },
    currency: nullableStr,
    unit: nullableStr,
    text: nullableStr,
    boolean: { type: ["boolean", "null"] },
  });
  const nullableValue = { anyOf: [value, { type: "null" }] };
  const quotes = arr(obj({ source_id: enumOf(sourceIds), quote: str }));
  const partyId = enumOf(partyIds);
  const status = enumOf(STATUS);

  return obj({
    terms: arr(
      obj({
        ref: str,
        name: str,
        description: nullableStr,
        value_type: enumOf(VALUE_TYPES),
        unit: nullableStr,
        currency: nullableStr,
        status,
        quotes,
      }),
    ),
    goals: arr(
      obj({ ref: str, party_id: partyId, description: str, priority: { type: ["integer", "null"] }, status, quotes }),
    ),
    facts: arr(
      obj({ ref: str, party_id: partyId, statement: str, term_ref: nullableStr, value: nullableValue, status, quotes }),
    ),
    positions: arr(
      obj({ ref: str, party_id: partyId, term_ref: str, value: nullableValue, condition_refs: arr(str), status, quotes }),
    ),
    limits: arr(
      obj({
        ref: str,
        party_id: partyId,
        term_ref: str,
        kind: enumOf(["minimum", "maximum", "must_equal", "must_not_equal", "allowed_value"]),
        value: nullableValue,
        condition_refs: arr(str),
        status,
        quotes,
      }),
    ),
    permissions: arr(
      obj({
        ref: str,
        action: enumOf(PERMISSION_ACTIONS),
        mode: enumOf(["autonomous", "requires_approval", "prohibited"]),
        term_refs: arr(str),
        description: str,
        condition_refs: arr(str),
        status: enumOf(["stated", "inferred"]),
        quotes,
      }),
    ),
    conditions: arr(
      obj({
        ref: str,
        description: str,
        term_ref: nullableStr,
        operator: nullableEnum(["equals", "not_equals", "at_least", "at_most", "includes"]),
        value: nullableValue,
        status,
        quotes,
      }),
    ),
    issues: arr(
      obj({
        kind: enumOf(["missing", "conflict", "unsupported", "ambiguous"]),
        message: str,
        related: arr(obj({ collection: enumOf(EXTRACTION_COLLECTIONS), ref: str })),
        quotes,
      }),
    ),
  });
}
