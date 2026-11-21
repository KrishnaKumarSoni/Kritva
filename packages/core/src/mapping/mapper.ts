/**
 * Maps supplied case text into a validated, unapproved mandate draft.
 *
 * Call budget: one model call, plus at most one repair call when the first output fails
 * validation. Provider timeouts, refusals and cancellations end the request at once.
 * Nothing partial is ever returned: the caller gets a `ValidatedDraft` or an error.
 *
 * Mapping has no side effects. It cannot activate a mandate, send an offer or record an
 * agreement; the draft it returns is always `unapproved`.
 */
import { LlmError, type LlmErrorCode, type LlmMessage, type StructuredLlm } from "../llm/types.ts";
import { validateDraft, type ValidatedDraft, type ValidationIssue } from "../schema/validate.ts";
import { convertExtraction, toExtractionPaths } from "./convert.ts";
import { buildExtractionJsonSchema, type Extraction } from "./extraction.ts";
import { buildMappingUserMessage, buildRepairMessage, MAPPING_SYSTEM_PROMPT } from "./prompt.ts";
import { validateMappingRequest, type MappingRequest } from "./request.ts";

export const MAX_MAPPING_CALLS = 2;

export type MappingErrorCode =
  | "invalid_request"
  | "validation_failed"
  | "provider_timeout"
  | "provider_refusal"
  | "cancelled"
  | "provider_error";

/** Safe to log: carries field paths and reasons, never source text or model output. */
export interface MappingError {
  code: MappingErrorCode;
  message: string;
  validationErrors: ValidationIssue[];
}

export interface MappingStats {
  llmCalls: number;
  repaired: boolean;
  /** Why the first output was rejected, when a repair was attempted. Paths and reasons only. */
  repairReasons: ValidationIssue[];
  latencyMs: number;
  model: string | null;
}

export type MappingResult =
  | { ok: true; draft: ValidatedDraft; stats: MappingStats }
  | { ok: false; error: MappingError; stats: MappingStats };

export interface MapOptions {
  llm: StructuredLlm;
  signal?: AbortSignal;
}

export async function mapToDraft(input: unknown, options: MapOptions): Promise<MappingResult> {
  const started = performance.now();
  const stats: MappingStats = { llmCalls: 0, repaired: false, repairReasons: [], latencyMs: 0, model: null };
  const finish = (
    result: { ok: true; draft: ValidatedDraft } | { ok: false; error: MappingError },
  ): MappingResult => {
    stats.latencyMs = Math.round(performance.now() - started);
    return { ...result, stats } as MappingResult;
  };

  const checked = validateMappingRequest(input);
  if (!checked.ok) {
    return finish({
      ok: false,
      error: { code: "invalid_request", message: "The mapping request is invalid.", validationErrors: checked.errors },
    });
  }
  const request: MappingRequest = checked.request;

  const schema = {
    name: "kritva_mandate_extraction",
    jsonSchema: buildExtractionJsonSchema(
      request.parties.map((p) => p.id),
      request.sources.map((s) => s.id),
    ),
  };
  const messages: LlmMessage[] = [{ role: "user", content: buildMappingUserMessage(request) }];

  let lastErrors: ValidationIssue[] = [];
  for (let attempt = 1; attempt <= MAX_MAPPING_CALLS; attempt += 1) {
    if (options.signal?.aborted) {
      return finish({ ok: false, error: providerError("cancelled") });
    }

    let rawText: string;
    let json: unknown;
    try {
      stats.llmCalls += 1;
      const response = await options.llm.generate({
        purpose: attempt === 1 ? "mandate_mapping" : "mandate_mapping_repair",
        system: MAPPING_SYSTEM_PROMPT,
        messages,
        schema,
        signal: options.signal,
      });
      stats.model = response.model;
      rawText = response.rawText;
      json = response.json;
    } catch (error) {
      if (error instanceof LlmError && error.code === "malformed_output" && attempt < MAX_MAPPING_CALLS) {
        lastErrors = [{ path: "(root)", reason: "output was not valid JSON" }];
        messages.push({ role: "user", content: buildRepairMessage(lastErrors) });
        stats.repaired = true;
        stats.repairReasons = lastErrors;
        continue;
      }
      return finish({ ok: false, error: fromLlmError(error, lastErrors) });
    }

    const outcome = toValidatedDraft(request, json);
    if (outcome.ok) return finish({ ok: true, draft: outcome.draft });

    lastErrors = outcome.errors;
    if (attempt < MAX_MAPPING_CALLS) {
      messages.push({ role: "assistant", content: rawText });
      messages.push({ role: "user", content: buildRepairMessage(outcome.repairErrors) });
      stats.repaired = true;
      stats.repairReasons = outcome.repairErrors;
    }
  }

  return finish({
    ok: false,
    error: {
      code: "validation_failed",
      message: "The mapped draft failed validation after one repair attempt. No draft was produced.",
      validationErrors: lastErrors,
    },
  });
}

function toValidatedDraft(
  request: MappingRequest,
  json: unknown,
): { ok: true; draft: ValidatedDraft } | { ok: false; errors: ValidationIssue[]; repairErrors: ValidationIssue[] } {
  if (!isExtractionShaped(json)) {
    const errors = [{ path: "(root)", reason: "output does not match the extraction format" }];
    return { ok: false, errors, repairErrors: errors };
  }
  let conversion;
  try {
    conversion = convertExtraction(request, json);
  } catch {
    const errors = [{ path: "(root)", reason: "output could not be converted into a draft" }];
    return { ok: false, errors, repairErrors: errors };
  }
  const result = validateDraft(conversion.candidate);
  if (result.ok) return { ok: true, draft: result.draft };
  return { ok: false, errors: result.errors, repairErrors: toExtractionPaths(result.errors, conversion.origin) };
}

/** Strict structured output should guarantee this; we still check rather than trust. */
function isExtractionShaped(json: unknown): json is Extraction {
  if (typeof json !== "object" || json === null) return false;
  const record = json as Record<string, unknown>;
  return ["terms", "goals", "facts", "positions", "limits", "permissions", "conditions", "issues"].every((key) =>
    Array.isArray(record[key]),
  );
}

const LLM_TO_MAPPING: Record<LlmErrorCode, MappingErrorCode> = {
  timeout: "provider_timeout",
  cancelled: "cancelled",
  refusal: "provider_refusal",
  incomplete: "provider_error",
  malformed_output: "validation_failed",
  provider_error: "provider_error",
};

const MESSAGES: Record<MappingErrorCode, string> = {
  invalid_request: "The mapping request is invalid.",
  validation_failed: "The mapped draft failed validation. No draft was produced.",
  provider_timeout: "The model provider timed out. No draft was produced.",
  provider_refusal: "The model declined to map this content. No draft was produced.",
  cancelled: "Mapping was cancelled. No draft was produced.",
  provider_error: "The model provider failed. No draft was produced.",
};

function providerError(code: MappingErrorCode, validationErrors: ValidationIssue[] = []): MappingError {
  return { code, message: MESSAGES[code], validationErrors };
}

function fromLlmError(error: unknown, lastErrors: ValidationIssue[]): MappingError {
  const code = error instanceof LlmError ? LLM_TO_MAPPING[error.code] : "provider_error";
  return providerError(code, code === "validation_failed" ? lastErrors : []);
}
