/**
 * Hand-built confirmed mandates for deal-space tests. All prices here are test data, not the
 * live seller's mandate. Each record quotes its source exactly, as the validator requires.
 */
import { confirmMandate, type ValidConfirmedMandate } from "../../src/mandate/confirm.ts";
import { SCHEMA_VERSION, type MandateDraft, type Value } from "../../src/schema/records.ts";
import { validateDraft } from "../../src/schema/validate.ts";

export const LISTING = "King-size bed, one year old, good condition. Price: ₹20,000. Pickup from Koramangala, Bangalore. Delivery is not included.";

interface Options {
  instructions: string;
  /** Extra records, written against the sources above. */
  build: (d: MandateDraft) => void;
}

const money = (amount: number): Value => ({ type: "money", amount, currency: "INR" });
const ref = (sourceId: string, quote: string) => [{ sourceId, quote }];

export function buildMandate({ instructions, build }: Options): ValidConfirmedMandate {
  const d: MandateDraft = {
    schemaVersion: SCHEMA_VERSION,
    caseId: "deal-space-test",
    approval: { status: "unapproved" },
    parties: [
      { id: "seller", role: "seller", name: null, isPrincipal: true },
      { id: "buyer", role: "buyer", name: null, isPrincipal: false },
    ],
    sources: [
      { id: "listing", authorPartyId: "seller", disclosure: "public", format: "prose", label: "Listing", text: LISTING },
      { id: "instructions", authorPartyId: "seller", disclosure: "private", format: "prose", label: "Instructions", text: instructions },
    ],
    terms: [
      { id: "term_price", status: "stated", disclosure: "public", sourceRefs: ref("listing", "Price: ₹20,000"), name: "price", description: null, valueType: "money", unit: null, currency: "INR" },
      { id: "term_pickup", status: "stated", disclosure: "public", sourceRefs: ref("listing", "Pickup from Koramangala, Bangalore"), name: "pickup location", description: null, valueType: "text", unit: null, currency: null },
      { id: "term_delivery", status: "stated", disclosure: "public", sourceRefs: ref("listing", "Delivery is not included"), name: "delivery included", description: null, valueType: "boolean", unit: null, currency: null },
    ],
    goals: [],
    facts: [
      { id: "fact_size", status: "stated", disclosure: "public", sourceRefs: ref("listing", "King-size bed"), partyId: "seller", statement: "The bed is king-size.", termId: null, value: null },
      { id: "fact_age", status: "stated", disclosure: "public", sourceRefs: ref("listing", "one year old"), partyId: "seller", statement: "The bed is one year old.", termId: null, value: null },
    ],
    positions: [
      { id: "position_price", status: "stated", disclosure: "public", sourceRefs: ref("listing", "Price: ₹20,000"), partyId: "seller", termId: "term_price", value: money(20_000), conditionIds: [] },
      { id: "position_pickup", status: "stated", disclosure: "public", sourceRefs: ref("listing", "Pickup from Koramangala, Bangalore"), partyId: "seller", termId: "term_pickup", value: { type: "text", value: "Koramangala, Bangalore" }, conditionIds: [] },
      { id: "position_delivery", status: "stated", disclosure: "public", sourceRefs: ref("listing", "Delivery is not included"), partyId: "seller", termId: "term_delivery", value: { type: "boolean", value: false }, conditionIds: [] },
    ],
    limits: [],
    permissions: [
      { id: "permission_negotiate", status: "stated", disclosure: "private", sourceRefs: ref("instructions", "You can negotiate the price"), partyId: "seller", action: "propose_terms", mode: "autonomous", termIds: ["term_price"], description: "May negotiate the price.", conditionIds: [] },
      { id: "permission_accept", status: "stated", disclosure: "private", sourceRefs: ref("instructions", "Ask me before accepting any offer"), partyId: "seller", action: "accept_agreement", mode: "requires_approval", termIds: [], description: "Ask before accepting.", conditionIds: [] },
    ],
    conditions: [],
    issues: [],
  };
  build(d);
  const draft = validateDraft(d);
  if (!draft.ok) throw new Error(`test mandate invalid: ${JSON.stringify(draft.errors)}`);
  const confirmed = confirmMandate(draft.draft, { confirmedBy: "seller", acknowledgedIssueIds: draft.draft.issues.map((i) => i.id) });
  if (!confirmed.ok) throw new Error(`test mandate not confirmed: ${JSON.stringify(confirmed.errors)}`);
  return confirmed.mandate;
}

