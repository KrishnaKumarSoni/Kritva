/**
 * OpenAI adapter for structured output via the Responses API with strict JSON schema.
 *
 * Retries are disabled so one `generate` call is exactly one model call; callers own
 * their call budget. Responses are not stored on OpenAI's side (`store: false`).
 */
import OpenAI, { APIConnectionTimeoutError, APIUserAbortError } from "openai";
import type { ReasoningEffort } from "openai/resources/shared";
import { LlmError, type StructuredLlm, type StructuredRequest, type StructuredResponse } from "./types.ts";

export interface OpenAIStructuredLlmOptions {
  model: string;
  apiKey?: string;
  /** Per-call timeout. */
  timeoutMs?: number;
  reasoningEffort?: ReasoningEffort;
  client?: OpenAI;
}

export class OpenAIStructuredLlm implements StructuredLlm {
  readonly model: string;
  readonly #client: OpenAI;
  readonly #timeoutMs: number;
  readonly #reasoningEffort: ReasoningEffort | undefined;

  constructor(options: OpenAIStructuredLlmOptions) {
    this.model = options.model;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#reasoningEffort = options.reasoningEffort;
    this.#client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 0 });
  }

  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const started = performance.now();
    let response: OpenAI.Responses.Response;
    try {
      response = await this.#client.responses.create(
        {
          model: this.model,
          instructions: request.system,
          input: request.messages.map((m) => ({ role: m.role, content: m.content })),
          text: {
            format: {
              type: "json_schema",
              name: request.schema.name,
              schema: request.schema.jsonSchema,
              strict: true,
            },
          },
          ...(this.#reasoningEffort ? { reasoning: { effort: this.#reasoningEffort } } : {}),
          store: false,
        },
        { signal: request.signal, timeout: this.#timeoutMs, maxRetries: 0 },
      );
    } catch (error) {
      throw toLlmError(error, request.signal);
    }

    const latencyMs = Math.round(performance.now() - started);

    for (const item of response.output) {
      if (item.type === "message") {
        for (const part of item.content) {
          if (part.type === "refusal") throw new LlmError("refusal", "The model declined the request.");
        }
      }
    }
    if (response.status !== "completed") {
      throw new LlmError("incomplete", `The model response was ${response.status ?? "not completed"}.`);
    }

    const rawText = response.output_text;
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new LlmError("malformed_output", "The model returned text that is not valid JSON.");
    }
    return { json, rawText, model: response.model, latencyMs };
  }
}

function toLlmError(error: unknown, signal: AbortSignal | undefined): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof APIUserAbortError || signal?.aborted) {
    return new LlmError("cancelled", "The model request was cancelled.");
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new LlmError("timeout", "The model request timed out.");
  }
  if (error instanceof OpenAI.APIError) {
    return new LlmError("provider_error", `The model provider returned an error (status ${error.status ?? "unknown"}).`);
  }
  return new LlmError("provider_error", "The model request failed.");
}
