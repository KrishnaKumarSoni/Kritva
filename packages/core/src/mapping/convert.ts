/**
 * Deterministic conversion from model extraction to a candidate draft.
 *
 * The converter never repairs meaning. It copies identity, authorship and disclosure
 * from the request, derives each record's disclosure from the sources it cites, turns
 * inferred permissions into questions for the principal, and surfaces unflagged value
 * conflicts. Everything else is left for the validator to judge.
 */
import { SCHEMA_VERSION, type Issue, type MandateDraft, type SourceRef } from "../schema/records.ts";
import { findConflicts, type ValidationIssue } from "../schema/validate.ts";
import type { ExtractedQuote, ExtractedValue, Extraction } from "./extraction.ts";
import type { MappingRequest } from "./request.ts";

const PREFIX = {
  terms: "term",
  goals: "goal",
  facts: "fact",
  positions: "position",
  limits: "limit",
  targets: "target",
  preferences: "preference",
  alternatives: "alternative",
  permissions: "permission",
  conditions: "condition",
  issues: "issue",
} as const;
type Collection = keyof typeof PREFIX;

export interface Conversion {
  /** Not yet validated. Shaped like a draft, but values may still be wrong. */
  candidate: MandateDraft;
  /** For each draft collection, the index in the model output that produced each entry (-1 = generated). */
  origin: Record<Collection, number[]>;
}

export function idFor(collection: Collection, ref: string, fallbackIndex: number): string {
  const cleaned = ref.trim().replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
  return `${PREFIX[collection]}_${cleaned.length > 0 ? cleaned : String(fallbackIndex)}`;
}

