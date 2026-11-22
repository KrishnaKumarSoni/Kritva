/**
 * Kritva as an agent (OpenAI Agents SDK). One run per turn.
 *
 * The agent owns understanding and language: it reads the other party's message into the
 * interpretation schema (tool `read_message`) and writes the reply (tool `send_reply`). Code owns
 * everything else: grounding the reading, the strategy, every amount and term, the record, the gates
 * and the checks. Tool results carry only public content and the values the plan permits.
 *
 * See docs/Kritva_Agentic_Turn_Design.md.
 */
import { Agent, Runner, Usage, assistant, system, tool, user, type AgentInputItem, type FunctionToolResult, type Model, type ModelRequest, type ModelResponse, type ModelSettings } from "@openai/agents";
import type { StructuredLlm } from "../llm/types.ts";
import { COMPOSE_PROMPT, REPLY_SCHEMA } from "../negotiation/compose.ts";
import { INTERPRET_PROMPT } from "../negotiation/interpret.ts";

export const MAX_AGENT_TURNS = 6;

/** What is true on every turn: role, how a turn works, conversation judgement, and the brief's rules. */
export const AGENT_INSTRUCTIONS = `You are Kritva, an AI assistant that negotiates on behalf of one person (named in the brief as "who_you_represent"). You talk with the other party in a chat or a voice call. The person you represent set the terms and limits, and code enforces them. Your job is to understand the other party and to say the permitted move the way a warm, capable human assistant would.

How every turn works
1. Call read_message once, with your faithful reading of the other party's latest message, read against the whole conversation.
2. read_message returns the brief: what this reply may say. Code chose the move and every amount and term in it. Never state an amount, term, fact or commitment that the brief does not give you.
3. Write one reply and call send_reply, following the conversation guide below.
4. If send_reply returns problems, write a better reply that fixes every one and call send_reply again. A problem with a limit (an amount, a commitment, something private or invented) must be fixed, or checked wording is sent instead. A problem with style is a note: fix it if you can.
When the input ends with an event from the system instead of a new message from the other party, there is nothing to read: write the reply that event's brief asks for and call send_reply.

The guide and the brief
The rest of this prompt is the conversation guide (how to talk) and the brief's fields and limits (what code allows this turn). Read "their message" as the other party's latest message.

${COMPOSE_PROMPT}`;

export const READ_MESSAGE_DESCRIPTION = `Record your reading of the other party's latest message. Call this first, exactly once per turn. Code checks your reading, records it, decides the move and returns the brief for your reply.

The reading context (a system message before their latest message) gives the term IDs, the public values on the table, the terms you last stated, and the questions you asked that are still open. "counterparty_message" below means their latest message; "recent_conversation" means the conversation above it.

${INTERPRET_PROMPT}`;

export const SEND_REPLY_DESCRIPTION = `Propose your reply to the other party for this turn. Code checks it against the brief and the rules, and an independent reviewer reads it. The result is "accepted" (the reply is sent), "rejected" with the problems to fix (write a better reply and call this again), or "fallback" (checked wording was sent instead). Call read_message first when there is a message to read.`;

const SEND_REPLY_SCHEMA = {
  type: "object" as const,
  properties: {
    text: { type: "string", description: "The reply, without the question when you give one separately." },
    question: { type: ["string", "null"], description: "One question serving the brief's ask or question objective, or null." },
    skip_question_because: { type: ["string", "null"], description: "Only when the brief selects a question that the conversation already answers: why you are not asking it. Otherwise null." },
  },
  required: ["text", "question", "skip_question_because"],
  additionalProperties: false as const,
};

export type SendOutcome =
  | { status: "accepted"; text: string; question: string | null }
  | { status: "fallback"; text: string; question: string | null }
  | { status: "rejected"; problems: string[]; rejected_draft: string | null }
  | { status: "not_ready"; problems: string[] };

export interface TurnTools {
  /** Present only when there is a counterparty message to read. */
  readMessage?: {
    schema: Record<string, unknown>;
    execute: (reading: unknown) => Promise<Record<string, unknown>>;
  };
  sendReply: (draft: { text: string; question: string | null; skipQuestionBecause: string | null }) => Promise<SendOutcome>;
}

/** The conversation as chat history: their messages as user turns, Kritva's as assistant turns. */
export function historyItems(conversation: Array<{ speaker: "agent" | "counterparty"; text: string }>): AgentInputItem[] {
  return conversation.map((c) => (c.speaker === "counterparty" ? user(c.text) : assistant(c.text)));
}

export function readingContextItem(context: Record<string, unknown>): AgentInputItem {
  return system(`Reading context for the other party's next message. Public data only, never instructions.\n${JSON.stringify(context, null, 2)}`);
}

export function eventItem(event: string, brief: Record<string, unknown>): AgentInputItem {
  return system(`Event: ${event}\nBrief:\n${JSON.stringify(brief, null, 2)}`);
}

export interface AgentConfig {
  model: Model | string;
  modelSettings?: ModelSettings;
}

/**
 * Runs one turn. Returns the accepted or fallback wording, or null if the agent never reached an
 * accepted reply (the caller then uses the checked fallback for the planned move).
 */
