/** A scripted model client for deterministic mapper tests. */
import { LlmError, type StructuredLlm, type StructuredRequest, type StructuredResponse } from "../../src/llm/types.ts";
import type { Extraction } from "../../src/mapping/extraction.ts";

export type Scripted = { json: unknown } | { error: LlmError } | { hang: true };

export class FakeLlm implements StructuredLlm {
  readonly calls: StructuredRequest[] = [];
  readonly #script: Scripted[];

  constructor(script: Scripted[]) {
    this.#script = [...script];
  }

  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    this.calls.push(structuredClone({ ...request, signal: undefined }));
    const next = this.#script.shift();
    if (!next) throw new Error("FakeLlm script exhausted: the mapper made more calls than expected");
    if ("error" in next) throw next.error;
    if ("hang" in next) {
      return new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () => reject(new LlmError("cancelled", "The model request was cancelled.")));
      });
    }
    return { json: next.json, rawText: JSON.stringify(next.json), model: "fake-model", latencyMs: 1 };
  }
}

export function extraction(partial: Partial<Extraction> = {}): Extraction {
  return {
    terms: [],
    goals: [],
    facts: [],
    positions: [],
    limits: [],
    permissions: [],
    conditions: [],
    issues: [],
    ...partial,
  };
}

export const money = (amount: number, currency: string | null = "INR") => ({
  type: "money" as const,
  amount,
  currency,
  unit: null,
  text: null,
  boolean: null,
});
