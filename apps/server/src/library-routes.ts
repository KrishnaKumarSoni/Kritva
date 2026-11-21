/**
 * Epic 11 routes: the principal's mandate library. Operator routes only — nothing here is reachable
 * from the counterparty's routes, and no request body can act as the principal's confirmation
 * except this explicit confirm route.
 */
import type { Hono } from "hono";
import {
  formatValue,
  type ConfirmedMandate,
  type Correction,
  type LibraryDetail,
  type MandateDraft,
  type MandateLibrary,
  type NegotiationEngine,
  type NegotiationRecord,
  type Value,
} from "@kritva/core";

export interface LibraryDeps {
  library: MandateLibrary;
  record: NegotiationRecord;
  engine: NegotiationEngine;
  locale: string;
  examples: Array<{ id: string; title: string; principalRole: string; counterpartyRole: string; publicText: string; privateText: string }>;
}

const MODE_LABEL: Record<string, string> = {
  autonomous: "Kritva may do this",
  requires_approval: "Ask me first",
  prohibited: "Not allowed",
};

const ACTION_LABEL: Record<string, string> = {
  propose_terms: "Negotiate and propose terms",
  make_concession: "Make concessions",
  accept_agreement: "Accept an agreement",
  disclose_information: "Share private information",
  request_information: "Ask for information",
  end_negotiation: "End the negotiation",
};

const KIND_LABEL: Record<string, string> = {
  minimum: "Minimum",
  maximum: "Maximum",
  must_equal: "Only",
  must_not_equal: "Never",
  allowed_value: "Allowed",
};

const ISSUE_LABEL: Record<string, string> = {
  missing: "Missing",
  conflict: "Conflict",
  unsupported: "Not supported",
  ambiguous: "Unclear",
};

export function registerLibraryRoutes(app: Hono, deps: LibraryDeps): void {
  const { library, locale } = deps;

  app.get("/api/operator/library", (c) => c.json(library.list()));
  app.get("/api/operator/library/examples", (c) => c.json(deps.examples));

  app.post("/api/operator/library", async (c) => {
    const body = await c.req.json<Record<string, string>>().catch(() => ({}) as Record<string, string>);
    const result = await library.create({ title: body.title ?? "", principalRole: body.principalRole ?? "", counterpartyRole: body.counterpartyRole ?? "", publicText: body.publicText ?? "", privateText: body.privateText ?? "" });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "invalid_input" ? 400 : 422);
    return c.json(libraryView(result.value, locale), 201);
  });

  app.get("/api/operator/library/:id", (c) => {
    const detail = library.get(c.req.param("id"));
    return detail ? c.json(libraryView(detail, locale)) : c.json({ error: "not_found" }, 404);
  });

  /** Edited text becomes the next draft version. The active revision does not change. */
  app.post("/api/operator/library/:id/drafts", async (c) => {
    const body = await c.req.json<Record<string, string>>().catch(() => ({}) as Record<string, string>);
    const result = await library.remap(c.req.param("id"), { title: body.title ?? "", principalRole: body.principalRole ?? "", counterpartyRole: body.counterpartyRole ?? "", publicText: body.publicText ?? "", privateText: body.privateText ?? "" });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "not_found" ? 404 : result.code === "invalid_input" ? 400 : 422);
    return c.json(libraryView(result.value, locale));
  });

  /** The principal's direct edits to extracted values become a new, validated draft version. */
  app.post("/api/operator/library/:id/corrections", async (c) => {
    const body = await c.req.json<{ versionId?: string; corrections?: Correction[] }>().catch(() => ({}) as { versionId?: string; corrections?: Correction[] });
    if (typeof body.versionId !== "string" || !Array.isArray(body.corrections)) return c.json({ error: "invalid_corrections", message: "Send the draft version and your corrections." }, 400);
    const result = library.correct(c.req.param("id"), { versionId: body.versionId, corrections: body.corrections });
    if (!result.ok) return c.json({ error: result.code, message: result.message, errors: result.errors ?? [] }, result.code === "stale_draft" ? 409 : 422);
    return c.json(libraryView(result.value, locale));
  });

  /**
   * Only this principal control confirms, for the exact version and content hash shown. Open
   * sessions started from this mandate move to the new revision through Epic 4's revision path,
   * which rechecks their pending offers and approvals. Past offers and agreements are not rewritten.
   */
  app.post("/api/operator/library/:id/confirm", async (c) => {
    const body = await c.req.json<{ versionId?: string; draftHash?: string; acknowledgedIssueIds?: string[] }>().catch(() => ({}) as Record<string, never>);
    const mandateId = c.req.param("id");
    const result = library.confirm(mandateId, { versionId: String(body.versionId ?? ""), draftHash: String(body.draftHash ?? ""), acknowledgedIssueIds: Array.isArray(body.acknowledgedIssueIds) ? body.acknowledgedIssueIds : [] });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "not_found" ? 404 : 409);
    const applied: string[] = [];
    for (const sessionId of await openSessionsUsing(deps.record, mandateId)) {
      const revised = await deps.engine.reviseMandate({ sessionId, mandate: result.value.mandate, reason: `The principal confirmed revision ${result.value.revision} of the saved mandate.`, mandateSource: { mandateId, revision: result.value.revision } });
      if (revised.ok) applied.push(sessionId);
    }
    return c.json({ ...libraryView(result.value.detail, locale), appliedToSessions: applied });
  });

  app.post("/api/operator/library/:id/discard", async (c) => {
    const body = await c.req.json<{ versionId?: string }>().catch(() => ({}) as { versionId?: string });
    const result = library.discard(c.req.param("id"), String(body.versionId ?? ""));
    if (!result.ok) return c.json({ error: result.code, message: result.message }, 409);
    return c.json(libraryView(result.value, locale));
  });
}

