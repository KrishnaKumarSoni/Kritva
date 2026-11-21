/**
 * Intake routes: the principal creates or changes a saved mandate by chatting with the intake
 * agent. Operator routes only. The only route that gives a draft authority is /live, the
 * principal's own "make it live" action for the exact version shown in the chat.
 */
import type { Hono } from "hono";
import { intakeProgress, CHECKLIST_ITEMS, type IntakeConversation, type IntakeService, type MandateLibrary, type NegotiationEngine, type NegotiationRecord } from "@kritva/core";
import { libraryView, openSessionsUsing } from "./library-routes.ts";

export interface IntakeDeps {
  intake: IntakeService;
  library: MandateLibrary;
  record: NegotiationRecord;
  engine: NegotiationEngine;
  locale: string;
}

/** Request bodies carry images as data URLs; allow up to four large ones. */
const MAX_BODY_BYTES = 40 * 1024 * 1024;

export function registerIntakeRoutes(app: Hono, deps: IntakeDeps): void {
  const { intake, library, locale } = deps;
  const view = (c: IntakeConversation) => intakeView(c, library, locale);
  const status = (code: string) => (code === "not_found" ? 404 : code === "invalid_input" || code === "not_ready" ? 400 : code === "agent_failed" ? 502 : code.includes("draft") || code === "blocked" ? 409 : 422);

  /** Conversations that haven't become a saved mandate yet (shown as drafts in the list). */
  app.get("/api/operator/intake", (c) => c.json(intake.drafts().map((d) => ({ id: d.id, title: d.fields.title || firstWords(d), updatedAt: d.updatedAt, progress: intakeProgress(d.checklist, { draftReady: false, live: false }) }))));

  app.post("/api/operator/intake", (c) => c.json(view(intake.start()), 201));

  app.get("/api/operator/intake/mandate/:mandateId", (c) => {
    const r = intake.forMandate(c.req.param("mandateId"));
    return r.ok ? c.json(view(r.value)) : c.json({ error: r.code, message: r.message }, status(r.code));
  });

  app.get("/api/operator/intake/:id", (c) => {
    const conversation = intake.get(c.req.param("id"));
    return conversation ? c.json(view(conversation)) : c.json({ error: "not_found", message: "That conversation does not exist." }, 404);
  });

  app.post("/api/operator/intake/:id/messages", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) return c.json({ error: "too_large", message: "Those pictures are too large together. Try fewer at a time." }, 413);
    const body = await c.req.json<{ text?: unknown; images?: unknown }>().catch(() => ({}) as { text?: unknown; images?: unknown });
    const r = await intake.send(c.req.param("id"), { text: typeof body.text === "string" ? body.text : "", images: Array.isArray(body.images) ? body.images.filter((i): i is string => typeof i === "string") : [] }, c.req.raw.signal);
    return r.ok ? c.json(view(r.value)) : c.json({ error: r.code, message: r.message }, status(r.code));
  });

  app.post("/api/operator/intake/:id/prepare", async (c) => {
    const r = await intake.prepare(c.req.param("id"), c.req.raw.signal);
    return r.ok ? c.json(view(r.value)) : c.json({ error: r.code, message: r.message }, status(r.code));
  });

  /** The principal's "make it live". Open negotiations using this mandate move to the new revision through Epic 4's checks. */
  app.post("/api/operator/intake/:id/live", async (c) => {
    const body = await c.req.json<{ versionId?: unknown; draftHash?: unknown }>().catch(() => ({}) as Record<string, unknown>);
    const r = intake.goLive(c.req.param("id"), { versionId: String(body.versionId ?? ""), draftHash: String(body.draftHash ?? "") });
    if (!r.ok) return c.json({ error: r.code, message: r.message }, status(r.code));
    const mandateId = r.value.detail.mandateId;
    const applied: string[] = [];
    for (const sessionId of await openSessionsUsing(deps.record, mandateId)) {
      const revised = await deps.engine.reviseMandate({ sessionId, mandate: r.value.mandate, reason: `The principal made revision ${r.value.revision} of the saved mandate live.`, mandateSource: { mandateId, revision: r.value.revision } });
      if (revised.ok) applied.push(sessionId);
    }
    return c.json({ ...view(r.value.conversation), appliedToSessions: applied });
  });

  app.delete("/api/operator/intake/:id", (c) => {
    const r = intake.discard(c.req.param("id"));
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.code, message: r.message }, status(r.code));
  });
}

function firstWords(c: IntakeConversation): string {
  const text = c.messages.find((m) => m.role === "user" && m.text)?.text ?? "";
  const words = text.split(/\s+/).slice(0, 6).join(" ");
  return words ? `${words}${text.split(/\s+/).length > 6 ? "…" : ""}` : "New mandate";
}

export function intakeView(c: IntakeConversation, library: MandateLibrary, locale: string) {
  const detail = c.mandateId ? library.get(c.mandateId) : null;
  const mandate = detail && !detail.deleted ? libraryView(detail, locale) : null;
  const latest = detail?.latest ?? null;
  // A card can be acted on only while its version is still the latest open draft.
  const actionable = (versionId: string) => latest?.versionId === versionId && latest.status === "draft";
  const lastReady = [...c.messages].reverse().find((m) => m.card?.kind === "ready");
  const draftReady = Boolean(lastReady?.card && lastReady.card.kind === "ready" && actionable(lastReady.card.versionId));
  // The bar is full once a ready draft is on the card, or while the chat matches a confirmed revision.
  const settled = Boolean(detail?.active) && !draftReady && !c.readyToPrepare && sameInput(c.fields, detail!.input);
  return {
    id: c.id,
    mandateId: c.mandateId,
    title: detail?.title ?? (c.fields.title || "New mandate"),
    state: detail?.state ?? "new",
    messages: c.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      images: m.images,
      at: m.at,
      card:
        m.card?.kind === "ready"
          ? { kind: "ready" as const, versionId: m.card.versionId, draftHash: m.card.draftHash, notes: m.card.notes.map((n) => n.message), mode: m.card.mode, actionable: actionable(m.card.versionId), review: latest && latest.versionId === m.card.versionId ? mandate?.latest?.review ?? null : null }
          : m.card?.kind === "live"
            ? { kind: "live" as const, revision: m.card.revision }
            : null,
    })),
    checklist: CHECKLIST_ITEMS.map((i) => ({ id: i.id, label: i.label, required: i.required, status: c.checklist[i.id] })),
    progress: intakeProgress(c.checklist, { draftReady, live: settled }),
    next: c.readyToPrepare ? ("prepare" as const) : null,
    mandate,
  };
}

function sameInput(a: IntakeConversation["fields"], b: IntakeConversation["fields"]): boolean {
  return a.title === b.title && a.principalRole === b.principalRole && a.counterpartyRole === b.counterpartyRole && a.publicText === b.publicText && a.privateText === b.privateText;
}
