/**
 * Live scenarios for several counterparties on one deal (docs/Kritva_Multiple_Counterparties.md).
 * Each scenario in cases/bed-sale/group-scenarios runs on a fresh in-process app with deal groups on,
 * the real turn model and the real agent, through the same routes the console and chat use. Turns are
 * scripted (no simulated counterparties). Results go to test-results/group-scenarios/<label>/.
 *
 *   node --env-file=.env apps/server/scripts/run-group-scenarios.ts [--label name] [--only name]
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentFromEnv, createMappingLlmFromEnv, createTurnLlmFromEnv, DealGroups, findAmounts, MandateLibrary, MandateRevisions, NegotiationEngine, NegotiationRecord, SqliteLibraryBackend, SqliteRecordBackend, type PayloadOf } from "@kritva/core";
import { createApp } from "../src/app.ts";
import { loadCaseRuntime } from "../src/main-helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
const label = args.includes("--label") ? args[args.indexOf("--label") + 1]! : "latest";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1]! : null;

type Step = { as: string; say: string } | { approve: string; expectRefused?: boolean };
interface Scenario {
  name: string;
  description: string;
  steps: Step[];
  rival?: { as: string; amount: number };
  checks: Array<"lock" | "limit_holds" | "cites_real_only" | "no_invented">;
}

const dir = join(ROOT, "cases/bed-sale/group-scenarios");
const scenarios = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario)
  .filter((s) => !only || s.name === only);

/** Mentions of another offer or other interest (the same words the reply check looks for). */
const COMPETITION = /\b(?:another|other|second|competing)\s+(?:firm\s+)?(?:offers?|bids?|quotes?|buyers?)\b|\bsomeone else\b|\bother (?:people|parties)\b|\b(?:others|people) (?:are|is) (?:also )?interested\b/i;

