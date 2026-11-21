/**
 * Deterministic validation for mandate drafts. Makes no model calls.
 *
 * A draft reaches other core components only as a `ValidatedDraft`, and the only way to
 * get one is through `validateDraft`. Errors name the failed field and the reason, and
 * never echo field values, so they are safe to log even when the draft holds private content.
 */
import type { z } from "zod";
import { quoteAppearsIn } from "./quotes.ts";
import {
  MandateDraft,
  RECORD_COLLECTIONS,
  type Party,
  type Source,
  type SourceRef,
  type Term,
  type Value,
} from "./records.ts";

export interface ValidationIssue {
  /** Path to the failed field, e.g. `limits[2].termId`. */
  path: string;
  reason: string;
}

declare const validatedBrand: unique symbol;
/** A draft that passed every structural and semantic check. */
export type ValidatedDraft = MandateDraft & { readonly [validatedBrand]: true };

export type ValidationResult =
  | { ok: true; draft: ValidatedDraft }
  | { ok: false; errors: ValidationIssue[] };

const MAX_ERRORS = 100;

export function validateDraft(input: unknown): ValidationResult {
  const parsed = MandateDraft.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToValidation(parsed.error.issues) };
  }
  const errors = semanticErrors(parsed.data);
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, draft: parsed.data as ValidatedDraft };
}

/** Throwing variant for callers that treat an invalid draft as a programming error. */
export function assertValidDraft(input: unknown): ValidatedDraft {
  const result = validateDraft(input);
  if (!result.ok) {
    const summary = result.errors.map((e) => `${e.path}: ${e.reason}`).join("; ");
    throw new DraftValidationError(summary, result.errors);
  }
  return result.draft;
}

export class DraftValidationError extends Error {
  readonly errors: ValidationIssue[];
  constructor(summary: string, errors: ValidationIssue[]) {
    super(`Invalid mandate draft: ${summary}`);
    this.name = "DraftValidationError";
    this.errors = errors;
  }
}

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out.length === 0 ? String(part) : `.${String(part)}`;
  }
  return out.length === 0 ? "(root)" : out;
}

function zodIssuesToValidation(issues: z.core.$ZodIssue[]): ValidationIssue[] {
  return issues.slice(0, MAX_ERRORS).map((issue) => ({
    path: formatPath(issue.path),
    reason: reasonForZodIssue(issue),
  }));
}

/** Zod messages describe expectations, not received values. Keep them, minus anything value-shaped. */
function reasonForZodIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `expected ${issue.expected}`;
    case "unrecognized_keys":
      return `unrecognized field(s): ${issue.keys.join(", ")}`;
    case "invalid_union":
      return "value does not match any allowed shape";
    default:
      return issue.message;
  }
}

type AnyRecord = { id: string; status: string; disclosure: string; sourceRefs: SourceRef[] };

