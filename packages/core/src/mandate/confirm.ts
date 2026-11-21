/**
 * Minimal confirmation for a reviewed draft. The full review flow belongs to the Kritva
 * interface; this is the core rule it will call: a mandate becomes usable only when the
 * principal confirms it and every open issue is acknowledged.
 */
import { ConfirmedMandate } from "../schema/records.ts";
import { formatPath, semanticErrors, type ValidatedDraft, type ValidationIssue } from "../schema/validate.ts";

declare const confirmedBrand: unique symbol;
/** A confirmed mandate that passed every check. Negotiation sessions start only from these. */
export type ValidConfirmedMandate = ConfirmedMandate & { readonly [confirmedBrand]: true };

export type ConfirmResult = { ok: true; mandate: ValidConfirmedMandate } | { ok: false; errors: ValidationIssue[] };

export function confirmMandate(
  draft: ValidatedDraft,
  confirmation: { confirmedBy: string; acknowledgedIssueIds: string[]; at?: Date },
): ConfirmResult {
  const principal = draft.parties.find((p) => p.isPrincipal);
  if (!principal || principal.id !== confirmation.confirmedBy) {
    return { ok: false, errors: [{ path: "approval.confirmedBy", reason: "only the principal can confirm a mandate" }] };
  }
  const candidate = {
    ...structuredClone(draft),
    approval: {
      status: "confirmed" as const,
      confirmedBy: confirmation.confirmedBy,
      confirmedAt: (confirmation.at ?? new Date()).toISOString(),
      acknowledgedIssueIds: [...confirmation.acknowledgedIssueIds],
    },
  };
  return validateConfirmedMandate(candidate);
}

export function validateConfirmedMandate(input: unknown): ConfirmResult {
  const parsed = ConfirmedMandate.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        path: formatPath(i.path),
        reason: i.code === "invalid_type" ? `expected ${i.expected}` : i.message,
      })),
    };
  }
  const mandate = parsed.data;
  const errors = semanticErrors(mandate);
  const principal = mandate.parties.find((p) => p.isPrincipal);
  if (principal && mandate.approval.confirmedBy !== principal.id) {
    errors.push({ path: "approval.confirmedBy", reason: "only the principal can confirm a mandate" });
  }
  const acknowledged = new Set(mandate.approval.acknowledgedIssueIds);
  mandate.issues.forEach((issue, i) => {
    if (!acknowledged.has(issue.id)) errors.push({ path: `issues[${i}]`, reason: "open issue was not acknowledged at confirmation" });
  });
  const issueIds = new Set(mandate.issues.map((i) => i.id));
  mandate.approval.acknowledgedIssueIds.forEach((id, i) => {
    if (!issueIds.has(id)) errors.push({ path: `approval.acknowledgedIssueIds[${i}]`, reason: "references an unknown issue" });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, mandate: mandate as ValidConfirmedMandate };
}
