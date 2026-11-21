import type { ModelSettings } from "@openai/agents";
import type { ReasoningEffort } from "openai/resources/shared";
import { OpenAIStructuredLlm } from "./openai.ts";

/** Mapping runs before negotiation, so it favors accuracy over speed. Override per environment. */
export const DEFAULT_MAPPING_MODEL = "gpt-5.5";

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Turn-time model for interpreting messages and wording replies. Latency matters here,
 * so it defaults to a small, fast model. Decisions and checks never depend on it.
 */
export const DEFAULT_TURN_MODEL = "gpt-5.4-mini";

export function createTurnLlmFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIStructuredLlm {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
  const effort = env.KRITVA_TURN_REASONING_EFFORT ?? "none";
  return new OpenAIStructuredLlm({
    apiKey,
    model: env.KRITVA_TURN_MODEL ?? DEFAULT_TURN_MODEL,
    timeoutMs: Number(env.KRITVA_TURN_TIMEOUT_MS ?? 20_000),
    reasoningEffort: EFFORTS.has(effort) ? (effort as ReasoningEffort) : undefined,
  });
}

export function createMappingLlmFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIStructuredLlm {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
  const effort = env.KRITVA_MAPPING_REASONING_EFFORT;
  return new OpenAIStructuredLlm({
    apiKey,
    model: env.KRITVA_MAPPING_MODEL ?? DEFAULT_MAPPING_MODEL,
    timeoutMs: Number(env.KRITVA_MAPPING_TIMEOUT_MS ?? 90_000),
    reasoningEffort: effort && EFFORTS.has(effort) ? (effort as ReasoningEffort) : undefined,
  });
}

/**
 * The negotiating agent (OpenAI Agents SDK): the turn model unless KRITVA_AGENT_MODEL is set, with the
 * turn's reasoning effort. Responses are not stored with the provider (store: false).
 */
export function createAgentFromEnv(env: NodeJS.ProcessEnv = process.env): { agentModel: string; agentModelSettings: ModelSettings } {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");
  const effort = env.KRITVA_AGENT_REASONING_EFFORT ?? env.KRITVA_TURN_REASONING_EFFORT ?? "none";
  return {
    agentModel: env.KRITVA_AGENT_MODEL ?? env.KRITVA_TURN_MODEL ?? DEFAULT_TURN_MODEL,
    agentModelSettings: { store: false, ...(EFFORTS.has(effort) ? { reasoning: { effort: effort as NonNullable<NonNullable<ModelSettings["reasoning"]>["effort"]> } } : {}) },
  };
}
