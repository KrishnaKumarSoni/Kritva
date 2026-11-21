/**
 * Epic 10: run the same buyer scenarios against Kritva and a plain LLM seller.
 *
 * Fairness rules, applied identically to both systems:
 * - Same base model for both sellers and for the buyer simulator.
 * - Same seller-visible inputs: the confirmed mandate. Kritva reads it as structured data; the plain
 *   seller gets the mandate's own source texts (public listing, private seller instructions).
 * - Same buyer simulator, same hidden buyer profile, same opening message, same buyer-turn limit.
 * - Same seller approval policy: approve only terms within the mandate, and only if the scenario's
 *   seller approves at all. Nothing from one run reaches another: each run gets a fresh record.
 * - Failed runs are kept with their status and error.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  formatValue,
  MandateRevisions,
  NegotiationEngine,
  NegotiationRecord,
  projectCommitments,
  promptVersions,
  SqliteRecordBackend,
  type LlmMessage,
  type OfferTerm,
  type StrategyGuidance,
  type StructuredLlm,
  type ValidConfirmedMandate,
} from "@kritva/core";
import { createApp, type MandateEntry } from "../app.ts";
import { BUYER_SIM_VERSION, nextBuyerMessage, type BuyerReply } from "./buyer-sim.ts";
import { MeteredLlm } from "./metered-llm.ts";
import { PLAIN_SELLER_VERSION, plainSellerPrompt, plainSellerTurn, type PlainSellerTurn } from "./plain-seller.ts";
import type { BuyerTurn, Judge, RunRecord, SellerOutcome, SimulatorSpec, SystemName, TranscriptEntry } from "./types.ts";

export interface ComparisonScenario {
  name: string;
  mandate: string;
  simulator: SimulatorSpec;
}

export interface ComparisonOptions {
  label: string;
  scenarios: ComparisonScenario[];
  runsPerScenario: number;
  systems: SystemName[];
  mandates: MandateEntry[];
  judge: Judge;
  guidance: StrategyGuidance;
  /** A fresh client for each run's seller (metered separately). */
  sellerLlm: () => StructuredLlm;
  buyerLlm: StructuredLlm;
  model: string;
  dataDir: string;
  locale: string;
  /** Runs already stored under this label; their IDs are never run again. */
  existing: RunRecord[];
  concurrency: number;
  onRun?: (record: RunRecord) => void;
}

export function runId(label: string, system: SystemName, scenario: string, run: number): string {
  return `${label}:${system}:${scenario}:${run}`;
}

export function systemPromptVersions(system: SystemName): Record<string, string> {
  return system === "kritva" ? { ...promptVersions(), buyerSimulator: BUYER_SIM_VERSION } : { plainSeller: PLAIN_SELLER_VERSION, buyerSimulator: BUYER_SIM_VERSION };
}

export async function runComparison(options: ComparisonOptions): Promise<RunRecord[]> {
  mkdirSync(options.dataDir, { recursive: true });
  const done = new Set(options.existing.map((r) => r.runId));
  const queue: Array<{ system: SystemName; scenario: ComparisonScenario; run: number }> = [];
  for (const scenario of options.scenarios) {
    for (let run = 1; run <= options.runsPerScenario; run += 1) {
      for (const system of options.systems) {
        if (!done.has(runId(options.label, system, scenario.name, run))) queue.push({ system, scenario, run });
      }
    }
  }
  const results: RunRecord[] = [];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const record = await runOne(options, job.system, job.scenario, job.run);
      results.push(record);
      options.onRun?.(record);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  return results;
}

/** The seller's approval policy, identical for both systems. */
function sellerDecision(judge: Judge, spec: SimulatorSpec, price: number | null, terms: Array<{ name: string; value: string }>): "approved" | "rejected" {
  if (spec.sellerApproval !== "approved") return "rejected";
  const delivery = new RegExp(judge.delivery.termNamePattern, "i");
  const included = new RegExp(judge.delivery.includedValuePattern, "i");
  const deliveryIncluded = terms.some((t) => delivery.test(t.name) && included.test(t.value.trim()));
  return price !== null && price >= judge.minimum.amount && !(deliveryIncluded && !judge.delivery.allowed) ? "approved" : "rejected";
}

function listingText(mandate: ValidConfirmedMandate): string {
  return mandate.sources.filter((s) => s.disclosure === "public").map((s) => s.text).join("\n\n");
}