/** Sessions started from this saved mandate that have not finished. */
export async function openSessionsUsing(record: NegotiationRecord, mandateId: string): Promise<string[]> {
  const out: string[] = [];
  for (const s of await record.listSessions()) {
    const ctx = await record.context(s.id);
    const start = ctx.events[0]?.payload as { mandateSource?: { mandateId: string } | null } | undefined;
    if (start?.mandateSource?.mandateId !== mandateId) continue;
    if (ctx.status === "agreed" || ctx.status === "no_agreement" || ctx.status === "ended") continue;
    out.push(s.id);
  }
  return out;
}

/** The review the principal sees: plain labels, never schema field names. */
export function libraryView(detail: LibraryDetail, locale: string) {
  const latest = detail.latest;
  return {
    mandateId: detail.mandateId,
    title: detail.title,
    caseId: detail.caseId,
    input: detail.input,
    versions: detail.versions,
    active: detail.active ? { revision: detail.active.revision, versionId: detail.active.versionId, confirmedAt: detail.active.confirmedAt, review: reviewOf(detail.active.mandate, locale) } : null,
    latest: latest
      ? {
          versionId: latest.versionId,
          status: latest.status,
          draftHash: latest.draftHash,
          review: reviewOf(latest.draft, locale),
          blockers: latest.blockers,
          accept: MODE_LABEL[latest.readiness.accept] ?? latest.readiness.accept,
        }
      : null,
  };
}

export interface ReviewItem {
  recordId: string;
  label: string;
  text: string;
  private: boolean;
  /** "value": the value can be corrected directly; "mode": a permission mode; null: edit the text instead. */
  edit: "value" | "mode" | null;
  currentValue: string | null;
  currentMode: string | null;
  removable: boolean;
  inferred: boolean;
  source: string | null;
}

