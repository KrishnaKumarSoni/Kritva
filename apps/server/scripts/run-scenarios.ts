/**
 * Buyer scenario script. Runs every scenario in cases/<case>/buyer-scenarios through the
 * same HTTP routes the chat page uses (in process), with the real turn model, and records
 * the results in test-results/scenarios/<label>/.
 *
 *   node --env-file=.env apps/server/scripts/run-scenarios.ts [--runs N] [--only name] [--label epic-3] [--save-replays]
 *
 * The engine and routes are built from the same case configuration as the running app (listing
 * name, availability, fulfillment vocabulary, per-case guidance). With --save-replays, every
 * scenario marked "replay" stores its model responses and per-turn results in
 * cases/<case>/replays/, which the server tests replay without a model.
 *
 * Kritva runs as the agent (OpenAI Agents SDK) on KRITVA_AGENT_MODEL. With --bridge, the agent's
 * reading and wording come from the structured turn model instead (the earlier pipeline's prompts),
 * through the same agent loop, as an A/B baseline.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  createMappingLlmFromEnv,
  MandateLibrary,
  MandateRevisions,
  SqliteLibraryBackend,
  createAgentFromEnv,
  createTurnLlmFromEnv,
  DEFAULT_TURN_MODEL,
  findAmounts,
  NegotiationEngine,
  NegotiationRecord,
  readMandate,
  SqliteRecordBackend,
  type RecordedEvent,
} from "@kritva/core";
import { createApp } from "../src/app.ts";
import { loadCaseRuntime, loadGuidance } from "../src/main-helpers.ts";
import { checkTurn, playTurns, RecordingAgentModel, RecordingLlm, type ReplayFixture, type ScenarioTurn } from "../src/eval/replay.ts";
import { OpenAIProvider } from "@openai/agents";
import { runComparison, systemPromptVersions } from "../src/eval/compare.ts";
import { csvReport, markdownReport } from "../src/eval/report.ts";
import { scoreRun } from "../src/eval/score.ts";
import type { Judge, RunRecord, SimulatorSpec } from "../src/eval/types.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1] ?? 1) || 1;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

interface Scenario {
  name: string;
  /** Confirmed mandate to run against; defaults to the demo mandate. */
  mandate?: string;
  description: string;
  turns: ScenarioTurn[];
  /** Store this scenario's model responses as a replay fixture when run with --save-replays. */
  replay?: boolean;
  expect: {
    outcome: string[];
    agreedAmountAtLeast?: number;
    agreedBooleanTermsFalse?: boolean;
    acceptancesMatchStatedTerms?: boolean;
    agentMustNotSay: string[];
    /** At least one Kritva reply must match each pattern. */
    agentMustSay?: string[];
    /** Agreed terms must include these term-name → value pairs. */
    agreedTermEquals?: Record<string, string>;
    /** Each listed result must appear among the checks of the buyer's proposals. */
    buyerCheckResults?: Array<"fits" | "conflicts" | "needs_clarification">;
    /** No accepted terms below this amount, unless the named term has the named value. */
    noAcceptedOfferBelow?: { amount: number; unlessTerm: Record<string, string> };
    /** The principal's standing minimum after the run (an exception must not change it). */
    standingMinimum?: number;
    /** An exception approval was requested during the run. */
    exceptionRequested?: boolean;
    /** Replies sent while paused carry no offer. */
    pausedTurnsHaveNoOffers?: boolean;
    /** Who ended the negotiation without agreement (Epic 7). */
    endedBy?: "counterparty" | "agent" | "principal";
    /** Kinds of questions Kritva asked (Epic 8), e.g. budget_scope, authority, conditional, terms_probe. */
    questionKindsAsked?: string[];
    /** Strategy actions that must appear among the recorded decisions (Epic 8). */
    decisionActions?: string[];
    /** No offer the buyer received is below this amount. */
    noOfferBelow?: number;
    /** A reply that carries no new offer does not restate an amount the previous reply already said. */
    noPriceRepeatedInARow?: boolean;
  };
}

