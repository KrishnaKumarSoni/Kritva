/**
 * Builds the comparison report from stored runs and their scores. Pure: the same runs give the
 * same report, byte for byte (no timestamps beyond those stored in the runs). Failed runs stay in
 * every table; nothing is dropped or hand-edited.
 */
import { MEASURES } from "./score.ts";
import type { Measure, RunRecord, RunScore, SystemName } from "./types.ts";

const MEASURE_LABEL: Record<Measure, string> = {
  private_limit_disclosure: "Private-limit disclosures",
  unauthorized_offer: "Unauthorized offers sent",
  invalid_agreement: "Invalid agreements",
  invented_fact: "Invented facts",
  incorrect_agreement_record: "Incorrect agreement records",
};

const SYSTEM_LABEL: Record<SystemName, string> = { kritva: "Kritva", plain: "Plain LLM" };

interface Group {
  runs: number;
  completed: number;
  failed: number;
  valid: number;
  noDeal: number;
  pending: number;
  missed: number;
  unresolved: number;
  invalid: number;
  clean: number;
  measures: Record<Measure, number>;
  blockedReplies: number;
  blockedMoves: number;
  review: number;
  buyerTurns: number[];
  interventions: number;
  prices: number[];
  calls: number[];
  tokens: number[];
  turnMs: number[];
}

function group(scores: RunScore[], runs: Map<string, RunRecord>): Group {
  const g: Group = {
    runs: scores.length,
    completed: 0,
    failed: 0,
    valid: 0,
    noDeal: 0,
    pending: 0,
    missed: 0,
    unresolved: 0,
    invalid: 0,
    clean: 0,
    measures: Object.fromEntries(MEASURES.map((m) => [m, 0])) as Record<Measure, number>,
    blockedReplies: 0,
    blockedMoves: 0,
    review: 0,
    buyerTurns: [],
    interventions: 0,
    prices: [],
    calls: [],
    tokens: [],
    turnMs: [],
  };
  for (const s of scores) {
    const r = runs.get(s.runId)!;
    if (s.status === "failed") g.failed += 1;
    else g.completed += 1;
    if (s.outcomeClass === "valid_agreement") g.valid += 1;
    if (s.outcomeClass === "appropriate_no_deal") g.noDeal += 1;
    if (s.outcomeClass === "pending_approval") g.pending += 1;
    if (s.outcomeClass === "missed_deal") g.missed += 1;
    if (s.outcomeClass === "unresolved") g.unresolved += 1;
    if (s.outcomeClass === "invalid_agreement") g.invalid += 1;
    const violations = MEASURES.reduce((n, m) => n + s.counts[m], 0);
    if ((s.outcomeClass === "valid_agreement" || s.outcomeClass === "appropriate_no_deal") && violations === 0 && s.review.length === 0) g.clean += 1;
    for (const m of MEASURES) g.measures[m] += s.counts[m];
    g.blockedReplies += s.blockedReplies;
    g.blockedMoves += s.blockedMoves;
    g.review += s.review.length;
    if (s.status === "completed") g.buyerTurns.push(s.buyerTurns);
    g.interventions += s.interventions;
    if (s.finalPrice !== null && s.outcomeClass === "valid_agreement") g.prices.push(s.finalPrice);
    g.calls.push(r.metrics.sellerCalls);
    g.tokens.push(r.metrics.sellerInputTokens + r.metrics.sellerOutputTokens);
    g.turnMs.push(...r.metrics.sellerTurnMs);
  }
  return g;
}

const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const fmt = (n: number | null, digits = 1) => (n === null ? "n/a" : Number.isInteger(n) ? String(n) : n.toFixed(digits));
const money = (n: number) => `₹${n.toLocaleString("en-IN")}`;

function row(label: string[], g: Group): string {
  const cells = [
    ...label,
    `${g.completed} of ${g.runs}${g.failed ? ` (${g.failed} failed)` : ""}`,
    String(g.valid),
    String(g.noDeal),
    String(g.pending),
    String(g.missed),
    String(g.unresolved),
    ...MEASURES.map((m) => String(g.measures[m])),
    String(g.clean),
    `${g.blockedReplies} / ${g.blockedMoves}`,
    String(g.review),
    fmt(mean(g.buyerTurns)),
    String(g.interventions),
    g.prices.length ? g.prices.map(money).join(", ") : "n/a",
    fmt(mean(g.calls)),
    fmt(mean(g.tokens), 0),
    g.turnMs.length ? `${(median(g.turnMs)! / 1000).toFixed(1)}s` : "n/a",
  ];
  return `| ${cells.join(" | ")} |`;
}

const HEADER = [
  "Runs completed",
  "Valid agreements",
  "Appropriate no-deal",
  "Pending approval",
  "Missed deals",
  "Unresolved",
  ...MEASURES.map((m) => MEASURE_LABEL[m]),
  "Clean runs",
  "Blocked before delivery (replies / moves)",
  "Needs review",
  "Buyer turns (mean)",
  "Seller interventions",
  "Final prices (valid agreements)",
  "Seller model calls / run",
  "Seller tokens / run",
  "Seller turn latency (median)",
];

export interface ReportMeta {
  label: string;
  generatedFrom: string;
  model: string;
  promptVersions: Record<string, Record<string, string>>;
  runsPerScenario: number;
}

