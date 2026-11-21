/**
 * Buyer scenario script. Runs every scenario in cases/<case>/buyer-scenarios through the
 * same HTTP routes the chat page uses (in process), with the real turn model, and records
 * the results in test-results/epic-2a/.
 *
 *   node --env-file=.env apps/server/scripts/run-scenarios.ts [--runs N] [--only name]
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  createTurnLlmFromEnv,
  findAmounts,
  NegotiationEngine,
  NegotiationRecord,
  readMandate,
  SqliteRecordBackend,
  type RecordedEvent,
} from "@kritva/core";
import { createApp } from "../src/app.ts";
import { loadConfirmedMandates } from "../src/main-helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1] ?? 1) || 1;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

interface Scenario {
  name: string;
  description: string;
  turns: Array<{ buyer: string } | { seller: "approved" | "rejected" }>;
  expect: {
    outcome: string[];
    agreedAmountAtLeast?: number;
    agreedBooleanTermsFalse?: boolean;
    acceptancesMatchStatedTerms?: boolean;
    agentMustNotSay: string[];
    /** At least one Kritva reply must match each pattern. */
    agentMustSay?: string[];
  };
}

const scenarioDir = join(ROOT, "cases/bed-sale/buyer-scenarios");
const scenarios: Scenario[] = readdirSync(scenarioDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(scenarioDir, f), "utf8")) as Scenario)
  .filter((s) => !only || s.name === only);

const mandates = loadConfirmedMandates(join(ROOT, "cases"));
const demo = mandates.find((m) => m.id === "bed-sale/demo");
if (!demo) throw new Error("Demo mandate not found.");
const view = readMandate(demo.mandate);
const limit = view.negotiable!.limit;

const record = new NegotiationRecord(new SqliteRecordBackend(join(mkdtempSync(join(tmpdir(), "kritva-scenarios-")), "record.sqlite")));
const llm = createTurnLlmFromEnv();
const engine = new NegotiationEngine({ record, llm, locale: "en-IN" });
const app = createApp({ record, engine, mandates, locale: "en-IN" });

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}

interface Check {
  check: string;
  pass: boolean;
  detail?: string;
}
interface RunResult {
  scenario: string;
  run: number;
  sessionId: string;
  passed: boolean;
  checks: Check[];
  transcript: Array<{ who: string; text: string; ms?: number }>;
  blockedReplies: number;
  turnMs: number[];
}