/** Rules shared by drafts and confirmed mandates. */
export function semanticErrors(draft: Omit<MandateDraft, "approval">): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (path: string, reason: string) => {
    if (errors.length < MAX_ERRORS) errors.push({ path, reason });
  };

  // ---- IDs are unique across the whole draft ----
  const firstUse = new Map<string, string>();
  const claim = (id: string, path: string) => {
    const prior = firstUse.get(id);
    if (prior !== undefined) add(`${path}.id`, `duplicate ID (first used at ${prior})`);
    else firstUse.set(id, path);
  };
  draft.parties.forEach((p, i) => claim(p.id, `parties[${i}]`));
  draft.sources.forEach((s, i) => claim(s.id, `sources[${i}]`));
  for (const collection of RECORD_COLLECTIONS) {
    (draft[collection] as AnyRecord[]).forEach((r, i) => claim(r.id, `${collection}[${i}]`));
  }
  draft.issues.forEach((r, i) => claim(r.id, `issues[${i}]`));

  const parties = new Map<string, Party>(draft.parties.map((p) => [p.id, p]));
  const sources = new Map<string, Source>(draft.sources.map((s) => [s.id, s]));
  const terms = new Map<string, Term>(draft.terms.map((t) => [t.id, t]));
  const conditionIds = new Set(draft.conditions.map((c) => c.id));

  // ---- Parties and sources ----
  const principals = draft.parties.filter((p) => p.isPrincipal);
  if (principals.length !== 1) add("parties", "exactly one party must be the principal");
  const principalId = principals.length === 1 ? principals[0]!.id : undefined;

  draft.sources.forEach((s, i) => {
    if (!parties.has(s.authorPartyId)) add(`sources[${i}].authorPartyId`, "references an unknown party");
  });

  // ---- Shared checks ----
  const checkRefs = (refs: SourceRef[], path: string): Source[] => {
    const cited: Source[] = [];
    refs.forEach((ref, j) => {
      const source = sources.get(ref.sourceId);
      if (!source) {
        add(`${path}.sourceRefs[${j}].sourceId`, "references an unknown source");
        return;
      }
      cited.push(source);
      if (!quoteAppearsIn(source.text, ref.quote)) {
        add(`${path}.sourceRefs[${j}].quote`, "quote does not appear in the cited source");
      }
    });
    return cited;
  };

  const checkProvenance = (record: AnyRecord, path: string): Source[] => {
    const cited = checkRefs(record.sourceRefs, path);
    if (record.status !== "unknown" && record.sourceRefs.length === 0) {
      add(`${path}.sourceRefs`, `${record.status} content must cite at least one source`);
    }
    if (record.disclosure === "public" && !cited.some((s) => s.disclosure === "public")) {
      add(`${path}.disclosure`, "content may be public only if a public source states it");
    }
    return cited;
  };

  /** Content attributed to a party must come from that party's own sources. */
  const checkAuthorship = (partyId: string, cited: Source[], path: string) => {
    if (cited.some((s) => s.authorPartyId !== partyId)) {
      add(`${path}.sourceRefs`, "content attributed to a party may only cite sources that party authored");
    }
  };

  const checkParty = (partyId: string, path: string) => {
    if (!parties.has(partyId)) add(`${path}.partyId`, "references an unknown party");
  };

  const checkTerm = (termId: string | null, path: string, field = "termId"): Term | undefined => {
    if (termId === null) return undefined;
    const term = terms.get(termId);
    if (!term) add(`${path}.${field}`, "references an unknown term");
    return term;
  };

  const checkConditions = (ids: string[], path: string) => {
    ids.forEach((id, j) => {
      if (!conditionIds.has(id)) add(`${path}.conditionIds[${j}]`, "references an unknown condition");
    });
  };

  const checkValue = (
    value: Value | null,
    status: string,
    term: Term | undefined,
    path: string,
    requireWhenKnown: boolean,
  ) => {
    if (status === "unknown") {
      if (value !== null) add(`${path}.value`, "unknown content cannot carry a value");
      return;
    }
    if (value === null) {
      if (requireWhenKnown) add(`${path}.value`, `${status} content needs a value`);
      return;
    }
    if (term && value.type !== term.valueType) {
      add(`${path}.value.type`, `does not match the term's value type (${term.valueType})`);
    }
    if (term && value.type === "money" && term.currency !== null && value.currency !== null && value.currency !== term.currency) {
      add(`${path}.value.currency`, "does not match the term's currency");
    }
  };

  // ---- Terms ----
  draft.terms.forEach((t, i) => {
    const path = `terms[${i}]`;
    checkProvenance(t, path);
    if (t.valueType !== "money" && t.currency !== null) add(`${path}.currency`, "only money terms take a currency");
    if (t.valueType !== "quantity" && t.unit !== null) add(`${path}.unit`, "only quantity terms take a unit");
  });

  // ---- Goals ----
  draft.goals.forEach((g, i) => {
    g.termIds.forEach((id, j) => checkTerm(id, `goals[${i}]`, `termIds[${j}]`));
    const path = `goals[${i}]`;
    checkParty(g.partyId, path);
    checkAuthorship(g.partyId, checkProvenance(g, path), path);
  });

  // ---- Facts ----
  draft.facts.forEach((f, i) => {
    const path = `facts[${i}]`;
    checkParty(f.partyId, path);
    checkAuthorship(f.partyId, checkProvenance(f, path), path);
    checkValue(f.value, f.status, checkTerm(f.termId, path), path, false);
  });

  // ---- Conditions ----
  draft.conditions.forEach((c, i) => {
    const path = `conditions[${i}]`;
    checkProvenance(c, path);
    checkValue(c.value, c.status, checkTerm(c.termId, path), path, false);
    if ((c.operator === null) !== (c.value === null) && c.status !== "unknown") {
      add(`${path}.operator`, "operator and value must be given together");
    }
  });
  const conditionAuthors = new Map<string, Source[]>(
    draft.conditions.map((c) => [c.id, c.sourceRefs.flatMap((r) => sources.get(r.sourceId) ?? [])]),
  );
  const checkConditionAuthorship = (partyId: string, ids: string[], path: string) => {
    ids.forEach((id, j) => {
      const cited = conditionAuthors.get(id) ?? [];
      if (cited.some((s) => s.authorPartyId !== partyId)) {
        add(`${path}.conditionIds[${j}]`, "condition must come from the same party's sources");
      }
    });
  };

  // ---- Positions ----
  draft.positions.forEach((p, i) => {
    const path = `positions[${i}]`;
    checkParty(p.partyId, path);
    checkAuthorship(p.partyId, checkProvenance(p, path), path);
    checkValue(p.value, p.status, checkTerm(p.termId, path), path, true);
    checkConditions(p.conditionIds, path);
    checkConditionAuthorship(p.partyId, p.conditionIds, path);
  });

  // ---- Limits ----
  draft.limits.forEach((l, i) => {
    const path = `limits[${i}]`;
    checkParty(l.partyId, path);
    checkAuthorship(l.partyId, checkProvenance(l, path), path);
    checkValue(l.value, l.status, checkTerm(l.termId, path), path, true);
    checkConditions(l.conditionIds, path);
    checkConditionAuthorship(l.partyId, l.conditionIds, path);
  });

  // ---- Targets and preferences: attributed to the party that states them ----
  for (const collection of ["targets", "preferences"] as const) {
    draft[collection].forEach((r, i) => {
      const path = `${collection}[${i}]`;
      checkParty(r.partyId, path);
      checkAuthorship(r.partyId, checkProvenance(r, path), path);
      checkValue(r.value, r.status, checkTerm(r.termId, path), path, true);
      checkConditions(r.conditionIds, path);
      checkConditionAuthorship(r.partyId, r.conditionIds, path);
    });
  }

  // ---- Alternatives: the party's own statement of what happens without a deal ----
  draft.alternatives.forEach((a, i) => {
    const path = `alternatives[${i}]`;
    checkParty(a.partyId, path);
    checkAuthorship(a.partyId, checkProvenance(a, path), path);
    checkValue(a.value, a.status, undefined, path, false);
  });

  // ---- Permissions: explicit, principal-only authority ----
  draft.permissions.forEach((p, i) => {
    const path = `permissions[${i}]`;
    if (p.status !== "stated") {
      add(`${path}.status`, "permission must be explicitly stated; inference cannot grant authority");
    }
    checkParty(p.partyId, path);
    if (principalId !== undefined && p.partyId !== principalId) {
      add(`${path}.partyId`, "only the principal can hold permissions");
    }
    checkAuthorship(p.partyId, checkProvenance(p, path), path);
    p.termIds.forEach((id, j) => checkTerm(id, path, `termIds[${j}]`));
    checkConditions(p.conditionIds, path);
    checkConditionAuthorship(p.partyId, p.conditionIds, path);
  });

  // ---- Issues ----
  draft.issues.forEach((issue, i) => {
    const path = `issues[${i}]`;
    issue.relatedIds.forEach((id, j) => {
      if (!firstUse.has(id)) add(`${path}.relatedIds[${j}]`, "references an unknown record");
    });
    checkRefs(issue.sourceRefs, path);
  });

  // ---- Conflicting values must be surfaced, never silently resolved ----
  for (const group of findConflicts(draft)) {
    const covered = draft.issues.some(
      (issue) => issue.kind === "conflict" && group.ids.every((id) => issue.relatedIds.includes(id)),
    );
    if (!covered) add(group.path, "conflicting values need a conflict issue that references all of them");
  }

  return errors;
}

