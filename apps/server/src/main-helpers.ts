import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MINIMAL_GUIDANCE, parseGuidance, validateConfirmedMandate, type MandateLibrary, type StrategyGuidance } from "@kritva/core";
import type { MandateEntry } from "./app.ts";

/** Loads every confirmed mandate listed in cases/<case>/case.json. Invalid ones are skipped. */
export function loadConfirmedMandates(casesDir: string): MandateEntry[] {
  const entries: MandateEntry[] = [];
  for (const caseDir of readdirSync(casesDir, { withFileTypes: true })) {
    if (!caseDir.isDirectory()) continue;
    const caseFile = JSON.parse(readFileSync(join(casesDir, caseDir.name, "case.json"), "utf8")) as {
      description?: string;
      mandates?: Record<string, { file: string; description?: string; label?: string }>;
    };
    for (const [name, spec] of Object.entries(caseFile.mandates ?? {})) {
      const path = join(casesDir, caseDir.name, spec.file);
      if (!existsSync(path)) continue;
      const checked = validateConfirmedMandate(JSON.parse(readFileSync(path, "utf8")));
      if (!checked.ok) {
        console.warn(`Skipping ${caseDir.name}/${name}: not a valid confirmed mandate.`);
        continue;
      }
      entries.push({ id: `${caseDir.name}/${name}`, title: spec.label ?? spec.description ?? caseDir.name, description: spec.description ?? null, mandate: checked.mandate });
    }
  }
  return entries;
}

/**
 * Strategy guidance (tactic parameters as data). KRITVA_GUIDANCE names the file; "none" uses the
 * built-in minimal guidance. An invalid file is refused loudly rather than half-applied.
 */
export function loadGuidance(root: string): StrategyGuidance {
  const setting = process.env.KRITVA_GUIDANCE ?? "cases/bed-sale/strategy-guidance.json";
  if (setting === "none") return MINIMAL_GUIDANCE;
  const path = join(root, setting);
  if (!existsSync(path)) {
    console.warn(`Strategy guidance ${setting} not found; using the built-in minimal guidance.`);
    return MINIMAL_GUIDANCE;
  }
  return parseGuidance(JSON.parse(readFileSync(path, "utf8")));
}

export interface CaseExample {
  id: string;
  title: string;
  principalRole: string;
  counterpartyRole: string;
  publicText: string;
  privateText: string;
}

/** Example inputs for the mandate library, read from each case's case.json "example" block. Case content stays in cases/. */
export function loadExamples(casesDir: string): CaseExample[] {
  const out: CaseExample[] = [];
  for (const dir of readdirSync(casesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const caseFile = JSON.parse(readFileSync(join(casesDir, dir.name, "case.json"), "utf8")) as {
      sources?: Record<string, { file: string }>;
      example?: { title: string; principalRole: string; counterpartyRole: string; publicSource: string; privateSource: string | null };
    };
    const ex = caseFile.example;
    if (!ex) continue;
    const read = (key: string | null) => (key && caseFile.sources?.[key] ? readFileSync(join(casesDir, dir.name, caseFile.sources[key]!.file), "utf8").trim() : "");
    out.push({ id: dir.name, title: ex.title, principalRole: ex.principalRole, counterpartyRole: ex.counterpartyRole, publicText: read(ex.publicSource), privateText: read(ex.privateSource) });
  }
  return out;
}

export interface ListingConfig {
  caseId: string;
  title: string;
  location: string;
  /** The saved, confirmed library mandate the listing's calls use. */
  libraryId: string;
}

/**
 * Listings declared in cases/<case>/case.json. Each one's prepared confirmed mandate is saved in the
 * mandate library once (as revision 1), so the listing, "Call Seller" and "Change instructions" all
 * use one case-level mandate. Nothing is built from the public listing text.
 */
export function loadListings(casesDir: string, mandates: MandateEntry[], examples: CaseExample[], library: MandateLibrary | null): ListingConfig[] {
  const out: ListingConfig[] = [];
  for (const dir of readdirSync(casesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const caseFile = JSON.parse(readFileSync(join(casesDir, dir.name, "case.json"), "utf8")) as { listing?: { title: string; location: string; mandateFile: string; libraryId: string; libraryTitle: string } };
    const l = caseFile.listing;
    if (!l) continue;
    const entry = mandates.find((m) => m.id === l.mandateFile);
    const example = examples.find((e) => e.id === dir.name);
    if (library && entry && example) {
      library.importConfirmed({ mandateId: l.libraryId, title: l.libraryTitle, mandate: entry.mandate, input: { title: l.libraryTitle, principalRole: example.principalRole, counterpartyRole: example.counterpartyRole, publicText: example.publicText, privateText: example.privateText } });
    }
    out.push({ caseId: dir.name, title: l.title, location: l.location, libraryId: l.libraryId });
  }
  return out;
}
