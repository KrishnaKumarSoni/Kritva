/**
 * Checks a draft against a scenario's declarative expectations. Matching is semantic
 * (record kind, party, value, labels), so wording and generated IDs are free to vary.
 */
import type { MandateDraft, Value } from "../../src/schema/records.ts";
import type { ScenarioExpectations } from "./cases.ts";

export type RecordKind = "term" | "goal" | "fact" | "position" | "limit" | "target" | "preference" | "alternative" | "permission" | "condition" | "issue";

export interface Matcher {
  record: RecordKind | RecordKind[];
  party?: "principal" | "counterparty";
  status?: "stated" | "inferred" | "unknown";
  disclosure?: "public" | "private";
  /** Limit kind or issue kind. */
  kind?: string;
  action?: string;
  mode?: string;
  goalKind?: "objective" | "need" | "reason";
  strength?: "preferred" | "acceptable" | "avoid";
  hasCondition?: boolean;
  termNameIncludesAny?: string[];
  textIncludesAny?: string[];
  value?: {
    type?: Value["type"];
    amount?: number;
    currency?: string;
    unitIncludes?: string;
    textIncludes?: string;
    boolean?: boolean;
  };
}

export interface CheckResult {
  check: string;
  pass: boolean;
}

const COLLECTION: Record<RecordKind, keyof MandateDraft> = {
  term: "terms",
  goal: "goals",
  fact: "facts",
  position: "positions",
  limit: "limits",
  target: "targets",
  preference: "preferences",
  alternative: "alternatives",
  permission: "permissions",
  condition: "conditions",
  issue: "issues",
};

type Loose = Record<string, unknown> & { id: string };

function recordText(kind: RecordKind, r: Loose): string {
  const parts: unknown[] = [];
  if (kind === "term") parts.push(r.name, r.description);
  if (kind === "goal") parts.push(r.description);
  if (kind === "fact") parts.push(r.statement);
  if (kind === "alternative") parts.push(r.description);
  if (kind === "permission" || kind === "condition") parts.push(r.description);
  if (kind === "issue") parts.push(r.message);
  const value = r.value as Value | null | undefined;
  if (value && (value.type === "text" || value.type === "date_text")) parts.push(value.value);
  if (value && value.type === "quantity") parts.push(value.unit);
  return parts.filter((p): p is string => typeof p === "string").join(" ");
}

function matches(draft: MandateDraft, kind: RecordKind, r: Loose, m: Matcher): boolean {
  const principalId = draft.parties.find((p) => p.isPrincipal)?.id;
  if (m.party) {
    const partyId = r.partyId as string | undefined;
    if (partyId === undefined) return false;
    if (m.party === "principal" && partyId !== principalId) return false;
    if (m.party === "counterparty" && partyId === principalId) return false;
  }
  if (m.status && r.status !== m.status) return false;
  if (m.disclosure && r.disclosure !== m.disclosure) return false;
  if (m.kind && r.kind !== m.kind) return false;
  if (m.action && r.action !== m.action) return false;
  if (m.goalKind && (kind !== "goal" || r.kind !== m.goalKind)) return false;
  if (m.strength && r.strength !== m.strength) return false;
  if (m.mode && r.mode !== m.mode) return false;
  if (m.hasCondition !== undefined) {
    const ids = r.conditionIds as string[] | undefined;
    if (ids === undefined) return false;
    if ((ids.length > 0) !== m.hasCondition) return false;
  }
  if (m.termNameIncludesAny) {
    const termIds = [r.termId, ...((r.termIds as string[] | undefined) ?? [])].filter(Boolean);
    const names = draft.terms.filter((t) => termIds.includes(t.id)).map((t) => t.name.toLowerCase());
    if (!m.termNameIncludesAny.some((needle) => names.some((n) => n.includes(needle.toLowerCase())))) return false;
  }
  if (m.textIncludesAny) {
    const text = recordText(kind, r).toLowerCase();
    if (!m.textIncludesAny.some((needle) => text.includes(needle.toLowerCase()))) return false;
  }
  if (m.value) {
    const v = r.value as Value | null | undefined;
    if (!v) return false;
    const want = m.value;
    if (want.type && v.type !== want.type) return false;
    if (want.amount !== undefined && !("amount" in v && v.amount === want.amount)) return false;
    if (want.currency !== undefined && !(v.type === "money" && v.currency === want.currency)) return false;
    if (want.unitIncludes !== undefined && !(v.type === "quantity" && (v.unit ?? "").toLowerCase().includes(want.unitIncludes))) return false;
    if (want.textIncludes !== undefined && !((v.type === "text" || v.type === "date_text") && v.value.toLowerCase().includes(want.textIncludes))) return false;
    if (want.boolean !== undefined && !(v.type === "boolean" && v.value === want.boolean)) return false;
  }
  return true;
}