export interface ConflictGroup {
  collection: "positions" | "limits";
  ids: string[];
  path: string;
}

/**
 * Records that claim different values for the same party, term, kind and conditions.
 * Neither can be chosen without an explicit correction from the principal.
 */
export function findConflicts(draft: Pick<MandateDraft, "positions" | "limits">): ConflictGroup[] {
  const groups: ConflictGroup[] = [];
  const scan = (
    collection: "positions" | "limits",
    records: Array<{ id: string; status: string; partyId: string; termId: string; value: Value | null; conditionIds: string[]; kind?: string }>,
  ) => {
    const byKey = new Map<string, { ids: string[]; values: Set<string>; firstIndex: number }>();
    records.forEach((r, i) => {
      // Several allowed values on one term are an option set, not a conflict.
      if (r.status === "unknown" || r.value === null || r.kind === "allowed_value") return;
      const key = [r.partyId, r.termId, r.kind ?? "", [...r.conditionIds].sort().join(",")].join("|");
      const entry = byKey.get(key) ?? { ids: [], values: new Set<string>(), firstIndex: i };
      entry.ids.push(r.id);
      entry.values.add(valueKey(r.value));
      byKey.set(key, entry);
    });
    for (const entry of byKey.values()) {
      if (entry.values.size > 1) {
        groups.push({ collection, ids: entry.ids, path: `${collection}[${entry.firstIndex}]` });
      }
    }
  };
  scan("positions", draft.positions);
  scan("limits", draft.limits);
  return groups;
}

function valueKey(value: Value): string {
  switch (value.type) {
    case "money":
      return `money:${value.amount}:${value.currency ?? ""}`;
    case "quantity":
      return `quantity:${value.amount}:${(value.unit ?? "").toLowerCase()}`;
    case "boolean":
      return `boolean:${value.value}`;
    case "text":
    case "date_text":
      return `${value.type}:${value.value.trim().toLowerCase()}`;
  }
}