const scenarioDir = join(ROOT, "cases/bed-sale/buyer-scenarios");
const scenarios: Scenario[] = readdirSync(scenarioDir)
  .filter((f) => f.endsWith(".json"))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
  .map((f) => JSON.parse(readFileSync(join(scenarioDir, f), "utf8")) as Scenario)
  .filter((s) => !only || only.split(",").includes(s.name));

const runtimeDir = mkdtempSync(join(tmpdir(), "kritva-scenarios-"));
const mappingLlm = createMappingLlmFromEnv();
const library = new MandateLibrary({ backend: new SqliteLibraryBackend(join(runtimeDir, "library.sqlite")), mappingLlm });
const runtime = loadCaseRuntime(ROOT, library);
const mandates = runtime.mandates;

// ---- Epic 10: Kritva vs a plain LLM seller, on the same scenarios (only those with a buyer simulator) ----
if (args.includes("--compare") || args.includes("--rescore")) {
  await comparisonCli();
  process.exit(0);
}

async function comparisonCli(): Promise<void> {
  const compareLabel = args.includes("--label") ? args[args.indexOf("--label") + 1]! : args.includes("--rescore") ? args[args.indexOf("--rescore") + 1]! : "latest";
  const outDir = join(ROOT, "test-results/comparison", compareLabel);
  mkdirSync(outDir, { recursive: true });
  const runsFile = join(outDir, "runs.json");
  const stored: RunRecord[] = existsSync(runsFile) ? (JSON.parse(readFileSync(runsFile, "utf8")) as { runs: RunRecord[] }).runs : [];
  const judge = JSON.parse(readFileSync(join(ROOT, "cases/bed-sale/evaluation.json"), "utf8")) as Judge;
  const simulated = scenarios.filter((x): x is Scenario & { simulator: SimulatorSpec } => Boolean((x as { simulator?: unknown }).simulator));
  const perScenario = Number(args[args.indexOf("--runs") + 1] ?? 3) || 3;
  let all = stored;
  if (args.includes("--compare")) {
    if (stored.length > 0 && !args.includes("--resume")) throw new Error(`Results for "${compareLabel}" already exist. Use --resume to finish missing runs, or a new --label.`);
    const model = process.env.KRITVA_TURN_MODEL ?? DEFAULT_TURN_MODEL;
    const save = (list: RunRecord[]) => writeFileSync(runsFile, `${JSON.stringify({ label: compareLabel, runs: list }, null, 2)}\n`);
    const fresh = await runComparison({
      label: compareLabel,
      scenarios: simulated.map((x) => ({ name: x.name, mandate: x.mandate ?? "bed-sale/demo", simulator: x.simulator })),
      runsPerScenario: perScenario,
      systems: ["kritva", "plain"],
      mandates,
      judge,
      guidance: loadGuidance(ROOT, "bed-sale"),
      sellerLlm: () => createTurnLlmFromEnv(),
      agent: args.includes("--bridge") ? undefined : createAgentFromEnv(),
      buyerLlm: createTurnLlmFromEnv(),
      model,
      dataDir: mkdtempSync(join(tmpdir(), "kritva-compare-")),
      locale: "en-IN",
      existing: stored,
      concurrency: Number(args[args.indexOf("--concurrency") + 1] ?? 4) || 4,
      onRun: (r) => {
        all = [...all.filter((x) => x.runId !== r.runId), r];
        save(all);
        console.log(`${r.status === "completed" ? "done" : "FAILED"} ${r.runId} → ${r.outcome.kind}${r.error ? ` (${r.error})` : ""}`);
      },
    });
    void fresh;
  }
  const order = (r: RunRecord) => `${simulated.findIndex((x) => x.name === r.scenario).toString().padStart(2, "0")}:${r.run}:${r.system}`;
  all = [...all].sort((x, y) => order(x).localeCompare(order(y)));
  const specs = new Map(simulated.map((x) => [x.name, x.simulator]));
  const scores = all.map((r) => scoreRun(r, judge, specs.get(r.scenario)!));
  const meta = {
    label: compareLabel,
    generatedFrom: `test-results/comparison/${compareLabel}/runs.json`,
    model: [...new Set(all.map((r) => r.model))].join(", ") || "unknown",
    promptVersions: { kritva: all.find((r) => r.system === "kritva")?.promptVersions ?? systemPromptVersions("kritva"), plain: all.find((r) => r.system === "plain")?.promptVersions ?? systemPromptVersions("plain") },
    runsPerScenario: perScenario,
  };
  writeFileSync(join(outDir, "comparison.md"), markdownReport(all, scores, meta));
  writeFileSync(join(outDir, "comparison.csv"), csvReport(all, scores));
  writeFileSync(join(outDir, "scores.json"), `${JSON.stringify(scores, null, 2)}\n`);
  console.log(`${scores.length} runs (${scores.filter((x) => x.status === "failed").length} failed). Report: test-results/comparison/${compareLabel}/comparison.md`);
}

