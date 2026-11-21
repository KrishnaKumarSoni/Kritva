/** Story 3, deterministic part: case content stays outside the core. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMappingUserMessage, MAPPING_SYSTEM_PROMPT } from "../../src/mapping/prompt.ts";
import { validateMappingRequest } from "../../src/mapping/request.ts";
import { listScenarios, loadScenario } from "../support/cases.ts";

const SRC = join(import.meta.dirname, "../../src");
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

/** Words and numbers that belong to the cases, never to the core. */
const CASE_CONTENT = [
  /\bbed\b/i, /\bking[- ]?size\b/i, /\bmattress/i, /koramangala/i, /bangalore|bengaluru/i, /\bolx\b/i,
  /\blogo\b/i, /\bsvg\b/i, /\bkickoff\b/i, /\bseller\b/i, /\bbuyer\b/i,
  /20,?000/, /18,?000/, /23,?000/, /5,?000/, /₹/, /\bINR\b/, /\brupee/i, /\bsaturday\b/i,
  /\bpickup\b/i, /\btruck\b/i,
];

describe("Story 3: no case content in core code or shared prompts", () => {
  it("core source files contain no fixed case facts or case-specific branches", () => {
    for (const file of filesUnder(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of CASE_CONTENT) {
        expect(pattern.test(text), `${pattern} found in ${file.replace(SRC, "src")}`).toBe(false);
      }
    }
  });

  it("the shared mapping prompt is case-neutral", () => {
    for (const pattern of CASE_CONTENT) expect(pattern.test(MAPPING_SYSTEM_PROMPT), String(pattern)).toBe(false);
  });

  it("the principal's role comes from input: one case sells, the other buys", () => {
    const bed = loadScenario("bed-sale", "listing-only").request;
    const logo = loadScenario("logo-design", "five-terms").request;
    expect(bed.parties.find((p) => p.isPrincipal)!.role).toBe("seller");
    expect(logo.parties.find((p) => p.isPrincipal)!.role).toBe("buyer");
  });
});

describe("Story 3: case fixtures", () => {
  const scenarios = listScenarios();

  it("every scenario is a valid mapping request", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(11);
    for (const s of scenarios) {
      const checked = validateMappingRequest(s.request);
      expect(checked.ok, `${s.key}: ${JSON.stringify(!checked.ok && checked.errors)}`).toBe(true);
    }
  });

  it("listing and private instructions are separate inputs with separate labels", () => {
    const { request } = loadScenario("bed-sale", "instructions-prose");
    expect(request.sources.map((s) => [s.id, s.disclosure])).toEqual([
      ["listing", "public"],
      ["instructions-prose", "private"],
    ]);
  });

  it("each request carries only its own case's sources", () => {
    const bed = buildMappingUserMessage(loadScenario("bed-sale", "instructions-prose").request);
    const logo = buildMappingUserMessage(loadScenario("logo-design", "five-terms").request);
    expect(bed).not.toMatch(/logo|svg/i);
    expect(logo).not.toMatch(/\bbed\b|koramangala|18,000/i);
  });

  it("changing a supplied fact changes the input the mapper sees", () => {
    const base = buildMappingUserMessage(loadScenario("bed-sale", "listing-only").request);
    const changed = buildMappingUserMessage(loadScenario("bed-sale", "asking-price-23000").request);
    const stripped = buildMappingUserMessage(loadScenario("bed-sale", "no-age-condition").request);
    expect(base).toContain("₹20,000");
    expect(changed).toContain("₹23,000");
    expect(changed).not.toContain("₹20,000");
    expect(stripped).not.toMatch(/one-year-old|good condition/i);
  });
});