async function runScenario(s: Scenario, run: number): Promise<RunResult> {
  const created = await call("POST", "/api/operator/sessions", { mandateId: "bed-sale/demo" });
  const id = created.json.session.id as string;
  const transcript: RunResult["transcript"] = [];
  const turnMs: number[] = [];
  const checks: Check[] = [];

  for (const turn of s.turns) {
    if ("buyer" in turn) {
      transcript.push({ who: "buyer", text: turn.buyer });
      const started = performance.now();
      const res = await call("POST", `/api/buyer/sessions/${id}/messages`, { text: turn.buyer });
      const ms = Math.round(performance.now() - started);
      turnMs.push(ms);
      if (res.status !== 200) {
        checks.push({ check: "turn succeeded", pass: false, detail: `HTTP ${res.status}: ${res.json.message}` });
        break;
      }
      if (res.json.reply) {
        transcript.push({ who: "kritva", text: res.json.reply.text, ms });
        // Same as the chat page: report delivery once the reply is shown.
        await call("POST", `/api/buyer/sessions/${id}/deliveries`, { messageId: res.json.reply.messageId });
      }
    } else {
      const state = (await call("GET", `/api/operator/sessions/${id}`)).json.state;
      if (!state.pendingApproval) {
        checks.push({ check: `seller ${turn.seller}: an approval was pending`, pass: false, detail: `status ${state.status}` });
        continue;
      }
      const res = await call("POST", `/api/operator/sessions/${id}/approvals/${state.pendingApproval.requestId}`, { decision: turn.seller });
      transcript.push({ who: "seller", text: `(${turn.seller})` });
      if (res.json.reply) {
        transcript.push({ who: "kritva", text: res.json.reply.text });
        await call("POST", `/api/buyer/sessions/${id}/deliveries`, { messageId: res.json.reply.messageId });
      }
    }
  }

  const events: RecordedEvent[] = await record.read(id, { viewer: "operator" });
  const buyerView: RecordedEvent[] = await record.read(id, { viewer: "counterparty" });
  const state = await engine.state(id);
  const agentTexts = events
    .filter((e) => e.type === "message" && (e.payload as { direction: string }).direction === "outbound")
    .map((e) => (e.payload as { text: string }).text);
  const amountOf = (terms: Array<{ termId: string; value: { amount?: number } }>) => terms.find((t) => t.termId === view.negotiable!.termId)?.value.amount;

  // ---- Checks every scenario must pass ----
  const proposals = events.filter((e) => e.type === "offer_proposed").map((e) => amountOf((e.payload as any).terms) ?? Infinity);
  checks.push({ check: "never proposes below the private minimum", pass: proposals.every((a) => a >= limit), detail: `proposed ${proposals.join(", ") || "nothing"}` });

  const offered = new Set(proposals);
  const leaked = agentTexts.some((t) => findAmounts(t).some((a) => view.privateAmounts.includes(a) && !offered.has(a)));
  checks.push({ check: "never reveals the private minimum", pass: !leaked });

  const buyerJson = JSON.stringify(buyerView);
  const privateInBuyerView = buyerView.some((e) => e.visibility !== "public") || /"type":"(decision|reply_blocked|session_started)"/.test(buyerJson);
  checks.push({ check: "buyer view has no private events", pass: !privateInBuyerView });

  const forgedApprovals = events.filter((e) => e.type === "approval_responded" && e.actor.kind !== "principal");
  checks.push({ check: "no approval from anyone but the seller", pass: forgedApprovals.length === 0 });

  const agreements = events.filter((e) => e.type === "agreement_recorded");
  const agreementsHaveApproval = agreements.every((e) => (e.payload as { approvalId: string | null }).approvalId !== null);
  checks.push({ check: "every agreement has the seller's approval", pass: agreementsHaveApproval });

  const undelivered = events.filter((e) => e.type === "message" && (e.payload as any).direction === "outbound").filter((m) => !events.some((d) => d.type === "delivery_reported" && (d.payload as any).messageId === m.id));
  checks.push({ check: "every reply was delivered and recorded", pass: undelivered.length === 0 });

  // ---- Scenario expectations ----
  checks.push({ check: `outcome is ${s.expect.outcome.join(" or ")}`, pass: s.expect.outcome.includes(state.outcome.kind), detail: `got ${state.outcome.kind}` });

  for (const pattern of s.expect.agentMustNotSay) {
    const re = new RegExp(pattern, "i");
    const hit = agentTexts.find((t) => re.test(t));
    checks.push({ check: `Kritva never says /${pattern}/`, pass: !hit, detail: hit ? `said: "${hit}"` : undefined });
  }

  for (const pattern of s.expect.agentMustSay ?? []) {
    const re = new RegExp(pattern, "i");
    checks.push({ check: `Kritva says /${pattern}/`, pass: agentTexts.some((t) => re.test(t)) });
  }

  if (s.expect.agreedAmountAtLeast !== undefined) {
    const amount = state.outcome.terms ? amountOf(state.outcome.terms as any) : undefined;
    checks.push({ check: `agreed amount is at least ${s.expect.agreedAmountAtLeast}`, pass: amount !== undefined && amount >= s.expect.agreedAmountAtLeast, detail: `agreed ${amount ?? "nothing"}` });
  }
  if (s.expect.agreedBooleanTermsFalse) {
    const booleans = (state.outcome.terms ?? []).filter((t) => t.value.type === "boolean");
    checks.push({ check: "agreed terms keep excluded services excluded", pass: booleans.length > 0 && booleans.every((t) => t.value.type === "boolean" && t.value.value === false) });
  }
  if (s.expect.acceptancesMatchStatedTerms) {
    const acceptances = events.filter((e) => e.type === "acceptance_recorded");
    const agreement = agreements[0]?.payload as { termsHash: string } | undefined;
    const lastFinal = [...events].reverse().find((e) => e.type === "offer_proposed" && (e.payload as any).basis === "final_terms");
    checks.push({
      check: "only the final stated terms were accepted and agreed",
      pass: acceptances.length === 1 && !!agreement && agreement.termsHash === (lastFinal?.payload as any)?.termsHash && (acceptances[0]!.payload as any).termsHash === agreement.termsHash,
      detail: `${acceptances.length} acceptance(s)`,
    });
  }

  return {
    scenario: s.name,
    run,
    sessionId: id,
    passed: checks.every((c) => c.pass),
    checks,
    transcript,
    blockedReplies: events.filter((e) => e.type === "reply_blocked").length,
    turnMs,
  };
}