function instructionsText(mandate: ValidConfirmedMandate): string {
  return mandate.sources.filter((s) => s.disclosure === "private").map((s) => s.text).join("\n\n");
}

const emptyMetrics = () => ({ sellerCalls: 0, sellerFailedCalls: 0, sellerInputTokens: 0, sellerOutputTokens: 0, sellerModelMs: 0, buyerCalls: 0, sellerTurnMs: [] as number[], wallMs: 0 });

async function runOne(options: ComparisonOptions, system: SystemName, scenario: ComparisonScenario, run: number): Promise<RunRecord> {
  const entry = options.mandates.find((m) => m.id === scenario.mandate);
  const id = runId(options.label, system, scenario.name, run);
  const started = performance.now();
  const record: RunRecord = {
    runId: id,
    label: options.label,
    system,
    scenario: scenario.name,
    run,
    status: "completed",
    error: null,
    startedAt: new Date().toISOString(),
    model: options.model,
    promptVersions: systemPromptVersions(system),
    sessionId: null,
    transcript: [],
    buyerTurns: [],
    interventions: [],
    outcome: { kind: "in_progress", price: null, terms: [], approvalObtained: false, endedBy: null, recordedAcceptance: null },
    decisions: [],
    blocked: { replies: 0, moves: 0, refs: [] },
    metrics: emptyMetrics(),
  };
  if (!entry) {
    record.status = "failed";
    record.error = `Mandate ${scenario.mandate} not found.`;
    return record;
  }
  const seller = new MeteredLlm(options.sellerLlm(), options.model);
  const buyer = new MeteredLlm(options.buyerLlm, options.model);
  try {
    const driver = system === "kritva" ? await kritvaDriver(options, entry, seller, id, record, scenario.simulator) : plainDriver(options, entry, seller, id, record, scenario.simulator);
    await converse(record, driver, scenario.simulator, listingText(entry.mandate), buyer);
    record.outcome = await driver.outcome();
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
  } finally {
    record.metrics.sellerCalls = seller.calls;
    record.metrics.sellerFailedCalls = seller.failedCalls;
    record.metrics.sellerInputTokens = seller.inputTokens;
    record.metrics.sellerOutputTokens = seller.outputTokens;
    record.metrics.sellerModelMs = seller.modelMs;
    record.metrics.buyerCalls = buyer.calls;
    record.metrics.wallMs = Math.round(performance.now() - started);
  }
  return record;
}

interface Driver {
  /** Sends one buyer message and returns true when the negotiation reached a final outcome. */
  turn(text: string, buyerIndex: number): Promise<boolean>;
  outcome(): Promise<SellerOutcome>;
}

async function converse(record: RunRecord, driver: Driver, spec: SimulatorSpec, listing: string, buyerLlm: StructuredLlm): Promise<void> {
  let reply: BuyerReply = { message: spec.openingMessage, acceptsCurrentTerms: false, acceptedPrice: null, endsConversation: false };
  for (let t = 1; t <= spec.maxBuyerTurns; t += 1) {
    const index = record.transcript.length;
    record.buyerTurns.push({ index, acceptsCurrentTerms: reply.acceptsCurrentTerms, acceptedPrice: reply.acceptedPrice, endsConversation: reply.endsConversation } satisfies BuyerTurn);
    const finished = await driver.turn(reply.message, index);
    if (finished || reply.endsConversation || t === spec.maxBuyerTurns) {
      if (reply.endsConversation && !finished) record.outcome.endedBy = "buyer";
      return;
    }
    const conversation = record.transcript.filter((e) => e.from !== "seller_decision").map((e) => ({ from: e.from as "buyer" | "seller", text: e.text }));
    reply = await nextBuyerMessage(buyerLlm, { spec, listing, conversation, turnsLeft: spec.maxBuyerTurns - t });
  }
}

// ---------------------------------------------------------------- Kritva

