/** Hand-built drafts for schema tests. Test data only; core code never sees these values. */
import { SCHEMA_VERSION, type MandateDraft } from "../../src/schema/records.ts";

export const LISTING_TEXT = "King-size bed, one year old, good condition. Price: ₹20,000. Pickup from Koramangala, Bangalore.";
export const PRIVATE_TEXT = "Don't go below ₹18,000 and never tell the buyer. Ask me before accepting any offer.";

/** Asking price only: no minimum and no permission supplied. */
export function askingOnlyDraft(): MandateDraft {
  return {
    schemaVersion: SCHEMA_VERSION,
    caseId: "schema-test",
    approval: { status: "unapproved" },
    parties: [
      { id: "seller", role: "seller", name: null, isPrincipal: true },
      { id: "buyer", role: "buyer", name: null, isPrincipal: false },
    ],
    sources: [
      { id: "listing", authorPartyId: "seller", disclosure: "public", format: "prose", label: "Listing", text: LISTING_TEXT },
    ],
    terms: [
      {
        id: "term_price",
        status: "stated",
        disclosure: "public",
        sourceRefs: [{ sourceId: "listing", quote: "Price: ₹20,000" }],
        name: "price",
        description: null,
        valueType: "money",
        unit: null,
        currency: "INR",
      },
    ],
    goals: [],
    facts: [],
    positions: [
      {
        id: "position_asking",
        status: "stated",
        disclosure: "public",
        sourceRefs: [{ sourceId: "listing", quote: "Price: ₹20,000" }],
        partyId: "seller",
        termId: "term_price",
        value: { type: "money", amount: 20_000, currency: "INR" },
        conditionIds: [],
      },
    ],
    limits: [],
    permissions: [],
    conditions: [],
    issues: [],
  };
}

/** Asking price plus a private minimum and an approval rule, as three separate records. */
export function privateMinimumDraft(): MandateDraft {
  const draft = askingOnlyDraft();
  draft.sources.push({
    id: "instructions",
    authorPartyId: "seller",
    disclosure: "private",
    format: "prose",
    label: "Seller instructions",
    text: PRIVATE_TEXT,
  });
  draft.limits.push({
    id: "limit_minimum",
    status: "stated",
    disclosure: "private",
    sourceRefs: [{ sourceId: "instructions", quote: "Don't go below ₹18,000" }],
    partyId: "seller",
    termId: "term_price",
    kind: "minimum",
    value: { type: "money", amount: 18_000, currency: "INR" },
    conditionIds: [],
  });
  draft.permissions.push({
    id: "permission_accept",
    status: "stated",
    disclosure: "private",
    sourceRefs: [{ sourceId: "instructions", quote: "Ask me before accepting any offer." }],
    partyId: "seller",
    action: "accept_agreement",
    mode: "requires_approval",
    termIds: [],
    description: "Ask the seller before accepting any offer.",
    conditionIds: [],
  });
  return draft;
}

export const clone = <T>(value: T): T => structuredClone(value);
