/**
 * Repeatable live chat regressions. A live scenario run records every model response it received;
 * a replay feeds those exact responses back to the same engine and routes, so everything Kritva's
 * own code decides (strategy, governance checks, fallbacks, delivery and the record) is checked
 * turn by turn without a model call.
 *
 * A replay fails when code changes what Kritva delivers or decides for the same model output, or
 * when code asks the model for something the recording does not contain. Re-record with
 * `npm run scenarios -- --save-replays` after an intended change.
 */
import type { NegotiationRecord, RecordedEvent, StructuredLlm, StructuredRequest, StructuredResponse } from "@kritva/core";
import type { Model, ModelRequest, ModelResponse } from "@openai/agents";

export type ScenarioTurn = { buyer: string; expect?: TurnExpect } | { seller: "approved" | "rejected" | "pause" | "resume" | "end" };

/** What one turn must produce. Patterns are case-insensitive regular expressions. */
export interface TurnExpect {
  /** The last decision recorded this turn: its kind and strategy action. "a|b" accepts either. */
  decision?: string;
  action?: string;
  /** The amount of the offer the reply carries, or null when the reply carries no offer. */
  offer?: number | null;
  says?: string[];
  neverSays?: string[];
}

export interface TurnObservation {
  turn: string;
  reply: string | null;
  offerAmount: number | null;
  decision: { kind: string; action: string | null } | null;
  blocked: number;
}

export interface ModelCall {
  purpose: string;
  json: unknown;
}

export interface ReplayFixture {
  scenario: string;
  mandate: string;
  recordedAt: string;
  commit: string;
  model: string;
  turns: ScenarioTurn[];
  observed: TurnObservation[];
  calls: ModelCall[];
}

/** Passes calls to the live model and keeps each response, in order. */
export class RecordingLlm implements StructuredLlm {
  readonly calls: ModelCall[] = [];
  readonly #inner: StructuredLlm;
  constructor(inner: StructuredLlm) {
    this.#inner = inner;
  }
  get model(): string {
    return (this.#inner as { model?: string }).model ?? "unknown";
  }
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const response = await this.#inner.generate(request);
    this.calls.push({ purpose: request.purpose, json: response.json });
    return response;
  }
}

/**
 * Wraps the live agent model and records its decisions in the same form the bridge replays: a
 * read_message call as a reading, a send_reply call as wording. A draft sent before reading (refused
 * by the tool) is dropped, since a replay never offers it.
 */
export class RecordingAgentModel implements Model {
  readonly #inner: Model;
  readonly #calls: ModelCall[];
  constructor(inner: Model, calls: ModelCall[]) {
    this.#inner = inner;
    this.#calls = calls;
  }
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const last = (Array.isArray(request.input) ? request.input.at(-1) : undefined) as { type?: string; name?: string; output?: unknown } | undefined;
    if (last?.type === "function_call_result" && last.name === "send_reply" && /"status":"not_ready"/.test(typeof last.output === "string" ? last.output : JSON.stringify(last.output))) {
      const index = this.#calls.findLastIndex((c) => c.purpose === "compose_reply");
      if (index >= 0) this.#calls.splice(index, 1);
    }
    const response = await this.#inner.getResponse(request);
    let called = false;
    for (const item of response.output as Array<{ type: string; name?: string; arguments?: string }>) {
      if (item.type !== "function_call") continue;
      called = true;
      const args = JSON.parse(item.arguments ?? "{}");
      if (item.name === "read_message") this.#calls.push({ purpose: "interpret_counterparty", json: args });
      if (item.name === "send_reply") this.#calls.push({ purpose: "compose_reply", json: args });
    }
    // A reply without a tool call ends the run without wording; the replay reproduces that with empty wording.
    if (!called) this.#calls.push({ purpose: "compose_reply", json: { text: "" } });
    return response;
  }
  getStreamedResponse(request: ModelRequest) {
    return this.#inner.getStreamedResponse(request);
  }
}