export function convertExtraction(request: MappingRequest, extraction: Extraction): Conversion {
  const sourceDisclosure = new Map(request.sources.map((s) => [s.id, s.disclosure]));
  const principal = request.parties.find((p) => p.isPrincipal);

  const refs = (quotes: ExtractedQuote[]): SourceRef[] =>
    quotes.map((q) => ({ sourceId: q.source_id, quote: q.quote }));
  /** Public only when a public source states it. Anything else stays private. */
  const disclosureOf = (quotes: ExtractedQuote[]) =>
    quotes.some((q) => sourceDisclosure.get(q.source_id) === "public") ? ("public" as const) : ("private" as const);
  const ref = (collection: Collection) => (r: string) => idFor(collection, r, 0);
  const termId = ref("terms");
  const conditionId = ref("conditions");

  const origin: Record<Collection, number[]> = {
    terms: [], goals: [], facts: [], positions: [], limits: [], targets: [], preferences: [], alternatives: [], permissions: [], conditions: [], issues: [],
  };
  const track = <T>(collection: Collection, items: T[]): T[] => {
    origin[collection] = items.map((_, i) => i);
    return items;
  };

  const terms = track("terms", extraction.terms).map((t, i) => ({
    id: idFor("terms", t.ref, i),
    status: t.status,
    disclosure: disclosureOf(t.quotes),
    sourceRefs: refs(t.quotes),
    name: t.name,
    description: t.description,
    valueType: t.value_type,
    unit: t.unit,
    currency: normalizeCurrency(t.currency),
  }));

  const goals = track("goals", extraction.goals).map((g, i) => ({
    id: idFor("goals", g.ref, i),
    status: g.status,
    disclosure: disclosureOf(g.quotes),
    sourceRefs: refs(g.quotes),
    partyId: g.party_id,
    kind: g.kind ?? "objective",
    termIds: (g.term_refs ?? []).map(termId),
    description: g.description,
    priority: g.priority,
  }));

  const facts = track("facts", extraction.facts).map((f, i) => ({
    id: idFor("facts", f.ref, i),
    status: f.status,
    disclosure: disclosureOf(f.quotes),
    sourceRefs: refs(f.quotes),
    partyId: f.party_id,
    statement: f.statement,
    termId: f.term_ref === null ? null : termId(f.term_ref),
    value: toValue(f.value),
  }));

  const positions = track("positions", extraction.positions).map((p, i) => ({
    id: idFor("positions", p.ref, i),
    status: p.status,
    disclosure: disclosureOf(p.quotes),
    sourceRefs: refs(p.quotes),
    partyId: p.party_id,
    termId: termId(p.term_ref),
    value: toValue(p.value),
    conditionIds: p.condition_refs.map(conditionId),
  }));

  const limits = track("limits", extraction.limits).map((l, i) => ({
    id: idFor("limits", l.ref, i),
    status: l.status,
    disclosure: disclosureOf(l.quotes),
    sourceRefs: refs(l.quotes),
    partyId: l.party_id,
    termId: termId(l.term_ref),
    kind: l.kind,
    value: toValue(l.value),
    conditionIds: l.condition_refs.map(conditionId),
    exception: l.exception ?? "unspecified",
  }));

  const targets = track("targets", extraction.targets ?? []).map((t, i) => ({
    id: idFor("targets", t.ref, i),
    status: t.status,
    disclosure: disclosureOf(t.quotes),
    sourceRefs: refs(t.quotes),
    partyId: t.party_id,
    termId: termId(t.term_ref),
    value: toValue(t.value),
    conditionIds: t.condition_refs.map(conditionId),
  }));

  const preferences = track("preferences", extraction.preferences ?? []).map((p, i) => ({
    id: idFor("preferences", p.ref, i),
    status: p.status,
    disclosure: disclosureOf(p.quotes),
    sourceRefs: refs(p.quotes),
    partyId: p.party_id,
    termId: termId(p.term_ref),
    value: toValue(p.value),
    strength: p.strength,
    conditionIds: p.condition_refs.map(conditionId),
  }));

  const alternatives = track("alternatives", extraction.alternatives ?? []).map((a, i) => ({
    id: idFor("alternatives", a.ref, i),
    status: a.status,
    disclosure: disclosureOf(a.quotes),
    sourceRefs: refs(a.quotes),
    partyId: a.party_id,
    description: a.description,
    value: toValue(a.value),
  }));

  const conditions = track("conditions", extraction.conditions).map((c, i) => ({
    id: idFor("conditions", c.ref, i),
    status: c.status,
    disclosure: disclosureOf(c.quotes),
    sourceRefs: refs(c.quotes),
    description: c.description,
    termId: c.term_ref === null ? null : termId(c.term_ref),
    operator: c.operator,
    value: toValue(c.value),
  }));

  // Inference cannot create permission: an inferred permission becomes a question instead.
  const issues: Issue[] = [];
  const permissions: MandateDraft["permissions"] = [];
  const droppedPermissionIds = new Set<string>();
  extraction.permissions.forEach((p, i) => {
    const id = idFor("permissions", p.ref, i);
    if (p.status === "inferred") {
      droppedPermissionIds.add(id);
      issues.push({
        id: `issue_unconfirmed_${id}`,
        kind: "ambiguous",
        message: `Possible authority that was not explicitly granted: ${p.description}. Kritva will not act on it unless the principal states it.`,
        relatedIds: p.term_refs.map(termId),
        sourceRefs: refs(p.quotes),
      });
      return;
    }
    origin.permissions.push(i);
    permissions.push({
      id,
      status: p.status,
      disclosure: disclosureOf(p.quotes),
      sourceRefs: refs(p.quotes),
      partyId: principal?.id ?? "",
      action: p.action as MandateDraft["permissions"][number]["action"],
      mode: p.mode,
      termIds: p.term_refs.map(termId),
      description: p.description,
      conditionIds: p.condition_refs.map(conditionId),
    });
  });
  const generatedIssueCount = issues.length;

  extraction.issues.forEach((issue, i) => {
    origin.issues.push(i);
    issues.push({
      id: idFor("issues", String(i + 1), i),
      kind: issue.kind,
      message: issue.message,
      relatedIds: issue.related
        .map((r) => idFor(r.collection as Collection, r.ref, 0))
        .filter((id) => !droppedPermissionIds.has(id)),
      sourceRefs: refs(issue.quotes),
    });
  });
  // Generated issues come first in the list; their origin is -1.
  origin.issues = [...Array<number>(generatedIssueCount).fill(-1), ...origin.issues];

  const candidate: MandateDraft = {
    schemaVersion: SCHEMA_VERSION,
    caseId: request.caseId,
    approval: { status: "unapproved" },
    parties: request.parties,
    sources: request.sources,
    terms,
    goals,
    facts,
    positions,
    limits,
    targets,
    preferences,
    alternatives,
    permissions,
    conditions,
    issues,
  } as MandateDraft;

  surfaceConflicts(candidate, origin);
  return { candidate, origin };
}

