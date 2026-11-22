import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { principalSideOf, withPrincipalSide } from "../../src/mandate/library.ts";
import { readMandate } from "../../src/negotiation/mandate-view.ts";

/**
 * Kritva negotiates the main amount (the price), whatever order the mandate lists its terms in,
 * and a minimum on another term (a buyer's warranty, a seller's notice period) never decides
 * which side the principal is on.
 */
const base = JSON.parse(readFileSync(new URL("../../../../cases/office-chairs-purchase/mandates/vendor.confirmed.json", import.meta.url), "utf8"));
const ref = (quote: string) => [{ sourceId: "public-facts", quote }];

function chairs(options: { side?: "pays" | "receives" | null; warrantyMinimum?: boolean; priceLimit?: "minimum" | "maximum" } = {}) {
  const m = structuredClone(base);
  if (options.side !== undefined) m.principalSide = options.side;
  // Intake often lists the quantity before the price.
  m.terms.unshift({ id: "term_t_quantity", status: "stated", disclosure: "public", sourceRefs: ref("We're buying 40 ergonomic office chairs"), name: "chair quantity", description: "Number of chairs.", valueType: "quantity", unit: "chairs", currency: null });
  m.positions.unshift({ id: "position_p_quantity", status: "stated", disclosure: "public", sourceRefs: ref("We're buying 40 ergonomic office chairs"), partyId: "principal", termId: "term_t_quantity", value: { type: "quantity", amount: 40, unit: "chairs" }, conditionIds: [] });
  if (options.warrantyMinimum) {
    m.terms.unshift({ id: "term_t_warranty", status: "stated", disclosure: "public", sourceRefs: ref("at least a 3-year warranty"), name: "warranty", description: "Warranty length.", valueType: "quantity", unit: "years", currency: null });
    m.positions.unshift({ id: "position_p_warranty", status: "stated", disclosure: "public", sourceRefs: ref("at least a 3-year warranty"), partyId: "principal", termId: "term_t_warranty", value: { type: "quantity", amount: 3, unit: "years" }, conditionIds: [] });
    m.limits.unshift({ id: "limit_l_warranty_min", status: "stated", disclosure: "public", sourceRefs: ref("at least a 3-year warranty"), partyId: "principal", termId: "term_t_warranty", kind: "minimum", value: { type: "quantity", amount: 3, unit: "years" }, conditionIds: [], exception: "unspecified" });
  }
  if (options.priceLimit) m.limits.find((l: { id: string }) => l.id === "limit_l_price_max").kind = options.priceLimit;
  return m;
}

describe("The main amount: Kritva negotiates the price, wherever the mandate lists it", () => {
  it("a buyer's quantity listed before the price never becomes the negotiated term", () => {
    const n = readMandate(chairs()).negotiable;
    expect(n).toMatchObject({ termId: "term_t_price_per_chair", direction: "down", opening: 6000, limit: 7500, canConcede: true });
  });

  it("a buyer's minimum warranty, listed first, leaves the price as the negotiated term", () => {
    const view = readMandate(chairs({ warrantyMinimum: true }));
    expect(view.negotiable).toMatchObject({ termId: "term_t_price_per_chair", direction: "down", limit: 7500 });
    expect(view.principalSide).toBe("pays");
  });

  it("a seller's quantity listed first leaves the price as the negotiated term, moving up", () => {
    const n = readMandate(chairs({ side: "receives", priceLimit: "minimum" })).negotiable;
    expect(n).toMatchObject({ termId: "term_t_price_per_chair", direction: "up", limit: 7500 });
  });
});

describe("The principal's side is read from the price, not from other terms", () => {
  const draft = (m: Record<string, unknown>) => ({ ...m, approval: { status: "unapproved" as const } }) as never;

  it("a buyer's minimum warranty is not a conflict with paying", () => {
    const checked = withPrincipalSide(draft(chairs({ warrantyMinimum: true })), "pays");
    expect(checked.issues.some((i) => i.id === "issue_principal_side")).toBe(false);
  });

  it("a minimum on the price is still a conflict for a principal who pays", () => {
    const checked = withPrincipalSide(draft(chairs({ priceLimit: "minimum" })), "pays");
    expect(checked.issues.some((i) => i.id === "issue_principal_side")).toBe(true);
  });

  it("with no stated side, the price maximum says paying even when a warranty minimum comes first", () => {
    expect(principalSideOf(chairs({ side: null, warrantyMinimum: true }))).toBe("pays");
  });
});