function reviewOf(m: MandateDraft | ConfirmedMandate, locale: string) {
  const principal = m.parties.find((p) => p.isPrincipal);
  const other = m.parties.find((p) => !p.isPrincipal);
  const termName = (id: string | null) => (id ? (m.terms.find((t) => t.id === id)?.name ?? id) : "");
  const val = (v: Value | null) => (v ? formatValue(v, locale) : "unknown");
  const sourceLabel = (refs: Array<{ sourceId: string }>) => {
    const s = m.sources.find((x) => x.id === refs[0]?.sourceId);
    return s ? `${s.label ?? s.id}${s.disclosure === "private" ? " (private)" : ""}` : null;
  };
  const conditionText = (ids: string[]) => {
    const texts = ids.map((id) => m.conditions.find((c) => c.id === id)?.description).filter(Boolean);
    return texts.length ? `, only if ${texts.join(" and ")}` : "";
  };
  const item = (r: { id: string; status: string; disclosure: "public" | "private"; sourceRefs: Array<{ sourceId: string }> }, label: string, text: string, edit: ReviewItem["edit"], extra: Partial<ReviewItem> = {}): ReviewItem => ({
    recordId: r.id,
    label,
    text,
    private: r.disclosure === "private",
    edit,
    currentValue: null,
    currentMode: null,
    removable: true,
    inferred: r.status === "inferred",
    source: sourceLabel(r.sourceRefs),
    ...extra,
  });
  const valueOf = (v: Value | null) => (v ? ("amount" in v ? String(v.amount) : "value" in v ? String(v.value === true ? "yes" : v.value === false ? "no" : v.value) : null) : null);
  const mine = <T extends { partyId: string }>(xs: T[]) => xs.filter((x) => x.partyId === principal?.id);

  return {
    parties: { you: principal?.role ?? "", other: other?.role ?? "" },
    sources: m.sources.map((s) => ({ id: s.id, label: s.label ?? s.id, private: s.disclosure === "private" })),
    sections: [
      {
        id: "terms",
        title: "Terms and your stated values",
        empty: "No terms found.",
        items: m.terms.map((t) => {
          const position = m.positions.find((p) => p.termId === t.id && p.partyId === principal?.id);
          return position
            ? item(position, t.name, `${val(position.value)}${conditionText(position.conditionIds)}`, position.termId && position.value ? "value" : null, { currentValue: valueOf(position.value), removable: false })
            : { recordId: t.id, label: t.name, text: "No value stated", private: t.disclosure === "private", edit: null, currentValue: null, currentMode: null, removable: false, inferred: t.status === "inferred", source: sourceLabel(t.sourceRefs) };
        }),
      },
      { id: "facts", title: "Facts", empty: "No facts stated.", items: m.facts.map((f) => item(f, "Fact", f.statement, null)) },
      {
        id: "limits",
        title: "Hard limits",
        empty: "No limits stated. Kritva will not assume one.",
        items: mine(m.limits).map((l) =>
          item(l, `${termName(l.termId)}: ${(KIND_LABEL[l.kind] ?? l.kind).toLowerCase()}`, `${val(l.value)}${conditionText(l.conditionIds)}${l.exception === "with_approval" ? " · exception possible with your approval" : l.exception === "not_allowed" ? " · no exceptions" : ""}`, l.value ? "value" : null, { currentValue: valueOf(l.value) }),
        ),
      },
      {
        id: "goals",
        title: "Goals, targets and preferences",
        empty: "None stated.",
        items: [
          ...mine(m.goals).map((g) => item(g, g.kind === "need" ? "Need" : g.kind === "reason" ? "Reason" : "Goal", g.description, null)),
          ...mine(m.targets).map((t) => item(t, `Target ${termName(t.termId)}`, val(t.value), t.value ? "value" : null, { currentValue: valueOf(t.value) })),
          ...mine(m.preferences).map((p) => item(p, `${p.strength === "avoid" ? "Avoid" : p.strength === "preferred" ? "Prefer" : "Acceptable"} ${termName(p.termId)}`, val(p.value), p.value ? "value" : null, { currentValue: valueOf(p.value) })),
          ...mine(m.alternatives).map((a) => item(a, "If no deal", a.description, null)),
        ],
      },
      {
        id: "permissions",
        title: "What Kritva may do",
        empty: "No permissions stated. Kritva may not act without them.",
        items: m.permissions.map((p) => item(p, ACTION_LABEL[p.action] ?? p.action.replace(/_/g, " "), `${MODE_LABEL[p.mode] ?? p.mode}${p.termIds.length ? ` (${p.termIds.map(termName).join(", ")})` : ""}${conditionText(p.conditionIds)}`, "mode", { currentMode: p.mode })),
      },
      { id: "conditions", title: "Conditions", empty: "No conditions.", items: m.conditions.map((cnd) => item(cnd, "Condition", cnd.description, null, { removable: false })) },
    ],
    issues: m.issues.map((i) => ({ id: i.id, kind: ISSUE_LABEL[i.kind] ?? i.kind, message: i.message, blocking: i.kind === "conflict" })),
  };
}