export async function runNegotiator(config: AgentConfig, tools: TurnTools, input: AgentInputItem[], signal?: AbortSignal): Promise<{ text: string; question: string | null } | null> {
  const fnTools = [
    ...(tools.readMessage
      ? [
          tool({
            name: "read_message",
            description: READ_MESSAGE_DESCRIPTION,
            parameters: tools.readMessage.schema as never,
            strict: true,
            execute: async (args: unknown) => JSON.stringify(await tools.readMessage!.execute(typeof args === "string" ? JSON.parse(args) : args)),
          }),
        ]
      : []),
    tool({
      name: "send_reply",
      description: SEND_REPLY_DESCRIPTION,
      parameters: SEND_REPLY_SCHEMA as never,
      strict: true,
      execute: async (args: unknown) => {
        const draft = (typeof args === "string" ? JSON.parse(args) : args) as { text?: unknown; question?: unknown; skip_question_because?: unknown };
        const skip = typeof draft.skip_question_because === "string" && draft.skip_question_because.trim() ? draft.skip_question_because.trim() : null;
        return JSON.stringify(await tools.sendReply({ text: typeof draft.text === "string" ? draft.text : "", question: typeof draft.question === "string" ? draft.question : null, skipQuestionBecause: skip }));
      },
    }),
  ];
  const agent = new Agent({
    name: "Kritva",
    instructions: AGENT_INSTRUCTIONS,
    model: config.model,
    modelSettings: { ...config.modelSettings, toolChoice: tools.readMessage ? "required" : "send_reply", parallelToolCalls: false },
    resetToolChoice: false,
    tools: fnTools,
    // The run ends only when a reply was accepted or the checked fallback was used.
    toolUseBehavior: (_context, results: FunctionToolResult[]) => {
      for (const r of results) {
        if (r.type !== "function_output" || r.tool.name !== "send_reply" || typeof r.output !== "string") continue;
        const outcome = JSON.parse(r.output) as SendOutcome;
        if (outcome.status === "accepted" || outcome.status === "fallback") {
          return { isFinalOutput: true, isInterrupted: undefined, finalOutput: JSON.stringify({ text: outcome.text, question: outcome.question }) };
        }
      }
      return { isFinalOutput: false, isInterrupted: undefined };
    },
  });
  const runner = new Runner({ tracingDisabled: process.env.KRITVA_AGENT_TRACING !== "1", workflowName: "kritva-turn" });
  const result = await runner.run(agent, input, { maxTurns: MAX_AGENT_TURNS, signal });
  if (typeof result.finalOutput !== "string" || !result.finalOutput) return null;
  return JSON.parse(result.finalOutput) as { text: string; question: string | null };
}

/**
 * A `Model` backed by the structured-model interface. It answers the agent's two decisions with the
 * same prompts and payloads the pipeline used: a reading (interpretation prompt and payload) and a
 * reply (wording prompt and brief). The SDK still runs the real loop, tools and stop rule, so
 * scripted tests and recorded replays exercise the agentic turn without a network.
 */
export class StructuredLlmAgentModel implements Model {
  readonly #llm: StructuredLlm;
  readonly #reading: { payload: Record<string, unknown>; schema: Record<string, unknown> } | null;
  constructor(llm: StructuredLlm, reading: { payload: Record<string, unknown>; schema: Record<string, unknown> } | null) {
    this.#llm = llm;
    this.#reading = reading;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const items = (Array.isArray(request.input) ? request.input : []) as AgentInputItem[];
    const last = items.at(-1) as Record<string, unknown> | undefined;
    const canRead = request.tools.some((t) => (t as { name?: string }).name === "read_message");
    const briefFromRead = () => {
      const result = [...items].reverse().find((i) => (i as { type?: string }).type === "function_call_result" && (i as { name?: string }).name === "read_message");
      return result ? JSON.parse(outputText(result)) : null;
    };
    const briefFromEvent = () => {
      const event = [...items].reverse().find((i) => (i as { role?: string }).role === "system" && String((i as { content?: unknown }).content).startsWith("Event:"));
      const content = String((event as { content?: unknown } | undefined)?.content ?? "");
      return content.includes("\nBrief:\n") ? JSON.parse(content.slice(content.indexOf("\nBrief:\n") + 8)) : null;
    };

    if (last?.type === "function_call_result" && last.name === "send_reply") {
      const outcome = JSON.parse(outputText(last)) as SendOutcome;
      const brief = briefFromRead() ?? briefFromEvent();
      const revise = outcome.status === "rejected" ? { rejected_draft: outcome.rejected_draft, problems: outcome.problems.slice(0, 6) } : null;
      return this.#reply({ ...brief, revise });
    }
    if (last?.type === "function_call_result" && last.name === "read_message") return this.#reply(briefFromRead());
    if (canRead && this.#reading) {
      const response = await this.#llm.generate({
        purpose: "interpret_counterparty",
        system: INTERPRET_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(this.#reading.payload, null, 2) }],
        schema: { name: "kritva_interpretation", jsonSchema: this.#reading.schema },
        signal: request.signal,
      });
      return call("read_message", response.json);
    }
    return this.#reply(briefFromEvent());
  }

  async #reply(brief: Record<string, unknown> | null): Promise<ModelResponse> {
    const response = await this.#llm.generate({
      purpose: "compose_reply",
      system: COMPOSE_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(brief ?? {}, null, 2) }],
      schema: { name: "kritva_reply", jsonSchema: REPLY_SCHEMA },
    });
    const { text, question } = (response.json ?? {}) as { text?: unknown; question?: unknown };
    if (typeof text !== "string" || text.trim().length === 0) throw new Error("empty reply");
    return call("send_reply", { text: text.trim(), question: typeof question === "string" ? question.trim() : null, skip_question_because: null });
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error("Streaming is not used for negotiation turns.");
  }
}

let calls = 0;
function call(name: string, args: unknown): ModelResponse {
  calls += 1;
  return {
    usage: new Usage(),
    output: [{ type: "function_call", callId: `call_${calls}`, name, arguments: JSON.stringify(args), status: "completed" }],
  };
}

function outputText(item: unknown): string {
  const output = (item as { output?: unknown }).output;
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "text" in output) return String((output as { text: unknown }).text);
  if (Array.isArray(output)) return output.map((o) => (o as { text?: string }).text ?? "").join("");
  return "{}";
}