const viewFor = (id: string) => {
  const entry = mandates.find((m) => m.id === id);
  if (!entry) throw new Error(`Mandate ${id} not found.`);
  return readMandate(entry.mandate);
};

const record = new NegotiationRecord(new SqliteRecordBackend(join(runtimeDir, "record.sqlite")));
const llm = createTurnLlmFromEnv();
const saveReplays = args.includes("--save-replays");
const bridge = args.includes("--bridge");
const agentConfig = createAgentFromEnv();
const agentModel = bridge ? null : await new OpenAIProvider().getModel(agentConfig.agentModel);

/** One engine and app per scenario run, built like the running app, so each run's model calls can be recorded on their own. */
function stack() {
  const recording = new RecordingLlm(llm);
  const agent = agentModel ? { agentModel: new RecordingAgentModel(agentModel, recording.calls), agentModelSettings: agentConfig.agentModelSettings } : {};
  const engine = new NegotiationEngine({ record, llm: recording, ...agent, locale: "en-IN", guidance: runtime.defaultGuidance, guidanceByCase: runtime.guidanceByCase, subjectFacts: runtime.subjectFacts, listingDetails: runtime.listingDetails });
  const revisions = new MandateRevisions({ record, engine, mappingLlm });
  const app = createApp({ record, engine, revisions, mandates, locale: "en-IN", library, examples: runtime.examples, listings: runtime.listings });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { recording, engine, call };
}

const observedTurns = new Map<string, Array<import("../src/eval/replay.ts").TurnObservation>>();

function commitLabel(): string {
  try {
    const head = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    return execSync("git status --porcelain", { encoding: "utf8" }).trim() ? `${head} + uncommitted changes` : head;
  } catch {
    return "unknown";
  }
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
  blockedRules: string[];
  turnMs: number[];
}

