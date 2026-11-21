import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MINIMAL_GUIDANCE, parseGuidance, validateConfirmedMandate, type StrategyGuidance } from "@kritva/core";
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