/** Minimum ₹19,000; ₹18,000 only with Saturday collection; collection from Koramangala only. */
export const CONDITIONAL_INSTRUCTIONS =
  "You can negotiate the price, but don't go below ₹19,000. I'll accept ₹18,000 only if collection is on Saturday. Collection from Koramangala only. Ask me before accepting any offer.";

export function conditionalMandate(minimum = 19_000): ValidConfirmedMandate {
  const instructions = minimum === 19_000 ? CONDITIONAL_INSTRUCTIONS : CONDITIONAL_INSTRUCTIONS.replace("₹19,000", `₹${minimum.toLocaleString("en-IN")}`);
  return buildMandate({
    instructions,
    build: (d) => {
      d.terms.push({ id: "term_day", status: "stated", disclosure: "private", sourceRefs: ref("instructions", "collection is on Saturday"), name: "collection day", description: null, valueType: "date_text", unit: null, currency: null });
      d.conditions.push({ id: "condition_saturday", status: "stated", disclosure: "private", sourceRefs: ref("instructions", "only if collection is on Saturday"), description: "Collection is on Saturday", termId: "term_day", operator: "equals", value: { type: "date_text", value: "Saturday" } });
      d.limits.push(
        { id: "limit_min", status: "stated", disclosure: "private", sourceRefs: ref("instructions", `don't go below ₹${minimum.toLocaleString("en-IN")}`), partyId: "seller", termId: "term_price", kind: "minimum", value: money(minimum), conditionIds: [] },
        { id: "limit_min_saturday", status: "stated", disclosure: "private", sourceRefs: ref("instructions", "I'll accept ₹18,000 only if collection is on Saturday"), partyId: "seller", termId: "term_price", kind: "minimum", value: money(18_000), conditionIds: ["condition_saturday"] },
        { id: "limit_pickup_only", status: "stated", disclosure: "private", sourceRefs: ref("instructions", "Collection from Koramangala only"), partyId: "seller", termId: "term_pickup", kind: "must_equal", value: { type: "text", value: "Koramangala, Bangalore" }, conditionIds: [] },
      );
    },
  });
}

/** A concession whose condition is only described in words, so it cannot be checked in code. */
export function unsupportedConditionMandate(): ValidConfirmedMandate {
  return buildMandate({
    instructions: "You can negotiate the price, but don't go below ₹19,000. ₹18,000 is fine if the buyer seems trustworthy. Ask me before accepting any offer.",
    build: (d) => {
      d.conditions.push({ id: "condition_trust", status: "stated", disclosure: "private", sourceRefs: ref("instructions", "if the buyer seems trustworthy"), description: "The buyer seems trustworthy", termId: null, operator: null, value: null });
      d.limits.push(
        { id: "limit_min", status: "stated", disclosure: "private", sourceRefs: ref("instructions", "don't go below ₹19,000"), partyId: "seller", termId: "term_price", kind: "minimum", value: money(19_000), conditionIds: [] },
        { id: "limit_min_trust", status: "stated", disclosure: "private", sourceRefs: ref("instructions", "₹18,000 is fine if the buyer seems trustworthy"), partyId: "seller", termId: "term_price", kind: "minimum", value: money(18_000), conditionIds: ["condition_trust"] },
      );
    },
  });
}

/** The listing alone excludes delivery; paid delivery is never addressed. */
export function listingOnlyDeliveryMandate(minimum = 18_000): ValidConfirmedMandate {
  const amount = `₹${minimum.toLocaleString("en-IN")}`;
  return buildMandate({
    instructions: `You can negotiate the price, but don't go below ${amount}. Ask me before accepting any offer.`,
    build: (d) => {
      d.limits.push({ id: "limit_min", status: "stated", disclosure: "private", sourceRefs: ref("instructions", `don't go below ${amount}`), partyId: "seller", termId: "term_price", kind: "minimum", value: money(minimum), conditionIds: [] });
    },
  });
}