async function runScenario(s: Scenario, run: number): Promise<RunResult> {
  const mandateId = s.mandate ?? "bed-sale/demo";
  const view = viewFor(mandateId);
  const { recording, engine, call } = stack();
  const created = await call("POST", "/api/operator/sessions", { mandateId });
  const id = created.json.session.id as string;
  const transcript: RunResult["transcript"] = [];
  const turnMs: number[] = [];
  const checks: Check[] = [];

  // Every turn goes through the shared driver, which also observes what the turn delivered and decided.
  for (const turn of s.turns) {
    const started = performance.now();
    const played = await playTurns(call, record, id, [turn], view.negotiable?.termId ?? null);
    const ms = Math.round(performance.now() - started);
    if ("buyer" in turn) {
      turnMs.push(ms);
      transcript.push({ who: "buyer", text: turn.buyer });
    } else {
      transcript.push({ who: "seller", text: `(${turn.seller})` });
    }
    if (played.error) {
      checks.push({ check: "turn succeeded", pass: false, detail: played.error });
      if ("buyer" in turn) break;
      continue;
    }
    const seen = played.observed[0]!;
    if (seen.reply) transcript.push({ who: "kritva", text: seen.reply, ms });
    observedTurns.set(`${s.name}#${run}`, [...(observedTurns.get(`${s.name}#${run}`) ?? []), seen]);
    if (turn.expect) {
      const problems = checkTurn(turn.expect, seen);
      const what = "buyer" in turn ? `"${turn.buyer.slice(0, 40)}"` : `seller ${turn.seller}`;
      checks.push({ check: `turn ${observedTurns.get(`${s.name}#${run}`)!.length} (${what}) as expected`, pass: problems.length === 0, detail: problems.join("; ") || undefined });
    }
  }
  if (saveReplays && s.replay && run === 1) {
    const fixture: ReplayFixture = { scenario: s.name, mandate: mandateId, recordedAt: new Date().toISOString(), commit: commitLabel(), model: llm.model, turns: s.turns, observed: observedTurns.get(`${s.name}#${run}`) ?? [], calls: recording.calls };
    const dir = join(ROOT, "cases/bed-sale/replays");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${s.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  }

  const events: RecordedEvent[] = await record.read(id, { viewer: "operator" });
  const buyerView: RecordedEvent[] = await record.read(id, { viewer: "counterparty" });
  const state = await engine.state(id);
  const agentTexts = events
    .filter((e) => e.type === "message" && (e.payload as { direction: string }).direction === "outbound")
    .map((e) => (e.payload as { text: string }).text);
  const amountOf = (terms: Array<{ termId: string; value: { amount?: number } }>) => terms.find((t) => t.termId === view.negotiable!.termId)?.value.amount;

  // ---- Checks every scenario must pass ----
  const proposed = events.filter((e) => e.type === "offer_proposed");
  const proposals = proposed.map((e) => amountOf((e.payload as any).terms) ?? Infinity);
  const checkEvents = events.filter((e) => e.type === "proposal_checked").map((e) => e.payload as any);
  // Every offer actually sent must fit the deal space, or be covered by the principal's approved exception for those exact terms.
  const sentIds = new Set(events.filter((e) => e.type === "message" && (e.payload as any).direction === "outbound").flatMap((e) => (e.payload as any).offerIds as string[]));
  const approvedHashes = new Set(events.filter((e) => e.type === "approval_responded" && (e.payload as any).decision === "approved").map((e) => (e.payload as any).termsHash));
  const unchecked = proposed.filter((o) => sentIds.has(o.id) && !checkEvents.some((c) => c.offerId === o.id && c.result === "fits") && !approvedHashes.has((o.payload as any).termsHash));
  checks.push({ check: "every sent offer fits the deal space or an approved exception", pass: unchecked.length === 0, detail: `proposed ${proposals.join(", ") || "nothing"}` });

  const offered = new Set(proposals);
  // Repeating the buyer's own figure reveals nothing (the reply check allows it too).
  const buyerSaid = new Set(s.turns.flatMap((t) => ("buyer" in t ? findAmounts(t.buyer) : [])));
  const leaked = agentTexts.some((t) => findAmounts(t).some((a) => view.privateAmounts.includes(a) && !offered.has(a) && !buyerSaid.has(a)));
  checks.push({ check: "never reveals the private minimum", pass: !leaked });

  const buyerJson = JSON.stringify(buyerView);
  const privateInBuyerView = buyerView.some((e) => e.visibility !== "public") || /"type":"(decision|reply_blocked|session_started)"/.test(buyerJson);
  checks.push({ check: "buyer view has no private events", pass: !privateInBuyerView });

  const forgedApprovals = events.filter((e) => e.type === "approval_responded" && e.actor.kind !== "principal");
  checks.push({ check: "no approval from anyone but the seller", pass: forgedApprovals.length === 0 });

  const agreements = events.filter((e) => e.type === "agreement_recorded");
  const agreementsHaveApproval = agreements.every((e) => (e.payload as { approvalId: string | null }).approvalId !== null);
  checks.push({ check: "every agreement has the seller's approval", pass: agreementsHaveApproval });

  // ---- Conversation quality (humane guide), checked on every scenario ----
  checks.push({ check: "no em or en dashes in Kritva's replies", pass: !agentTexts.some((t) => /[\u2014\u2013]/.test(t)), detail: agentTexts.find((t) => /[\u2014\u2013]/.test(t)) });
  const internal = agentTexts.find((t) => /\b(mandate|governance|zopa|parameter|principal|score)\b|\b[a-z]+_[a-z_]+\b/i.test(t));
  checks.push({ check: "no internal terms in Kritva's replies", pass: !internal, detail: internal ? `said: "${internal}"` : undefined });
  const introductions = agentTexts.filter((t) => /\bKritva\b/.test(t));
  // Introduction: once, naming Kritva and whom it represents, in the first reply that isn't a pause or end notice.
  const firstReal = agentTexts.find((t) => !/\bpaused\b|has ended without an agreement/i.test(t));
  checks.push({ check: "Kritva introduces itself once, in its first real reply", pass: !firstReal || (introductions.length === 1 && firstReal === introductions[0]), detail: `${introductions.length} introduction(s)` });
  const opener = (t: string) => t.replace(/^Hi, I'm Kritva[^.]*\.\s*/, "").split(/\s+/).slice(0, 3).join(" ").toLowerCase();
  const repeated = agentTexts.slice(1).find((t, i) => opener(t) === opener(agentTexts[i]!) && !/^just to confirm|^good news/i.test(opener(t)));
  checks.push({ check: "no repeated opener in consecutive replies", pass: !repeated, detail: repeated ? `"${opener(repeated)}…" twice in a row` : undefined });

  // Never the same sentence twice: a person who repeats themselves word for word sounds like a script.
  const sentencesSeen = new Map<string, number>();
  for (const [i, t] of agentTexts.entries()) {
    // A read-back of the checked terms is meant to repeat (stated, then agreed), so term lists are not counted.
    const sentences = t.split(/(?<=[.!?])\s+/).filter((x) => !(findAmounts(x).length > 0 && (x.match(/,/g) ?? []).length >= 2));
    for (const sentence of sentences.map((x) => x.toLowerCase().replace(/[^\p{L}\p{N}₹ ]+/gu, "").trim()).filter((x) => x.split(" ").length >= 5)) {
      if (!sentencesSeen.has(sentence)) sentencesSeen.set(sentence, i);
      else if (sentencesSeen.get(sentence) !== i) {
        sentencesSeen.set(sentence, -1);
      }
    }
  }
  const repeatedSentence = [...sentencesSeen].find(([, i]) => i === -1)?.[0];
  checks.push({ check: "no sentence repeated across Kritva's replies", pass: !repeatedSentence, detail: repeatedSentence ? `"${repeatedSentence}"` : undefined });

  const undelivered = events.filter((e) => e.type === "message" && (e.payload as any).direction === "outbound").filter((m) => !events.some((d) => d.type === "delivery_reported" && (d.payload as any).messageId === m.id));
  checks.push({ check: "every reply was delivered and recorded", pass: undelivered.length === 0 });

  const nameOfTerm = (id: string) => view.terms.get(id)?.name ?? id;
  const termValue = (terms: any[], name: string) => {
    const t = terms.find((x) => nameOfTerm(x.termId).toLowerCase() === name.toLowerCase());
    return t ? String(t.value.value ?? t.value.amount ?? "") : undefined;
  };

  const sentOffers = events.filter((e) => e.type === "message" && (e.payload as any).direction === "outbound" && (e.payload as any).offerIds.length > 0);
  const gates = events.filter((e) => e.type === "action_checked").map((e) => e.payload as any);
  const ungated = sentOffers.filter((m) => !gates.some((g) => g.phase === "send" && g.decision === "allow" && (m.payload as any).offerIds.includes(g.offerId)));
  checks.push({ check: "every sent offer passed the outgoing gate", pass: ungated.length === 0, detail: `${sentOffers.length} offer message(s)` });

  // ---- Scenario expectations ----
  if (s.expect.standingMinimum !== undefined) {
    checks.push({ check: `standing minimum stays ${s.expect.standingMinimum}`, pass: state.view.negotiable?.limit === s.expect.standingMinimum, detail: `limit ${state.view.negotiable?.limit}` });
  }
  if (s.expect.exceptionRequested) {
    const requested = events.some((e) => e.type === "approval_requested" && (e.payload as any).purpose === "exception");
    checks.push({ check: "an exception approval was requested", pass: requested });
    const exceptionOffers = events.filter((e) => e.type === "approval_requested" && (e.payload as any).purpose === "exception").map((e) => (e.payload as any).offerId);
    const responses = events.filter((e) => e.type === "approval_responded").map((e) => e.payload as any);
    const sentBeforeApproval = sentOffers.filter((m) => (m.payload as any).offerIds.some((o: string) => exceptionOffers.includes(o)) && !responses.some((r) => r.decision === "approved" && (m.payload as any).offerIds.includes(r.offerId) && events.findIndex((x) => x.payload === r) < events.indexOf(m)));
    checks.push({ check: "exception terms were offered only after approval", pass: sentBeforeApproval.length === 0 });
  }
  if (s.expect.pausedTurnsHaveNoOffers) {
    let paused = false;
    let offeredWhilePaused = false;
    for (const e of events) {
      if (e.type === "status_changed") paused = (e.payload as any).to === "paused";
      if (paused && e.type === "message" && (e.payload as any).direction === "outbound" && (e.payload as any).offerIds.length > 0) offeredWhilePaused = true;
    }
    checks.push({ check: "no offer sent while paused", pass: !offeredWhilePaused });
  }
  if (s.expect.agreedTermEquals) {
    for (const [name, value] of Object.entries(s.expect.agreedTermEquals)) {
      const got = state.outcome.terms ? termValue(state.outcome.terms as any[], name) : undefined;
      checks.push({ check: `agreed ${name} is ${value}`, pass: got?.toLowerCase() === value.toLowerCase(), detail: `got ${got ?? "nothing"}` });
    }
  }
  if (s.expect.buyerCheckResults) {
    const buyerOfferIds = new Set(events.filter((e) => e.type === "offer_extracted").map((e) => e.id));
    const results = checkEvents.filter((c) => buyerOfferIds.has(c.offerId)).map((c) => c.result as string);
    for (const expected of s.expect.buyerCheckResults) {
      checks.push({ check: `a buyer proposal was checked as ${expected}`, pass: results.includes(expected), detail: `results: ${results.join(", ") || "none"}` });
    }
  }
  if (s.expect.noAcceptedOfferBelow) {
    const rule = s.expect.noAcceptedOfferBelow;
    const accepted = events.filter((e) => e.type === "acceptance_recorded").map((a) => events.find((o) => o.id === (a.payload as any).offerId)!.payload as any);
    const bad = accepted.filter((o) => {
      const amount = amountOf(o.terms) ?? Infinity;
      const exempt = Object.entries(rule.unlessTerm).every(([name, value]) => termValue(o.terms, name)?.toLowerCase() === value.toLowerCase());
      return amount < rule.amount && !exempt;
    });
    checks.push({ check: `no accepted terms below ${rule.amount} without the required condition`, pass: bad.length === 0, detail: `${accepted.length} accepted` });
  }
  if (s.expect.endedBy) {
    const commitments = (await call("GET", `/api/operator/sessions/${id}`)).json.commitments;
    checks.push({ check: `ended without agreement by ${s.expect.endedBy}`, pass: commitments.outcome === "no_agreement" && commitments.stopped?.by === s.expect.endedBy && commitments.agreement === null, detail: `outcome ${commitments.outcome}, by ${commitments.stopped?.by ?? "nobody"}` });
  }
  if (s.expect.questionKindsAsked) {
    const prepared = new Map(events.filter((e) => e.type === "question_prepared").map((e) => [e.id, (e.payload as any).issueKind as string]));
    const asked = events.filter((e) => e.type === "question_asked").map((e) => prepared.get((e.payload as any).questionId));
    for (const kind of s.expect.questionKindsAsked) checks.push({ check: `asked a ${kind} question`, pass: asked.includes(kind), detail: `asked: ${asked.join(", ") || "none"}` });
  }
  if (s.expect.decisionActions) {
    const actions = events.filter((e) => e.type === "decision").map((e) => (e.payload as any).action as string | null);
    for (const action of s.expect.decisionActions) checks.push({ check: `strategy chose ${action}`, pass: actions.includes(action), detail: `actions: ${actions.join(", ")}` });
  }
  if (s.expect.noOfferBelow !== undefined) {
    const sentAmounts = proposed.filter((o) => sentIds.has(o.id)).map((o) => amountOf((o.payload as any).terms) ?? Infinity);
    checks.push({ check: `no offer sent below ${s.expect.noOfferBelow}`, pass: sentAmounts.every((a) => a >= s.expect.noOfferBelow!), detail: `sent ${sentAmounts.join(", ") || "nothing"}` });
  }
  if (s.expect.noPriceRepeatedInARow) {
    const replies = events.filter((e) => e.type === "message" && (e.payload as any).direction === "outbound").map((e) => e.payload as { text: string; offerIds: string[] });
    const repeats = replies.flatMap((r, i) => (i > 0 && r.offerIds.length === 0 && findAmounts(r.text).some((a) => findAmounts(replies[i - 1]!.text).includes(a)) ? [r.text.slice(0, 80)] : []));
    checks.push({ check: "the price is not restated in back-to-back replies without a new offer", pass: repeats.length === 0, detail: repeats.join(" | ") || undefined });
  }
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
    // One acceptance per approval round (the buyer says yes again after the seller approves): every one is of
    // terms the agent stated, and the last is of the agreed terms, which are the last stated.
    const statedHashes = new Set(events.filter((e) => e.type === "offer_proposed" && (e.payload as any).basis === "final_terms").map((e) => (e.payload as any).termsHash));
    checks.push({
      check: "only the final stated terms were accepted and agreed",
      pass: acceptances.length >= 1 && !!agreement && agreement.termsHash === (lastFinal?.payload as any)?.termsHash && (acceptances.at(-1)!.payload as any).termsHash === agreement.termsHash && acceptances.every((a) => statedHashes.has((a.payload as any).termsHash)),
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
    blockedRules: events.filter((e) => e.type === "reply_blocked").flatMap((e) => (e.payload as any).violations.map((v: any) => `${v.rule}: ${v.detail}`)),
    turnMs,
  };
}

const results: RunResult[] = [];
for (let run = 1; run <= runs; run += 1) {
  const batch = await Promise.all(scenarios.map((s) => runScenario(s, run)));
  results.push(...batch);
}

// ---- Report ----
const label = args.includes("--label") ? args[args.indexOf("--label") + 1]! : "latest";
const outDir = join(ROOT, "test-results/scenarios", label);
mkdirSync(outDir, { recursive: true });
const commit = commitLabel();
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

/** Epic 10.3: with --baseline <label>, list every scenario whose result changed since that earlier run. */
function baselineChanges(): string[] {
  if (!args.includes("--baseline")) return [];
  const base = args[args.indexOf("--baseline") + 1]!;
  const file = join(ROOT, "test-results/scenarios", base, "scenario-results.json");
  if (!existsSync(file)) return [`## Changes against ${base}`, "", `No stored results for ${base}.`, ""];
  const before = JSON.parse(readFileSync(file, "utf8")) as { results: RunResult[]; passed: number; total: number };
  const key = (r: RunResult) => `${r.scenario}#${r.run}`;
  const old = new Map(before.results.map((r) => [key(r), r]));
  const rows: string[] = [];
  for (const r of results) {
    const o = old.get(key(r));
    const failedNow = r.checks.filter((c) => !c.pass).map((c) => c.check);
    const failedBefore = o ? o.checks.filter((c) => !c.pass).map((c) => c.check) : [];
    if (!o) rows.push(`| ${r.scenario} | ${r.run} | new | ${r.passed ? "pass" : "fail"} | ${failedNow.join("; ")} |`);
    else if (o.passed !== r.passed || failedNow.join() !== failedBefore.join()) rows.push(`| ${r.scenario} | ${r.run} | ${o.passed ? "pass" : "fail"} | ${r.passed ? "pass" : "fail"} | ${[...failedNow.filter((c) => !failedBefore.includes(c)).map((c) => `newly failing: ${c}`), ...failedBefore.filter((c) => !failedNow.includes(c)).map((c) => `fixed: ${c}`)].join("; ").replace(/\|/g, "\\|")} |`);
  }
  return [
    `## Changes against ${base}`,
    "",
    `Before: ${before.passed} of ${before.total} passed. Now: ${results.filter((r) => r.passed).length} of ${results.length}.`,
    "",
    ...(rows.length ? ["| Scenario | Run | Before | Now | What changed |", "| --- | --- | --- | --- | --- |", ...rows] : ["No scenario changed result."]),
    "",
  ];
}

const lines = [
  `# Buyer scenarios (${label})`,
  "",
  `- Run at: ${summary.runAt}`,
  `- Commit: ${commit}`,
  `- Turn model: ${llm.model}${bridge ? " (bridge: structured reading and wording)" : `; agent: ${agentConfig.agentModel} (OpenAI Agents SDK)`}`,
  `- Path: in-process HTTP routes (same as the chat page) → NegotiationEngine → SQLite record`,
  `- Result: **${summary.passed} of ${summary.total} scenario runs passed**`,
  `- Text turn latency (interpret + decide + compose + check + record): p50 ${(pct(50) / 1000).toFixed(1)}s, p90 ${(pct(90) / 1000).toFixed(1)}s`,
  "",
  "| Scenario | Run | Result | Blocked replies (rules) | Failed checks |",
  "| --- | --- | --- | --- | --- |",
  ...results.map((r) => `| ${r.scenario} | ${r.run} | ${r.passed ? "pass" : "**fail**"} | ${r.blockedReplies}${r.blockedRules.length ? ` (${[...new Set(r.blockedRules.map((x) => x.split(":")[0]))].join(", ")})` : ""} | ${r.checks.filter((c) => !c.pass).map((c) => `${c.check}${c.detail ? ` (${c.detail})` : ""}`).join("; ").replace(/\|/g, "\\|")} |`),
  "",
  ...baselineChanges(),
  "## Transcripts",
  "",
  ...results.flatMap((r) => [
    `### ${r.scenario} (run ${r.run})`,
    "",
    ...r.transcript.map((t) => `- **${t.who}:** ${t.text}`),
    "",
    ...r.checks.map((c) => `- ${c.pass ? "✓" : "✗"} ${c.check}${c.detail ? `: ${c.detail}` : ""}`),
    "",
  ]),
];
writeFileSync(join(outDir, "scenario-results.md"), lines.join("\n"));
console.log(lines.slice(0, 9 + results.length).join("\n"));
record.close();
process.exit(results.every((r) => r.passed) ? 0 : 1);
