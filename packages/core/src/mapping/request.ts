/**
 * What a host application hands to the mapper. The application, not the model, decides
 * who authored each source, who the principal is, and what each source may disclose.
 */
import { z } from "zod";
import { Party, Source } from "../schema/records.ts";
import { formatPath, type ValidationIssue } from "../schema/validate.ts";

export const MappingRequest = z.strictObject({
  caseId: z.string().min(1).max(128),
  parties: z.array(Party).min(1).max(20),
  sources: z.array(Source).min(1).max(50),
});
export type MappingRequest = z.infer<typeof MappingRequest>;

export function validateMappingRequest(
  input: unknown,
): { ok: true; request: MappingRequest } | { ok: false; errors: ValidationIssue[] } {
  const parsed = MappingRequest.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        path: formatPath(i.path),
        reason: i.code === "invalid_type" ? `expected ${i.expected}` : i.message,
      })),
    };
  }
  const request = parsed.data;
  const errors: ValidationIssue[] = [];
  const ids = new Set<string>();
  const claim = (id: string, path: string) => {
    if (ids.has(id)) errors.push({ path: `${path}.id`, reason: "duplicate ID" });
    ids.add(id);
  };
  request.parties.forEach((p, i) => claim(p.id, `parties[${i}]`));
  request.sources.forEach((s, i) => claim(s.id, `sources[${i}]`));
  if (request.parties.filter((p) => p.isPrincipal).length !== 1) {
    errors.push({ path: "parties", reason: "exactly one party must be the principal" });
  }
  const partyIds = new Set(request.parties.map((p) => p.id));
  request.sources.forEach((s, i) => {
    if (!partyIds.has(s.authorPartyId)) {
      errors.push({ path: `sources[${i}].authorPartyId`, reason: "references an unknown party" });
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, request };
}