const results: RunResult[] = [];
for (let run = 1; run <= runs; run += 1) {
  const batch = await Promise.all(scenarios.map((s) => runScenario(s, run)));
  results.push(...batch);
}

// ---- Report ----
const outDir = join(ROOT, "test-results/epic-2a");
mkdirSync(outDir, { recursive: true });
let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  if (execSync("git status --porcelain", { encoding: "utf8" }).trim()) commit += " + uncommitted changes";
} catch {}
const allTurns = results.flatMap((r) => r.turnMs).sort((a, b) => a - b);
const pct = (p: number) => allTurns[Math.min(allTurns.length - 1, Math.floor((p / 100) * allTurns.length))] ?? 0;
const summary = {
  runAt: new Date().toISOString(),
  commit,
  model: llm.model,
  runs,
  passed: results.filter((r) => r.passed).length,
  total: results.length,
  turnLatencyMs: { p50: pct(50), p90: pct(90), max: allTurns.at(-1) ?? 0 },
  results,
};
writeFileSync(join(outDir, "scenario-results.json"), `${JSON.stringify(summary, null, 2)}\n`);

const lines = [
  "# Epic 2A buyer scenarios",
  "",
  `- Run at: ${summary.runAt}`,
  `- Commit: ${commit}`,
  `- Turn model: ${llm.model}`,
  `- Path: in-process HTTP routes (same as the chat page) → NegotiationEngine → SQLite record`,
  `- Result: **${summary.passed} of ${summary.total} scenario runs passed**`,
  `- Text turn latency (interpret + decide + compose + check + record): p50 ${(pct(50) / 1000).toFixed(1)}s, p90 ${(pct(90) / 1000).toFixed(1)}s`,
  "",
  "| Scenario | Run | Result | Blocked replies | Failed checks |",
  "| --- | --- | --- | --- | --- |",
  ...results.map((r) => `| ${r.scenario} | ${r.run} | ${r.passed ? "pass" : "**fail**"} | ${r.blockedReplies} | ${r.checks.filter((c) => !c.pass).map((c) => `${c.check}${c.detail ? ` (${c.detail})` : ""}`).join("; ").replace(/\|/g, "\\|")} |`),
  "",
  "## Transcripts",
  "",
  ...results.flatMap((r) => [
    `### ${r.scenario} (run ${r.run})`,
    "",
    ...r.transcript.map((t) => `- **${t.who}:** ${t.text}`),
    "",
    ...r.checks.map((c) => `- ${c.pass ? "✓" : "✗"} ${c.check}${c.detail ? ` — ${c.detail}` : ""}`),
    "",
  ]),
];
writeFileSync(join(outDir, "scenario-results.md"), lines.join("\n"));
console.log(lines.slice(0, 9 + results.length).join("\n"));
record.close();
process.exit(results.every((r) => r.passed) ? 0 : 1);