/** Adds a conflict issue for any competing values the model did not already flag. */
function surfaceConflicts(draft: MandateDraft, origin: Record<Collection, number[]>): void {
  let n = 0;
  for (const group of findConflicts(draft)) {
    const flagged = draft.issues.some(
      (issue) => issue.kind === "conflict" && group.ids.every((id) => issue.relatedIds.includes(id)),
    );
    if (flagged) continue;
    const records = (draft[group.collection] as Array<{ id: string; sourceRefs: SourceRef[] }>).filter((r) =>
      group.ids.includes(r.id),
    );
    n += 1;
    draft.issues.push({
      id: `issue_conflict_${n}`,
      kind: "conflict",
      message: "The principal gave different values for the same thing without a correction. Choose one before relying on this draft.",
      relatedIds: group.ids,
      sourceRefs: records.flatMap((r) => r.sourceRefs).slice(0, 20),
    });
    origin.issues.push(-1);
  }
}

function normalizeCurrency(currency: string | null): string | null {
  if (currency === null) return null;
  const trimmed = currency.trim().toUpperCase();
  return trimmed.length === 0 ? null : trimmed;
}

/** Builds the typed value the schema expects. Missing parts stay missing so validation can name them. */
function toValue(value: ExtractedValue | null): MandateDraft["facts"][number]["value"] {
  if (value === null) return null;
  switch (value.type) {
    case "money":
      return { type: "money", amount: value.amount, currency: normalizeCurrency(value.currency) } as never;
    case "quantity":
      return { type: "quantity", amount: value.amount, unit: value.unit } as never;
    case "boolean":
      return { type: "boolean", value: value.boolean } as never;
    case "text":
    case "date_text":
      return { type: value.type, value: value.text } as never;
  }
}

const FIELD_NAMES: Record<string, string> = {
  id: "ref",
  partyId: "party_id",
  termId: "term_ref",
  termIds: "term_refs",
  conditionIds: "condition_refs",
  relatedIds: "related",
  sourceRefs: "quotes",
  sourceId: "source_id",
  valueType: "value_type",
};

/**
 * Rewrites validation paths from draft terms into the model's own output terms, so a
 * repair request points at fields the model actually wrote.
 */
export function toExtractionPaths(errors: ValidationIssue[], origin: Conversion["origin"]): ValidationIssue[] {
  return errors.map((error) => {
    const match = /^(terms|goals|facts|positions|limits|targets|preferences|alternatives|permissions|conditions|issues)\[(\d+)\](.*)$/.exec(error.path);
    if (!match) return error;
    const [, collection, index, rest] = match as unknown as [string, Collection, string, string];
    const from = origin[collection]?.[Number(index)];
    if (from === undefined || from < 0) {
      return { path: `${collection} (generated)`, reason: error.reason };
    }
    // A typed value's inner `value` field is `text` or `boolean` in the model's format.
    const innerValueField = ["facts", "positions", "limits", "targets", "preferences", "alternatives", "conditions"].includes(collection)
      ? ".value.value"
      : null;
    const adjusted = innerValueField !== null && rest === innerValueField ? ".value.text" : rest;
    const renamed = adjusted
      .split(".")
      .map((segment) => {
        const field = /^([A-Za-z]+)(.*)$/.exec(segment);
        if (!field) return segment;
        const [, name, tail] = field as unknown as [string, string, string];
        return `${FIELD_NAMES[name] ?? name}${tail}`;
      })
      .join(".");
    return { path: `${collection}[${from}]${renamed}`, reason: error.reason };
  });
}