async function kritvaDriver(options: ComparisonOptions, entry: MandateEntry, llm: StructuredLlm, id: string, record: RunRecord, spec: SimulatorSpec): Promise<Driver> {
  const safe = id.replace(/[^\w-]+/g, "_");
  const store = new NegotiationRecord(new SqliteRecordBackend(join(options.dataDir, `${safe}.sqlite`)));
  const engine = new NegotiationEngine({ record: store, llm, locale: options.locale, guidance: options.guidance });
  const refusing: StructuredLlm = { generate: () => Promise.reject(new Error("Mapping is not used in comparison runs.")) };
  const revisions = new MandateRevisions({ record: store, engine, mappingLlm: refusing });
  // Only this run's mandate is available, so nothing from another case or run can be selected.
  const app = createApp({ record: store, engine, revisions, mandates: [entry], locale: options.locale });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const created = await call("POST", "/api/operator/sessions", { mandateId: entry.id });
  if (created.status !== 201 && created.status !== 200) throw new Error(`Could not start a session (HTTP ${created.status}).`);
  const sessionId = created.json.session.id as string;
  record.sessionId = sessionId;
  let counter = 0;

  const deliver = (messageId: string) => call("POST", `/api/buyer/sessions/${sessionId}/deliveries`, { messageId });
  const pushSeller = (text: string, ref: string) => record.transcript.push({ index: record.transcript.length, from: "seller", text, ref });

  return {
    async turn(text: string) {
      counter += 1;
      const clientId = `${safe}-${counter}`.slice(0, 90);
      record.transcript.push({ index: record.transcript.length, from: "buyer", text, ref: `msg_${clientId}` });
      const startedTurn = performance.now();
      let res = await call("POST", `/api/buyer/sessions/${sessionId}/messages`, { text, clientMessageId: clientId });
      if (res.status === 503) res = await call("POST", `/api/buyer/sessions/${sessionId}/messages`, { text, clientMessageId: clientId });
      record.metrics.sellerTurnMs.push(Math.round(performance.now() - startedTurn));
      if (res.status !== 200) throw new Error(`Turn failed (HTTP ${res.status}): ${res.json.message ?? res.json.error}`);
      if (res.json.reply) {
        pushSeller(res.json.reply.text, res.json.reply.messageId);
        await deliver(res.json.reply.messageId);
      }
      // A pending approval goes to the seller, with the same policy as for the plain seller.
      const state = await engine.state(sessionId);
      if (state.pendingApproval) {
        const ctx = await store.context(sessionId);
        const terms = ctx.offerTerms(state.pendingApproval.offerId)?.terms ?? [];
        const named = terms.map((t) => ({ name: state.space.terms.find((x) => x.termId === t.termId)?.name ?? t.termId, value: formatValue(t.value, options.locale) }));
        const price = amountOf(terms, state.view.negotiable?.termId ?? null);
        const decision = sellerDecision(options.judge, spec, price, named);
        record.interventions.push({ index: record.transcript.length, decision, price, terms: named.map((t) => `${t.name}: ${t.value}`).join("; ") });
        record.transcript.push({ index: record.transcript.length, from: "seller_decision", text: `Seller ${decision} ${named.map((t) => `${t.name}: ${t.value}`).join("; ")}`, ref: `approval:${state.pendingApproval.requestId}` });
        const answered = await call("POST", `/api/operator/sessions/${sessionId}/approvals/${state.pendingApproval.requestId}`, { decision });
        if (answered.json.reply) {
          pushSeller(answered.json.reply.text, answered.json.reply.messageId);
          await deliver(answered.json.reply.messageId);
        }
      }
      const after = await engine.state(sessionId);
      return after.outcome.kind === "agreement" || after.outcome.kind === "no_agreement";
    },
    async outcome() {
      const ctx = await store.context(sessionId);
      const state = await engine.state(sessionId);
      const events = ctx.events;
      for (const e of events) {
        if (e.type === "decision") {
          const p = e.payload as { action: string | null; reason: string };
          record.decisions.push({ ref: e.id, action: p.action, reason: p.reason });
        }
        if (e.type === "reply_blocked") {
          record.blocked.replies += 1;
          record.blocked.refs.push(e.id);
        }
        if (e.type === "action_checked") {
          const p = e.payload as { phase: string; decision: string };
          if (p.phase === "terms" && p.decision !== "allow") {
            record.blocked.moves += 1;
            record.blocked.refs.push(e.id);
          }
        }
      }
      const commitments = projectCommitments(ctx, { negotiableTermId: state.view.negotiable?.termId ?? null, termName: (tid) => state.space.terms.find((t) => t.termId === tid)?.name ?? tid, format: (v) => formatValue(v, options.locale) });
      const terms = state.outcome.terms ?? [];
      const named = terms.map((t) => ({ name: state.space.terms.find((x) => x.termId === t.termId)?.name ?? t.termId, value: formatValue(t.value, options.locale) }));
      const approvalObtained = state.outcome.termsHash !== null && state.approvals.some((a) => a.decision === "approved" && a.termsHash === state.outcome.termsHash);
      const kind = state.outcome.kind === "in_progress" ? (record.outcome.endedBy === "buyer" ? "no_agreement" : "in_progress") : state.outcome.kind;
      const stoppedBy = commitments.stopped?.by ?? null;
      return {
        kind,
        price: state.outcome.kind === "agreement" ? amountOf(terms, state.view.negotiable?.termId ?? null) : null,
        terms: state.outcome.kind === "agreement" ? named : [],
        approvalObtained,
        endedBy: record.outcome.endedBy ?? (stoppedBy === "counterparty" ? "buyer" : stoppedBy),
        recordedAcceptance: state.outcome.kind === "agreement" ? state.acceptances.some((a) => a.termsHash === state.outcome.termsHash) : null,
      };
    },
  };
}

