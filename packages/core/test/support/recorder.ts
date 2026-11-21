/** Writes live-run evidence: every draft, every check, and a readable summary. */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MappingResult } from "../../src/mapping/mapper.ts";
import type { CheckResult } from "./expectations.ts";

export const RESULTS_DIR = resolve(import.meta.dirname, "../../../../test-results/epic-1");

export interface RunRecord {
  key: string;
  story: string;
  description: string;
  ok: boolean;
  passed: boolean;
  llmCalls: number;
  repaired: boolean;
  repairReasons: Array<{ path: string; reason: string }>;
  latencyMs: number;
  model: string | null;
  errorCode: string | null;
  validationErrors: Array<{ path: string; reason: string }>;
  checks: CheckResult[];
}

export class Recorder {
  readonly runs: RunRecord[] = [];
  readonly extraChecks: Array<{ name: string; story: string; pass: boolean; detail: string }> = [];

  record(key: string, story: string, description: string, result: MappingResult, checks: CheckResult[]): RunRecord {
    const run: RunRecord = {
      key,
      story,
      description,
      ok: result.ok,
      passed: result.ok && checks.every((c) => c.pass),
      llmCalls: result.stats.llmCalls,
      repaired: result.stats.repaired,
      repairReasons: result.stats.repairReasons,
      latencyMs: result.stats.latencyMs,
      model: result.stats.model,
      errorCode: result.ok ? null : result.error.code,
      validationErrors: result.ok ? [] : result.error.validationErrors,
      checks,
    };
    this.runs.push(run);
    mkdirSync(join(RESULTS_DIR, "drafts"), { recursive: true });
    const file = join(RESULTS_DIR, "drafts", `${key.replace(/\//g, "__")}.json`);
    writeFileSync(file, `${JSON.stringify(result.ok ? result.draft : { error: result.error }, null, 2)}\n`);
    return run;
  }

  write(meta: { model: string; promptVersion: string }): void {
    mkdirSync(RESULTS_DIR, { recursive: true });
    let commit = "unknown";
    try {
      commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
      // Untracked files count too: results must never claim a commit they did not run.
      if (execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0) commit += " + uncommitted changes";
    } catch {}
    const runAt = new Date().toISOString();
    const summary = { runAt, commit, ...meta, runs: this.runs, extraChecks: this.extraChecks };
    writeFileSync(join(RESULTS_DIR, "live-results.json"), `${JSON.stringify(summary, null, 2)}\n`);

    const passed = this.runs.filter((r) => r.passed).length + this.extraChecks.filter((c) => c.pass).length;
    const total = this.runs.length + this.extraChecks.length;
    const lines = [
      "# Epic 1 live mapping results",
      "",
      `- Run at: ${runAt}`,
      `- Commit: ${commit}`,
      `- Model: ${meta.model}`,
      `- Prompt: ${meta.promptVersion}`,
      `- Result: **${passed} of ${total} passed**`,
      "",
      "| Scenario | Story | Result | Calls | Repaired | Latency | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...this.runs.map((r) => {
        const failed = r.checks.filter((c) => !c.pass).map((c) => c.check);
        const repair = r.repaired ? `repaired after: ${r.repairReasons.map((e) => `${e.path} ${e.reason}`).join("; ")}` : "";
        const notes = r.ok
          ? [repair, ...failed].filter(Boolean).join("; ")
          : `${r.errorCode}: ${r.validationErrors.map((e) => `${e.path} ${e.reason}`).join("; ")}`;
        return `| ${r.key} | ${r.story} | ${r.passed ? "pass" : "**fail**"} | ${r.llmCalls} | ${r.repaired ? "yes" : "no"} | ${(r.latencyMs / 1000).toFixed(1)}s | ${notes.replace(/\|/g, "\\|")} |`;
      }),
      "",
      "| Cross-scenario check | Story | Result | Detail |",
      "| --- | --- | --- | --- |",
      ...this.extraChecks.map((c) => `| ${c.name} | ${c.story} | ${c.pass ? "pass" : "**fail**"} | ${c.detail.replace(/\|/g, "\\|")} |`),
      "",
      "Each scenario's draft (or error) is in `drafts/`. Expected results live in `cases/*/scenarios/*.json`.",
      "",
    ];
    writeFileSync(join(RESULTS_DIR, "live-results.md"), lines.join("\n"));
  }
}