export function countMatches(draft: MandateDraft, m: Matcher): number {
  const kinds = Array.isArray(m.record) ? m.record : [m.record];
  let n = 0;
  for (const kind of kinds) {
    for (const r of draft[COLLECTION[kind]] as unknown as Loose[]) if (matches(draft, kind, r, m)) n += 1;
  }
  return n;
}

const describe = (m: Matcher) => JSON.stringify(m);

export function checkExpectations(draft: MandateDraft, expect: ScenarioExpectations): CheckResult[] {
  const results: CheckResult[] = [];
  results.push({ check: "draft is unapproved", pass: draft.approval.status === "unapproved" });
  if (expect.minTerms !== undefined) {
    results.push({ check: `at least ${expect.minTerms} terms (found ${draft.terms.length})`, pass: draft.terms.length >= expect.minTerms });
  }
  for (const m of expect.require ?? []) {
    results.push({ check: `require ${describe(m)}`, pass: countMatches(draft, m) > 0 });
  }
  if (expect.requireAny && expect.requireAny.length > 0) {
    const pass = expect.requireAny.some((group) => group.every((m) => countMatches(draft, m) > 0));
    results.push({ check: `requireAny ${JSON.stringify(expect.requireAny)}`, pass });
  }
  for (const m of expect.forbid ?? []) {
    results.push({ check: `forbid ${describe(m)}`, pass: countMatches(draft, m) === 0 });
  }
  for (const m of expect.notSingle ?? []) {
    const n = countMatches(draft, m);
    results.push({ check: `notSingle ${describe(m)} (found ${n})`, pass: n !== 1 });
  }
  if (expect.forbidText && expect.forbidText.length > 0) {
    const found = forbiddenWordsIn(draft, expect.forbidText);
    results.push({ check: `forbidText ${JSON.stringify(expect.forbidText)}${found.length ? ` (found ${found.join(", ")})` : ""}`, pass: found.length === 0 });
  }
  return results;
}

/** Whole-word search across record content. Issue messages are excluded: they may name a gap. */
export function forbiddenWordsIn(draft: MandateDraft, words: string[]): string[] {
  const kinds: RecordKind[] = ["term", "goal", "fact", "position", "limit", "target", "preference", "alternative", "permission", "condition"];
  const text = kinds
    .flatMap((kind) => (draft[COLLECTION[kind]] as unknown as Loose[]).map((r) => recordText(kind, r)))
    .join("\n");
  return words.filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(w)}($|[^\\p{L}\\p{N}])`, "iu").test(text));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Meaning that must survive a change of input format: limits, permissions and money
 * positions. Free-text wording is excluded on purpose.
 */
export function meaningSignature(draft: MandateDraft): string[] {
  const principalId = draft.parties.find((p) => p.isPrincipal)?.id;
  const who = (partyId: string) => (partyId === principalId ? "principal" : "other");
  const val = (v: Value | null) => {
    if (v === null) return "none";
    if (v.type === "money") return `money:${v.amount}:${v.currency ?? "?"}`;
    if (v.type === "quantity") return `quantity:${v.amount}`;
    if (v.type === "boolean") return `boolean:${v.value}`;
    return v.type;
  };
  const out = new Set<string>();
  for (const l of draft.limits) {
    out.add(`limit|${who(l.partyId)}|${l.kind}|${val(l.value)}|${l.disclosure}|conditional:${l.conditionIds.length > 0}`);
  }
  for (const p of draft.permissions) {
    out.add(`permission|${p.action}|${p.mode}|conditional:${p.conditionIds.length > 0}`);
  }
  for (const p of draft.positions) {
    if (p.value?.type === "money") out.add(`position|${who(p.partyId)}|${val(p.value)}|${p.disclosure}`);
  }
  return [...out].sort();
}
