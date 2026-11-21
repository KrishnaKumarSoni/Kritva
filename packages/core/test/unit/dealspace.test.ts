/** Epic 3: deal space. Deterministic: no model calls. Prices are test data. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDealSpace, termEntry } from "../../src/dealspace/catalog.ts";
import { checkProposal } from "../../src/dealspace/check.ts";
import { confirmMandate } from "../../src/mandate/confirm.ts";
import type { OfferTerm } from "../../src/record/events.ts";
import { validateDraft } from "../../src/schema/validate.ts";
import { conditionalMandate, listingOnlyDeliveryMandate, unsupportedConditionMandate } from "../support/mandates.ts";
import { loadDemoMandate } from "../support/record.ts";

const money = (amount: number) => ({ type: "money" as const, amount, currency: "INR" });
const day = (value: string): OfferTerm => ({ termId: "term_day", value: { type: "date_text", value } });
const price = (amount: number): OfferTerm => ({ termId: "term_price", value: money(amount) });
const pickup = (value: string): OfferTerm => ({ termId: "term_pickup", value: { type: "text", value } });
const delivery = (value: boolean): OfferTerm => ({ termId: "term_delivery", value: { type: "boolean", value } });

describe("Story 1: identify the terms available for negotiation", () => {
  it("bed description with age, size, price and collection: age and size stay facts; price and collection keep their status", () => {
    const mandate = loadDemoMandate();
    const space = buildDealSpace(mandate);
    expect(space.facts.map((f) => f.statement).join(" ")).toMatch(/one year old/);
    expect(space.facts.map((f) => f.statement).join(" ")).toMatch(/king-size/);
    // Neither age nor size is a negotiable term.
    expect(space.terms.map((t) => t.name).join(" ")).not.toMatch(/age|size/i);
    const priceTerm = space.terms.find((t) => t.valueType === "money")!;
    const pickupTerm = space.terms.find((t) => /pickup/.test(t.name))!;
    expect(priceTerm.kind).toBe("range");
    expect(pickupTerm.kind).toBe("stated");
    expect(pickupTerm.principalValue?.value).toEqual({ type: "text", value: "Koramangala, Bangalore" });
  });

  it("a fact-only term is descriptive, not a concession", () => {
    const space = buildDealSpace(
      conditionalMandateWith((d) => {
        d.terms.push({ id: "term_age", status: "stated", disclosure: "public", sourceRefs: [{ sourceId: "listing", quote: "one year old" }], name: "age", description: null, valueType: "text", unit: null, currency: null });
        d.facts[1]!.termId = "term_age";
      }),
    );
    expect(termEntry(space, "term_age")!.kind).toBe("descriptive");
    const check = checkProposal(space, [{ termId: "term_age", value: { type: "text", value: "new" } }]);
    expect(check.result).toBe("needs_clarification");
    expect(check.findings[0]!.basis).toBe("descriptive");
  });

  it("asking price ₹20,000 and confirmed minimum ₹18,000 stay separate", () => {
    const space = buildDealSpace(loadDemoMandate());
    const p = space.terms.find((t) => t.valueType === "money")!;
    expect(p.principalValue).toMatchObject({ value: money(20_000), disclosure: "public" });
    expect(p.rules).toEqual([expect.objectContaining({ kind: "minimum", value: money(18_000), disclosure: "private" })]);
    // The asking price is not the minimum: lower offers inside the range still fit.
    expect(checkProposal(space, [{ termId: p.termId, value: money(18_500) }]).result).toBe("fits");
    expect(checkProposal(space, [{ termId: p.termId, value: money(17_500) }]).result).toBe("conflicts");
  });

  it('"Collection from Koramangala only": other collection locations conflict with that restriction', () => {
    const space = buildDealSpace(conditionalMandate());
    expect(termEntry(space, "term_pickup")!.kind).toBe("fixed");
    const check = checkProposal(space, [price(19_500), pickup("Whitefield")]);
    expect(check.result).toBe("conflicts");
    expect(check.findings).toContainEqual(expect.objectContaining({ termId: "term_pickup", status: "conflict", ruleId: "limit_pickup_only" }));
    expect(checkProposal(space, [price(19_500), pickup("koramangala, bangalore")]).result).toBe("fits");
  });

  it("delivery excluded in the listing; paid delivery not addressed: absent from the offer, and unresolved", () => {
    const space = buildDealSpace(listingOnlyDeliveryMandate());
    const d = termEntry(space, "term_delivery")!;
    expect(d.kind).toBe("stated");
    expect(d.principalValue?.value).toEqual({ type: "boolean", value: false });
    const check = checkProposal(space, [price(19_000), delivery(true)], [{ name: "paid delivery", value: null }]);
    expect(check.result).toBe("needs_clarification");
    expect(check.findings).toContainEqual(expect.objectContaining({ termId: "term_delivery", status: "needs_clarification", basis: "unaddressed" }));
    expect(check.findings).toContainEqual(expect.objectContaining({ termId: null, termName: "paid delivery", basis: "new_term" }));
  });

  it("an unstated option stays unresolved: not assumed available or forbidden", () => {
    const space = buildDealSpace(
      conditionalMandateWith((d) => {
        d.terms.push({ id: "term_assembly", status: "unknown", disclosure: "private", sourceRefs: [], name: "assembly", description: null, valueType: "boolean", unit: null, currency: null });
      }),
    );
    expect(termEntry(space, "term_assembly")!.kind).toBe("unresolved");
    const yes = checkProposal(space, [{ termId: "term_assembly", value: { type: "boolean", value: true } }]);
    const no = checkProposal(space, [{ termId: "term_assembly", value: { type: "boolean", value: false } }]);
    expect(yes.result).toBe("needs_clarification");
    expect(no.result).toBe("needs_clarification");
  });

  it("confirmed restrictions stay intact, and the catalog points at the mandate's own records", () => {
    const mandate = conditionalMandate();
    const space = buildDealSpace(mandate);
    const priceRules = termEntry(space, "term_price")!.rules;
    expect(priceRules.map((r) => r.id).sort()).toEqual(["limit_min", "limit_min_saturday"]);
    for (const r of priceRules) {
      const original = mandate.limits.find((l) => l.id === r.id)!;
      expect(r.sourceRefs).toEqual(original.sourceRefs);
      expect(r.disclosure).toBe(original.disclosure);
    }
  });

  it("a new case needs case data only: the five-term logo case builds a deal space with no code change", () => {
    // A pinned case fixture, not live output, so the test stays deterministic.
    const raw = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../cases/logo-design/fixtures/five-terms.draft.json"), "utf8"));
    const draft = validateDraft(raw);
    if (!draft.ok) throw new Error("logo draft invalid");
    const confirmed = confirmMandate(draft.draft, { confirmedBy: "client", acknowledgedIssueIds: draft.draft.issues.map((i) => i.id) });
    if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.errors));
    const space = buildDealSpace(confirmed.mandate);
    expect(space.terms).toHaveLength(5);
    // Every term is classified from case data; none falls through as unresolved or descriptive.
    expect(space.terms.every((t) => ["stated", "range", "fixed", "options"].includes(t.kind))).toBe(true);
    expect(space.terms.some((t) => t.valueType === "money")).toBe(true);
  });
});

describe("Story 2: check proposals and preserve conditions", () => {
  const space = buildDealSpace(conditionalMandate());

  it("₹18,000 requires Saturday collection; the proposal matches both: fits", () => {
    const check = checkProposal(space, [price(18_000), day("Saturday"), pickup("Koramangala, Bangalore"), delivery(false)]);
    expect(check.result).toBe("fits");
    expect(check.findings).toContainEqual(expect.objectContaining({ termId: "term_price", status: "fits", basis: "condition", ruleId: "limit_min_saturday" }));
  });

  it("the same price with Sunday collection conflicts, and names the collection condition", () => {
    const check = checkProposal(space, [price(18_000), day("Sunday")]);
    expect(check.result).toBe("conflicts");
    expect(check.findings).toContainEqual(expect.objectContaining({ termId: "term_price", status: "conflict", basis: "condition", ruleId: "condition_saturday", relatedTermId: "term_day" }));
  });

  it("the same price with no collection day needs clarification", () => {
    const check = checkProposal(space, [price(18_000)]);
    expect(check.result).toBe("needs_clarification");
    expect(check.findings).toContainEqual(expect.objectContaining({ termId: "term_price", basis: "condition", relatedTermId: "term_day" }));
  });

  it("a price that meets the unconditional minimum fits on any day", () => {
    expect(checkProposal(space, [price(19_000), day("Sunday")]).result).toBe("fits");
    expect(checkProposal(space, [price(17_500), day("Saturday")]).result).toBe("conflicts");
  });

  it("a concession with an unsupported condition is preserved and never fits", () => {
    const unsupported = buildDealSpace(unsupportedConditionMandate());
    const check = checkProposal(unsupported, [price(18_000)]);
    expect(check.result).toBe("needs_clarification");
    expect(check.findings[0]).toMatchObject({ basis: "condition", ruleId: "condition_trust" });
    expect(check.findings[0]!.detail).toMatch(/cannot be checked automatically/);
    expect(termEntry(unsupported, "term_price")!.rules.find((r) => r.id === "limit_min_trust")!.conditions[0]!.checkable).toBe(false);
  });

  it("a conflict takes precedence over missing information, and both stay visible", () => {
    const check = checkProposal(space, [price(18_000), pickup("Whitefield")]);
    expect(check.result).toBe("conflicts");
    expect(check.findings.map((f) => f.status).sort()).toEqual(["conflict", "needs_clarification"]);
  });

  it("identical inputs give identical results; checking makes no model call", () => {
    const terms = [price(18_000), day("Saturday")];
    expect(checkProposal(space, terms)).toEqual(checkProposal(buildDealSpace(conditionalMandate()), structuredClone(terms)));
    for (const file of readdirSync(join(import.meta.dirname, "../../src/dealspace"))) {
      const text = readFileSync(join(import.meta.dirname, "../../src/dealspace", file), "utf8");
      expect(text, file).not.toMatch(/from\s+["'](openai|\.\.\/llm|\.\.\/mapping|\.\.\/negotiation)/);
      expect(text, file).not.toMatch(/\bbed\b|saturday|koramangala|collection|₹|\b18,?000\b/i);
    }
  });

  it("a passing result carries no permission or agreement", () => {
    const check = checkProposal(space, [price(19_500)]);
    expect(Object.keys(check).sort()).toEqual(["findings", "result"]);
  });
});

function conditionalMandateWith(edit: (d: import("../../src/schema/records.ts").MandateDraft) => void) {
  // Rebuild the conditional test mandate with an extra edit, then reconfirm it.
  const base = structuredClone(conditionalMandate()) as unknown as import("../../src/schema/records.ts").MandateDraft;
  (base as { approval: unknown }).approval = { status: "unapproved" };
  edit(base);
  const draft = validateDraft(base);
  if (!draft.ok) throw new Error(JSON.stringify(draft.errors));
  const confirmed = confirmMandate(draft.draft, { confirmedBy: "seller", acknowledgedIssueIds: draft.draft.issues.map((i) => i.id) });
  if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.errors));
  return confirmed.mandate;
}
