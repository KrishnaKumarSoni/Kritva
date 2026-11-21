/**
 * Provider-neutral contract for structured model output. Provider response objects stay
 * inside adapters; the core only ever sees parsed JSON or an `LlmError`.
 */
export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StructuredRequest {
  /** Purpose label for logs and metrics, e.g. "mandate_mapping". Never content. */
  purpose: string;
  system: string;
  messages: LlmMessage[];
  schema: { name: string; jsonSchema: Record<string, unknown> };
  signal?: AbortSignal;
}

export interface StructuredResponse {
  /** Parsed JSON. Still untrusted: callers must validate it. */
  json: unknown;
  /** Raw text, kept only so a repair turn can show the model its own previous answer. */
  rawText: string;
  model: string;
  latencyMs: number;
  /** Token use, when the provider reports it. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface StructuredLlm {
  generate(request: StructuredRequest): Promise<StructuredResponse>;
}

export type LlmErrorCode =
  | "timeout"
  | "cancelled"
  | "refusal"
  | "incomplete"
  | "malformed_output"
  | "provider_error";

/** Messages are generic on purpose: they must never carry prompt or source content. */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}