export function markdownReport(runs: RunRecord[], scores: RunScore[], meta: ReportMeta): string {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const systems = [...new Set(scores.map((s) => s.system))].sort() as SystemName[];
  const scenarios = [...new Set(scores.map((s) => s.scenario))];
  const dates = runs.map((r) => r.startedAt).sort();
  const lines: string[] = [];
  lines.push(`# Kritva vs a plain LLM seller (${meta.label})`, "");
  lines.push(`- Runs: ${scores.length} (${scenarios.length} scenarios × ${meta.runsPerScenario} runs × ${systems.length} systems). Completed: ${scores.filter((s) => s.status === "completed").length}. Failed: ${scores.filter((s) => s.status === "failed").length}.`);
  lines.push(`- Run dates: ${dates[0] ?? "n/a"} to ${dates.at(-1) ?? "n/a"}`);
  lines.push(`- Base model for both sellers and the buyer simulator: ${meta.model}`);
  for (const [system, versions] of Object.entries(meta.promptVersions)) lines.push(`- ${SYSTEM_LABEL[system as SystemName] ?? system} prompts: ${Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  lines.push(`- Source data: \`${meta.generatedFrom}\`. Every count below is computed from those stored runs by \`apps/server/src/eval/score.ts\`; re-scoring gives the same numbers.`);
  lines.push("- Sample size is small and the buyers are simulated. These results say nothing about real-world conversion, revenue, or whether real buyers stay in an AI conversation.", "");

  lines.push("## Totals", "");
  lines.push(`| System | ${HEADER.join(" | ")} |`);
  lines.push(`| --- | ${HEADER.map(() => "---").join(" | ")} |`);
  for (const sys of systems) lines.push(row([SYSTEM_LABEL[sys]], group(scores.filter((s) => s.system === sys), byId)));
  lines.push("");

  lines.push("## By scenario", "");
  lines.push(`| Scenario | System | ${HEADER.join(" | ")} |`);
  lines.push(`| --- | --- | ${HEADER.map(() => "---").join(" | ")} |`);
  for (const sc of scenarios) for (const sys of systems) lines.push(row([sc, SYSTEM_LABEL[sys]], group(scores.filter((s) => s.system === sys && s.scenario === sc), byId)));
  lines.push("");

  lines.push("## Runs", "");
  lines.push("| Run | Outcome | Violations | Review | Buyer turns | Final terms | Calls | Status |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of scores) {
    const r = byId.get(s.runId)!;
    const v = MEASURES.filter((m) => s.counts[m] > 0).map((m) => `${MEASURE_LABEL[m]} ${s.counts[m]}`).join("; ") || "none";
    lines.push(`| [${s.runId}](#${anchor(s.runId)}) | ${s.outcomeClass.replace(/_/g, " ")} | ${v} | ${s.review.length} | ${s.buyerTurns} | ${s.finalTerms || "n/a"} | ${r.metrics.sellerCalls} | ${s.status}${r.error ? `: ${r.error}` : ""} |`);
  }
  lines.push("");

  lines.push("## Run details", "");
  for (const s of scores) {
    const r = byId.get(s.runId)!;
    lines.push(`### ${s.runId}`, "");
    lines.push(`- System: ${SYSTEM_LABEL[s.system]} · scenario ${s.scenario} · run ${s.run} · ${s.status}${r.error ? ` (${r.error})` : ""}`);
    lines.push(`- Outcome: ${s.outcomeClass.replace(/_/g, " ")}${s.feasible ? " · an authorized agreement was feasible for this buyer" : " · no authorized agreement was feasible for this buyer"}`);
    if (r.sessionId) lines.push(`- Kritva session: \`${r.sessionId}\``);
    for (const v of s.violations) lines.push(`- **${MEASURE_LABEL[v.measure]}** at \`${v.ref}\` (rule \`${v.rule}\`): ${v.detail} “${v.quote}”`);
    for (const x of s.review) lines.push(`- **Needs review** at \`${x.ref}\`: ${x.reason}${x.quote ? ` “${x.quote}”` : ""}`);
    if (r.decisions.length) lines.push(`- Strategy actions: ${r.decisions.map((d) => d.action ?? "none").join(", then ")}`);
    lines.push("", "| # | From | Message | Source |", "| --- | --- | --- | --- |");
    for (const t of r.transcript) lines.push(`| ${t.index} | ${t.from.replace("_", " ")} | ${t.text.replace(/\|/g, "\\|").replace(/\n/g, " ")} | \`${t.ref}\` |`);
    lines.push("");
  }
  return lines.join("\n");
}

function anchor(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
}

/** One row per run, with every count and the source IDs of each violation. */
export function csvReport(runs: RunRecord[], scores: RunScore[]): string {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const header = ["run_id", "system", "scenario", "run", "status", "error", "model", "started_at", "outcome", "feasible", ...MEASURES, "blocked_replies", "blocked_moves", "needs_review", "buyer_turns", "seller_interventions", "final_price", "final_terms", "seller_calls", "seller_failed_calls", "seller_input_tokens", "seller_output_tokens", "seller_turn_ms_median", "violation_refs"];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const s of scores) {
    const r = byId.get(s.runId)!;
    lines.push(
      [
        s.runId, s.system, s.scenario, s.run, s.status, r.error, r.model, r.startedAt, s.outcomeClass, s.feasible,
        ...MEASURES.map((m) => s.counts[m]),
        s.blockedReplies, s.blockedMoves, s.review.length, s.buyerTurns, s.interventions, s.finalPrice, s.finalTerms,
        r.metrics.sellerCalls, r.metrics.sellerFailedCalls, r.metrics.sellerInputTokens, r.metrics.sellerOutputTokens, median(r.metrics.sellerTurnMs),
        s.violations.map((v) => `${v.measure}@${v.ref}`).join(" "),
      ].map(esc).join(","),
    );
  }
  return lines.join("\n") + "\n";
}
