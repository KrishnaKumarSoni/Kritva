/**
 * Live mapping runs against the real model. Every scenario in `cases/` is mapped once and
 * checked against its expected results; evidence is written to `test-results/epic-1/`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMappingLlmFromEnv } from "../../src/llm/config.ts";
import type { OpenAIStructuredLlm } from "../../src/llm/openai.ts";
import { mapToDraft, MAX_MAPPING_CALLS, type MappingResult } from "../../src/mapping/mapper.ts";
import { MAPPING_PROMPT_VERSION } from "../../src/mapping/prompt.ts";
import { listScenarios, loadScenario, type Scenario } from "../support/cases.ts";
import { checkExpectations, meaningSignature } from "../support/expectations.ts";
import { Recorder } from "../support/recorder.ts";

const hasKey = Boolean(process.env.OPENAI_API_KEY);
const CONCURRENCY = Number(process.env.KRITVA_LIVE_CONCURRENCY ?? 4);

describe.skipIf(!hasKey)("live mapping (Epic 1)", () => {
  const scenarios = listScenarios();
  const results = new Map<string, MappingResult>();
  const recorder = new Recorder();
  let llm: OpenAIStructuredLlm;

  beforeAll(async () => {
    llm = createMappingLlmFromEnv();
    const queue = [...scenarios];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) results.set(s.key, await mapToDraft(s.request, { llm }));
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }, 900_000);

  afterAll(() => {
    if (llm) recorder.write({ model: llm.model, promptVersion: MAPPING_PROMPT_VERSION });
  });

  const assertScenario = (scenario: Scenario, result: MappingResult, key = scenario.key) => {
    const checks = result.ok ? checkExpectations(result.draft, scenario.expect) : [];
    const run = recorder.record(key, scenario.story, scenario.description, result, checks);
    expect(result.stats.llmCalls).toBeLessThanOrEqual(MAX_MAPPING_CALLS);
    expect(result.ok, `${key} mapping failed: ${!result.ok ? JSON.stringify(result.error) : ""}`).toBe(true);
    for (const c of checks) expect(c.pass, `${key}: ${c.check}`).toBe(true);
    return run;
  };

  for (const scenario of scenarios) {
    it(`${scenario.key}: ${scenario.description}`, () => {
      assertScenario(scenario, results.get(scenario.key)!);
    });
  }

  it("same instructions as prose, bullets and key-value text keep the same meaning", () => {
    const groups = new Map<string, Scenario[]>();
    for (const s of scenarios) if (s.equivalenceGroup) groups.set(s.equivalenceGroup, [...(groups.get(s.equivalenceGroup) ?? []), s]);
    expect(groups.size).toBeGreaterThan(0);
    for (const [group, members] of groups) {
      const signatures = members.map((s) => {
        const r = results.get(s.key)!;
        return r.ok ? meaningSignature(r.draft) : [`failed:${s.key}`];
      });
      const same = signatures.every((sig) => JSON.stringify(sig) === JSON.stringify(signatures[0]));
      recorder.extraChecks.push({
        name: `equivalence: ${group}`,
        story: "2",
        pass: same,
        detail: members.map((s, i) => `${s.name} = [${signatures[i]!.join(", ")}]`).join(" / "),
      });
      expect(signatures, group).toEqual(members.map(() => signatures[0]));
    }
  });

  it("map bed, logo design, then bed: each result contains only its own case content", async () => {
    const sequence = [
      loadScenario("bed-sale", "listing-only"),
      loadScenario("logo-design", "five-terms"),
      loadScenario("bed-sale", "listing-only"),
    ];
    const outcomes: MappingResult[] = [];
    for (const [i, scenario] of sequence.entries()) {
      const result = await mapToDraft(scenario.request, { llm });
      outcomes.push(result);
      assertScenario(scenario, result, `isolation/${i + 1}-${scenario.key.replace("/", "-")}`);
    }
    const first = outcomes[0]!;
    const third = outcomes[2]!;
    const same = first.ok && third.ok && JSON.stringify(meaningSignature(first.draft)) === JSON.stringify(meaningSignature(third.draft));
    recorder.extraChecks.push({
      name: "isolation: bed before and after logo design",
      story: "3",
      pass: Boolean(same),
      detail: "bed drafts mapped before and after the logo case have the same meaning, and each passes its own forbidden-content checks",
    });
    expect(same).toBe(true);
  }, 600_000);
});
