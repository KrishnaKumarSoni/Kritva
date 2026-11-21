/**
 * Operator tool: map a case's mandate sources, show the draft for review, and save it
 * as a confirmed mandate. Run with --confirm to acknowledge every open issue and write.
 *
 *   node --env-file=../../.env scripts/prepare-mandate.ts bed-sale demo [--confirm]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMappingLlmFromEnv } from "../src/llm/config.ts";
import { confirmMandate } from "../src/mandate/confirm.ts";
import { mapToDraft } from "../src/mapping/mapper.ts";
import { CASES_DIR, loadCase } from "../test/support/cases.ts";

const [caseDir, mandateName, flag] = process.argv.slice(2);
if (!caseDir || !mandateName) {
  console.error("usage: prepare-mandate.ts <case> <mandate> [--confirm]");
  process.exit(2);
}
const kase = loadCase(caseDir) as ReturnType<typeof loadCase> & {
  mandates: Record<string, { sources: string[]; file: string }>;
};
const spec = kase.mandates[mandateName];
if (!spec) throw new Error(`Unknown mandate ${mandateName}`);

const request = {
  caseId: kase.caseId,
  parties: kase.parties,
  sources: spec.sources.map((id) => {
    const s = kase.sources[id]!;
    return { id, authorPartyId: s.authorPartyId, disclosure: s.disclosure, format: s.format, label: s.label, text: readFileSync(join(CASES_DIR, caseDir, s.file), "utf8").trim() };
  }),
};

const result = await mapToDraft(request, { llm: createMappingLlmFromEnv() });
if (!result.ok) {
  console.error(JSON.stringify(result.error, null, 2));
  process.exit(1);
}
const d = result.draft;
const termName = new Map(d.terms.map((t) => [t.id, t.name]));
console.log(`terms: ${d.terms.map((t) => `${t.name} (${t.valueType})`).join(", ")}`);
for (const p of d.positions) console.log(`position  ${p.partyId} ${termName.get(p.termId)} = ${JSON.stringify(p.value)} [${p.disclosure}]`);
for (const l of d.limits) console.log(`limit     ${l.partyId} ${termName.get(l.termId)} ${l.kind} ${JSON.stringify(l.value)} [${l.disclosure}]`);
for (const p of d.permissions) console.log(`permission ${p.action} ${p.mode}: ${p.description}`);
for (const f of d.facts) console.log(`fact      ${f.statement} [${f.disclosure}]`);
for (const i of d.issues) console.log(`issue     ${i.id} ${i.kind}: ${i.message}`);

if (flag !== "--confirm") {
  console.log("\nReview only. Re-run with --confirm to acknowledge the issues above and save.");
  process.exit(0);
}
const principal = d.parties.find((p) => p.isPrincipal)!;
const confirmed = confirmMandate(d, { confirmedBy: principal.id, acknowledgedIssueIds: d.issues.map((i) => i.id) });
if (!confirmed.ok) {
  console.error(JSON.stringify(confirmed.errors, null, 2));
  process.exit(1);
}
const out = join(CASES_DIR, caseDir, spec.file);
writeFileSync(out, `${JSON.stringify(confirmed.mandate, null, 2)}\n`);
console.log(`\nSaved confirmed mandate to ${out}`);
