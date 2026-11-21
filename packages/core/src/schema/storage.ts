/**
 * Saving and loading drafts. Plain JSON keeps numbers, units, conditions and disclosure
 * labels exactly as they are. Loading re-validates, so a stored file cannot smuggle an
 * invalid draft into the core.
 */
import { validateDraft, type ValidatedDraft, type ValidationResult } from "./validate.ts";

export function saveDraft(draft: ValidatedDraft): string {
  return `${JSON.stringify(draft, null, 2)}\n`;
}

export function loadDraft(json: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, errors: [{ path: "(root)", reason: "not valid JSON" }] };
  }
  return validateDraft(parsed);
}
