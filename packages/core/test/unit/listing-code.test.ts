/** Listing codes: the four digits a caller gives on the shared phone line (docs/Kritva_Phone_Calls.md, section 16). */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { dammCheckDigit, isListingCode, listingCodeDigits, listingCodeFor, pickListingCode } from "../../src/mandate/listing-code.ts";
import { MandateLibrary, SqliteLibraryBackend } from "../../src/mandate/library.ts";
import type { StructuredLlm } from "../../src/llm/types.ts";
import { loadDemoMandate, tempDbPath } from "../support/record.ts";

describe("listing codes", () => {
  it("uses the Damm check digit", () => {
    // The worked example of the Damm algorithm: 572 has check digit 4.
    expect(dammCheckDigit("572")).toBe(4);
    expect(listingCodeFor(572)).toBe("5724");
    expect(isListingCode("5724")).toBe(true);
  });

  it("makes every single-digit error and every swap of neighbouring digits invalid", () => {
    for (let base = 100; base <= 999; base += 1) {
      const code = listingCodeFor(base);
      expect(isListingCode(code)).toBe(true);
      for (let i = 0; i < 4; i += 1) {
        for (let d = 0; d <= 9; d += 1) {
          if (String(d) === code[i]) continue;
          expect(isListingCode(code.slice(0, i) + d + code.slice(i + 1))).toBe(false);
        }
        if (i < 3 && code[i] !== code[i + 1]) expect(isListingCode(code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2))).toBe(false);
      }
    }
  });

  it("refuses codes of the wrong shape", () => {
    expect(isListingCode("0000")).toBe(false);
    expect(isListingCode("572")).toBe(false);
    expect(isListingCode("57240")).toBe(false);
    expect(isListingCode("57a4")).toBe(false);
  });

  it("reads the digits from what was heard, in any script", () => {
    expect(listingCodeDigits("5 7 2 4")).toBe("5724");
    expect(listingCodeDigits("57-24.")).toBe("5724");
    expect(listingCodeDigits("५७२४")).toBe("5724");
    expect(listingCodeDigits("௫௭௨௪")).toBe("5724");
    expect(listingCodeDigits("five seven")).toBe("");
  });

  it("picks unused codes first, then the one released longest ago", () => {
    const all = Array.from({ length: 900 }, (_, i) => listingCodeFor(100 + i));
    expect(pickListingCode(new Set(all.slice(1)), [], () => 0)).toBe(all[0]);
    expect(pickListingCode(new Set(all.slice(2)), [all[1]!, all[0]!])).toBe(all[1]);
    expect(pickListingCode(new Set(all), [])).toBeNull();
  });
});

describe("listing codes on saved mandates", () => {
  const llm: StructuredLlm = { generate: async () => { throw new Error("not used"); } };
  const mandate = loadDemoMandate();
  const input = { title: "Demo", principalRole: "seller", counterpartyRole: "buyer", publicText: "x", privateText: "" };

  it("gives a live mandate a code, finds the mandate by it, and keeps it across revisions and pauses", () => {
    const lib = new MandateLibrary({ backend: new SqliteLibraryBackend(tempDbPath()), mappingLlm: llm });
    const a = lib.importConfirmed({ mandateId: "m_a", title: "A", mandate, input });
    const b = lib.importConfirmed({ mandateId: "m_b", title: "B", mandate, input });
    expect(isListingCode(a.listingCode!)).toBe(true);
    expect(isListingCode(b.listingCode!)).toBe(true);
    expect(a.listingCode).not.toBe(b.listingCode);
    expect(lib.findByListingCode(a.listingCode!)).toBe("m_a");
    expect(lib.list().map((m) => m.listingCode)).toEqual([a.listingCode, b.listingCode]);
    lib.setLifecycle("m_a", "paused");
    lib.setLifecycle("m_a", "closed");
    expect(lib.get("m_a")!.listingCode).toBe(a.listingCode);
    expect(lib.findByListingCode(a.listingCode!)).toBe("m_a");
    expect(lib.ensureListingCode("m_a")).toBe(a.listingCode);
  });

  it("releases the code when the mandate is deleted", () => {
    const lib = new MandateLibrary({ backend: new SqliteLibraryBackend(tempDbPath()), mappingLlm: llm });
    const a = lib.importConfirmed({ mandateId: "m_a", title: "A", mandate, input });
    lib.setLifecycle("m_a", "deleted");
    expect(lib.get("m_a")!.listingCode).toBeNull();
    expect(lib.findByListingCode(a.listingCode!)).toBeNull();
    expect(lib.findByListingCode("5724")).toBeNull();
  });

  it("gives mandates saved before codes existed a code", () => {
    const path = tempDbPath();
    const lib = new MandateLibrary({ backend: new SqliteLibraryBackend(path), mappingLlm: llm });
    lib.importConfirmed({ mandateId: "m_a", title: "A", mandate, input });
    // As if saved before listing codes: no code rows at all.
    const db = new DatabaseSync(path);
    db.exec("DROP TRIGGER library_listing_codes_no_update; DELETE FROM library_listing_codes;");
    db.close();
    const again = new MandateLibrary({ backend: new SqliteLibraryBackend(path), mappingLlm: llm });
    expect(again.get("m_a")!.listingCode).toBeNull();
    expect(again.ensureListingCodes()).toBe(1);
    expect(isListingCode(again.get("m_a")!.listingCode!)).toBe(true);
    expect(again.ensureListingCodes()).toBe(0);
  });
});
