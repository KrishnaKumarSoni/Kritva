/** Counts model calls, tokens and model time for one run, without changing what the model returns. */
import type { StructuredLlm, StructuredRequest, StructuredResponse } from "@kritva/core";

export class MeteredLlm implements StructuredLlm {
  calls = 0;
  failedCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  modelMs = 0;
  readonly model: string;
  readonly #inner: StructuredLlm;

  constructor(inner: StructuredLlm, model: string) {
    this.#inner = inner;
    this.model = model;
  }

  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    this.calls += 1;
    try {
      const response = await this.#inner.generate(request);
      this.modelMs += response.latencyMs;
      this.inputTokens += response.usage?.inputTokens ?? 0;
      this.outputTokens += response.usage?.outputTokens ?? 0;
      return response;
    } catch (error) {
      this.failedCalls += 1;
      throw error;
    }
  }
}
