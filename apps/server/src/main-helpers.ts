import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateConfirmedMandate } from "@kritva/core";
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