/** Returns the recorded responses for each purpose in the order they were received. */
export class ReplayLlm implements StructuredLlm {
  readonly #queues = new Map<string, unknown[]>();
  constructor(calls: ModelCall[]) {
    for (const call of calls) {
      const queue = this.#queues.get(call.purpose) ?? [];
      queue.push(call.json);
      this.#queues.set(call.purpose, queue);
    }
  }
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const queue = this.#queues.get(request.purpose);
    if (!queue || queue.length === 0) throw new Error(`The recording has no further ${request.purpose} response. Re-record the replay if this change is intended.`);
    const json = queue.shift();
    return { json, rawText: JSON.stringify(json), model: "replay", latencyMs: 0 };
  }
  /** Responses the engine never asked for: a sign that code now skips a model step. */
  unused(): Record<string, number> {
    return Object.fromEntries([...this.#queues].filter(([, q]) => q.length > 0).map(([purpose, q]) => [purpose, q.length]));
  }
}

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;

/**
 * Plays scenario turns through the same routes the chat page and the seller console use, reports
 * delivery the way the chat page does, and observes what each turn delivered and decided.
 */
export async function playTurns(call: Call, record: NegotiationRecord, sessionId: string, turns: ScenarioTurn[], negotiableTermId: string | null): Promise<{ observed: TurnObservation[]; error: string | null }> {
  const observed: TurnObservation[] = [];
  let seen = (await record.read(sessionId, { viewer: "operator" })).length;
  const deliver = async (reply: { messageId: string } | null | undefined) => {
    if (reply) await call("POST", `/api/buyer/sessions/${sessionId}/deliveries`, { messageId: reply.messageId });
  };
  for (const turn of turns) {
    let reply: { text: string; messageId: string } | null = null;
    let label: string;
    if ("buyer" in turn) {
      label = turn.buyer;
      const res = await call("POST", `/api/buyer/sessions/${sessionId}/messages`, { text: turn.buyer });
      if (res.status !== 200) return { observed, error: `HTTP ${res.status}: ${res.json.message}` };
      reply = res.json.reply ?? null;
    } else if (turn.seller === "end") {
      label = "(seller ends)";
      reply = (await call("POST", `/api/operator/sessions/${sessionId}/end`, { reason: "The seller decided not to go ahead." })).json.reply ?? null;
    } else if (turn.seller === "pause" || turn.seller === "resume") {
      label = `(seller ${turn.seller}s)`;
      await call("POST", `/api/operator/sessions/${sessionId}/pause`, { paused: turn.seller === "pause" });
    } else {
      label = `(seller ${turn.seller})`;
      const state = (await call("GET", `/api/operator/sessions/${sessionId}`)).json.state;
      if (!state.pendingApproval) return { observed, error: `seller ${turn.seller}: no approval was pending (status ${state.status})` };
      const { requestId, offerId, mandateRevision } = state.pendingApproval;
      reply = (await call("POST", `/api/operator/sessions/${sessionId}/approvals/${requestId}`, { decision: turn.seller, offerId, mandateRevision })).json.reply ?? null;
    }
    await deliver(reply);
    const events: RecordedEvent[] = await record.read(sessionId, { viewer: "operator" });
    const fresh = events.slice(seen);
    seen = events.length;
    const decision = fresh.findLast((e) => e.type === "decision")?.payload as { kind: string; action: string | null } | undefined;
    // The buyer route returns only the text; the offer travels on the recorded message.
    const message = reply ? events.find((e) => e.id === reply!.messageId)?.payload as { offerIds?: string[] } | undefined : undefined;
    const offerId = message?.offerIds?.[0];
    const offer = offerId ? (events.find((e) => e.id === offerId)?.payload as { terms: Array<{ termId: string; value: { amount?: number } }> } | undefined) : undefined;
    observed.push({
      turn: label,
      reply: reply?.text ?? null,
      offerAmount: offer?.terms.find((t) => t.termId === negotiableTermId)?.value.amount ?? null,
      decision: decision ? { kind: decision.kind, action: decision.action ?? null } : null,
      blocked: fresh.filter((e) => e.type === "reply_blocked").length,
    });
  }
  return { observed, error: null };
}

/** Per-turn expectation failures, worded for a report. */
export function checkTurn(expect: TurnExpect | undefined, seen: TurnObservation): string[] {
  if (!expect) return [];
  const problems: string[] = [];
  const oneOf = (allowed: string, value: string | null | undefined) => value != null && allowed.split("|").includes(value);
  if (expect.decision && !oneOf(expect.decision, seen.decision?.kind)) problems.push(`decision ${seen.decision?.kind ?? "none"}, expected ${expect.decision}`);
  if (expect.action && !oneOf(expect.action, seen.decision?.action)) problems.push(`action ${seen.decision?.action ?? "none"}, expected ${expect.action}`);
  if (expect.offer !== undefined && seen.offerAmount !== expect.offer) problems.push(`offer ${seen.offerAmount ?? "none"}, expected ${expect.offer ?? "none"}`);
  for (const pattern of expect.says ?? []) if (!new RegExp(pattern, "i").test(seen.reply ?? "")) problems.push(`reply lacks /${pattern}/`);
  for (const pattern of expect.neverSays ?? []) if (new RegExp(pattern, "i").test(seen.reply ?? "")) problems.push(`reply says /${pattern}/`);
  return problems;
}
