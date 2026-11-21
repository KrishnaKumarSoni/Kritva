import type { ReasoningEffort } from "openai/resources/shared";
import { OpenAIStructuredLlm } from "./openai.ts";

/** Mapping runs before negotiation, so it favors accuracy over speed. Override per environment. */
export const DEFAULT_MAPPING_MODEL = "gpt-5.5";

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

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