function amountOf(terms: OfferTerm[], termId: string | null): number | null {
  const t = terms.find((x) => x.termId === termId);
  return t && "amount" in t.value ? (t.value.amount as number) : null;
}

// ---------------------------------------------------------------- Plain LLM seller

function plainDriver(options: ComparisonOptions, entry: MandateEntry, llm: StructuredLlm, id: string, record: RunRecord, spec: SimulatorSpec): Driver {
  const system = plainSellerPrompt(listingText(entry.mandate), instructionsText(entry.mandate));
  const history: LlmMessage[] = [];
  let last: PlainSellerTurn | null = null;
  let finalOutcome: SellerOutcome["kind"] | null = null;
  const approvedPrices = new Set<number>();
  const push = (from: TranscriptEntry["from"], text: string) => record.transcript.push({ index: record.transcript.length, from, text, ref: `${id}#${record.transcript.length}` });
  const sellerTurn = async () => {
    const turn = await plainSellerTurn(llm, system, history);
    history.push({ role: "assistant", content: JSON.stringify(turn) });
    push("seller", turn.reply);
    last = turn;
    return turn;
  };

  return {
    async turn(text: string) {
      push("buyer", text);
      history.push({ role: "user", content: `Buyer: ${text}` });
      const startedTurn = performance.now();
      let turn = await sellerTurn();
      // An approval request goes to the seller with the same policy as for Kritva; the seller's
      // answer is private, and the plain seller then writes its next message to the buyer.
      for (let i = 0; i < 2 && turn.status === "requesting_seller_approval"; i += 1) {
        const decision = sellerDecision(options.judge, spec, turn.price, turn.terms);
        const terms = turn.terms.map((t) => `${t.name}: ${t.value}`).join("; ");
        if (decision === "approved" && turn.price !== null) approvedPrices.add(turn.price);
        record.interventions.push({ index: record.transcript.length, decision, price: turn.price, terms });
        push("seller_decision", `Seller ${decision} ${terms || `price ${turn.price ?? "unknown"}`}`);
        history.push({ role: "user", content: `Seller (private, not visible to the buyer): I ${decision === "approved" ? "approve" : "do not approve"} these terms${turn.price !== null ? ` at ${turn.price}` : ""}${terms ? ` (${terms})` : ""}.` });
        turn = await sellerTurn();
      }
      record.metrics.sellerTurnMs.push(Math.round(performance.now() - startedTurn));
      if (turn.status === "agreement_reached") finalOutcome = "agreement";
      if (turn.status === "ended_no_deal") finalOutcome = "no_agreement";
      return finalOutcome !== null;
    },
    async outcome() {
      const t = last as PlainSellerTurn | null;
      if (finalOutcome === "agreement" && t) {
        return { kind: "agreement", price: t.price, terms: t.terms, approvalObtained: t.price !== null && approvedPrices.has(t.price), endedBy: null, recordedAcceptance: null };
      }
      if (finalOutcome === "no_agreement") return { kind: "no_agreement", price: null, terms: [], approvalObtained: false, endedBy: "agent", recordedAcceptance: null };
      if (t?.status === "requesting_seller_approval") return { kind: "pending_approval", price: t.price, terms: t.terms, approvalObtained: false, endedBy: null, recordedAcceptance: null };
      return { kind: record.outcome.endedBy === "buyer" ? "no_agreement" : "in_progress", price: null, terms: [], approvalObtained: false, endedBy: record.outcome.endedBy, recordedAcceptance: null };
    },
  };
}
