/** Loads case fixtures from the repository's `cases/` folder into mapping requests. */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MappingRequest } from "../../src/mapping/request.ts";
import type { Matcher } from "./expectations.ts";

export const CASES_DIR = resolve(import.meta.dirname, "../../../../cases");

interface CaseFile {
  caseId: string;
  description: string;
  parties: MappingRequest["parties"];
  sources: Record<
    string,
    { file: string; authorPartyId: string; disclosure: "public" | "private"; format: MappingRequest["sources"][number]["format"]; label: string | null }
  >;
}

export interface ScenarioExpectations {
  minTerms?: number;
  require?: Matcher[];
  requireAny?: Matcher[][];
  forbid?: Matcher[];
  notSingle?: Matcher[];
  forbidText?: string[];
}

export interface Scenario {
  /** `<case>/<scenario>` */
  key: string;
  caseId: string;
  name: string;
  story: string;
  description: string;
  equivalenceGroup?: string;
  request: MappingRequest;
  expect: ScenarioExpectations;
}

export function loadCase(caseDir: string): CaseFile {
  return JSON.parse(readFileSync(join(CASES_DIR, caseDir, "case.json"), "utf8")) as CaseFile;
}

export function loadScenario(caseDir: string, scenarioName: string): Scenario {
  const kase = loadCase(caseDir);
  const raw = JSON.parse(readFileSync(join(CASES_DIR, caseDir, "scenarios", `${scenarioName}.json`), "utf8")) as {
    name: string;
    story: string;
    description: string;
    sources: string[];
    equivalenceGroup?: string;
    expect: ScenarioExpectations;
  };
  const sources = raw.sources.map((id) => {
    const entry = kase.sources[id];
    if (!entry) throw new Error(`Scenario ${caseDir}/${scenarioName} names unknown source ${id}`);
    return {
      id,
      authorPartyId: entry.authorPartyId,
      disclosure: entry.disclosure,
      format: entry.format,
      label: entry.label,
      text: readFileSync(join(CASES_DIR, caseDir, entry.file), "utf8").trim(),
    };
  });
  return {
    key: `${caseDir}/${raw.name}`,
    caseId: kase.caseId,
    name: raw.name,
    story: raw.story,
    description: raw.description,
    equivalenceGroup: raw.equivalenceGroup,
    request: { caseId: kase.caseId, parties: kase.parties, sources },
    expect: raw.expect,
  };
}

export function listScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const caseDir of readdirSync(CASES_DIR, { withFileTypes: true })) {
    if (!caseDir.isDirectory()) continue;
    const dir = join(CASES_DIR, caseDir.name, "scenarios");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      scenarios.push(loadScenario(caseDir.name, file.replace(/\.json$/, "")));
    }
  }
  return scenarios;
}