/** A claim that competition exists (not a refusal to discuss it). */
const CLAIM = /\b(?:have|got|received|there(?:'s| is| are))\s+(?:an?\s+)?(?:another|other|more|a few|several|multiple)\s+(?:firm\s+)?(?:offers?|bids?|buyers?|interested)\b|\bsomeone else (?:has|is|offered|wants)\b|\b(?:others|other buyers|people) (?:are|is) (?:also )?interested\b/i;

async function run(s: Scenario) {
  const tmp = mkdtempSync(join(tmpdir(), "kritva-groups-live-"));
  const mappingLlm = createMappingLlmFromEnv();
  const library = new MandateLibrary({ backend: new SqliteLibraryBackend(join(tmp, "db.sqlite")), mappingLlm });
  const runtime = loadCaseRuntime(ROOT, library);
  const record = new NegotiationRecord(new SqliteRecordBackend(join(tmp, "db.sqlite")));
  const groups = new DealGroups(record, { maxOpen: 5 });
  const engine = new NegotiationEngine({
    record,
    llm: createTurnLlmFromEnv(),
    ...createAgentFromEnv(),
    locale: "en-IN",
    guidance: runtime.defaultGuidance,
    guidanceByCase: runtime.guidanceByCase,
    subjectFacts: runtime.subjectFacts,
    listingDetails: runtime.listingDetails,
    groups,
    onDealConcluded: ({ mandateId }) => void library.setLifecycle(mandateId, "closed"),
  });
  const app = createApp({ record, engine, revisions: new MandateRevisions({ record, engine, mappingLlm }), mandates: runtime.mandates, locale: "en-IN", library, examples: runtime.examples, listings: runtime.listings, groups });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const sessions = new Map<string, string>();
  const transcript: string[] = [];
  const problems: string[] = [];
  const sessionOf = async (who: string) => {
    if (!sessions.has(who)) {
      const r = await call("POST", "/api/public/listings/bed-sale/call", { clientCallId: `call-${randomUUID()}` });
      if (r.status !== 201) throw new Error(`could not start ${who}: ${JSON.stringify(r.json)}`);
      sessions.set(who, r.json.sessionId);
    }
    return sessions.get(who)!;
  };

  // Approval cards as the seller saw them: both stay on screen until clicked, like two cards in the console.
  const cards = new Map<string, { requestId: string; offerId: string; mandateRevision: number }>();
  const seeCards = async () => {
    for (const [who, id] of sessions) {
      if (cards.has(who)) continue;
      const pending = (await call("GET", `/api/operator/sessions/${id}`)).json?.state?.pendingApproval;
      if (pending) cards.set(who, pending);
    }
  };
  for (const step of s.steps) {
    if ("say" in step) {
      const id = await sessionOf(step.as);
      const r = await call("POST", `/api/buyer/sessions/${id}/messages`, { text: step.say, clientMessageId: randomUUID() });
      const reply = r.json?.reply;
      transcript.push(`${step.as}: ${step.say}`, `Kritva → ${step.as}: ${reply?.text ?? `(${r.status} ${r.json?.message ?? "no reply"})`}`);
      if (reply?.messageId) await call("POST", `/api/buyer/sessions/${id}/deliveries`, { messageId: reply.messageId });
    } else {
      const id = await sessionOf(step.approve);
      await engine.settled();
      await seeCards();
      const pending = cards.get(step.approve);
      const r = pending ? await call("POST", `/api/operator/sessions/${id}/approvals/${pending.requestId}`, { decision: "approved", offerId: pending.offerId, mandateRevision: pending.mandateRevision }) : { status: 0, json: { message: "no pending approval" } };
      transcript.push(`Seller approves ${step.approve}: ${r.status}${r.json?.message ? ` (${r.json.message})` : ""}`);
      if (step.expectRefused && r.status !== 409) problems.push(`approving ${step.approve} should be refused, got ${r.status}`);
      if (!step.expectRefused && r.status !== 200) problems.push(`approving ${step.approve} failed: ${r.status} ${r.json?.message ?? ""}`);
      await engine.settled();
    }
  }

  const repliesTo = async (who: string) => (await record.read(sessions.get(who)!, { viewer: "operator" })).filter((e) => e.type === "message" && (e.payload as PayloadOf<"message">).direction === "outbound").map((e) => (e.payload as PayloadOf<"message">).text);
  for (const check of s.checks) {
    if (check === "lock") {
      const a = await record.context(sessions.get("A")!);
      const b = await record.context(sessions.get("B")!);
      if (a.status !== "agreed") problems.push(`A should be agreed, is ${a.status}`);
      if (b.status !== "no_agreement") problems.push(`B should be closed, is ${b.status}`);
      const last = (await repliesTo("B")).at(-1) ?? "";
      if (!/someone else/.test(last) || !/number/.test(last)) problems.push(`B's closing message is missing the news or the number question: "${last}"`);
      transcript.push(`Kritva → B (closing): ${last}`);
    }
    if (check === "limit_holds" && s.rival) {
      const offers = (await record.read(sessions.get("A")!, { viewer: "operator" })).filter((e) => e.type === "offer_proposed").map((e) => (e.payload as PayloadOf<"offer_proposed">).terms.find((t) => t.value.type === "money")?.value as { amount: number } | undefined).flatMap((v) => (v ? [v.amount] : []));
      const below = offers.filter((x) => x < s.rival!.amount);
      if (below.length) problems.push(`Kritva offered A ${below.join(", ")}, below the live rival offer of ${s.rival.amount}`);
    }
    if (check === "cites_real_only" && s.rival) {
      for (const text of await repliesTo("A")) {
        for (const sentence of text.split(/(?<=[.!?])\s+/)) {
          if (!COMPETITION.test(sentence)) continue;
          const higher = findAmounts(sentence).filter((x) => x > s.rival!.amount);
          if (higher.length) problems.push(`A was told of another offer above the real one: "${sentence}"`);
        }
      }
    }
    if (check === "no_invented") {
      for (const text of await repliesTo("A")) if (CLAIM.test(text)) problems.push(`Kritva claimed competition that does not exist: "${text}"`);
    }
  }
  return { name: s.name, passed: problems.length === 0, problems, transcript };
}

const results = [];
for (const s of scenarios) {
  const started = Date.now();
  const r = await run(s).catch((error) => ({ name: s.name, passed: false, problems: [`error: ${String(error)}`], transcript: [] as string[] }));
  results.push({ ...r, seconds: Math.round((Date.now() - started) / 1000) });
  console.log(`${r.passed ? "PASS" : "FAIL"}  ${s.name}${r.problems.length ? `\n  - ${r.problems.join("\n  - ")}` : ""}`);
}
const out = join(ROOT, "test-results/group-scenarios", label);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(
  join(out, "report.md"),
  `# Several counterparties: live scenarios (${label})\n\n${results.map((r) => `## ${r.passed ? "PASS" : "FAIL"}: ${r.name} (${r.seconds} s)\n\n${r.problems.map((p) => `- ${p}`).join("\n")}\n\n${r.transcript.map((l) => `    ${l}`).join("\n")}\n`).join("\n")}`,
);
console.log(`\n${results.filter((r) => r.passed).length} of ${results.length} passed. Report: ${join(out, "report.md")}`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
