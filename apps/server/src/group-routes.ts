/**
 * Several counterparties on one deal (docs/Kritva_Multiple_Counterparties.md): starting negotiations
 * in a saved mandate's group, the mandate's counterparty list, and the principal's measured time.
 * The board itself is in board-routes (it reads every member session).
 */
import type { Hono } from "hono";
import type { ConfirmedMandate, DealGroups, JoinVia, MandateLibrary, NegotiationRecord } from "@kritva/core";

export type StartOutcome = { ok: true; sessionId: string } | { ok: false; status: 400 | 409; error: string; message: string };

/**
 * One way to start a negotiation for every entry point. Under a saved mandate with groups on, the
 * session joins that mandate's group (and the cap applies); otherwise it starts on its own, as before.
 */
export async function startNegotiation(
  groups: DealGroups | null,
  record: NegotiationRecord,
  input: { mandate: ConfirmedMandate; source: { mandateId: string; revision: number } | null; entryId?: string | null; via: JoinVia; previousSessionId?: string | null },
): Promise<StartOutcome> {
  if (groups && input.source) {
    const r = await groups.start({ mandate: input.mandate, mandateSource: input.source, entryId: input.entryId ?? null, via: input.via, previousSessionId: input.previousSessionId ?? null });
    if (r.ok) return { ok: true, sessionId: r.sessionId };
    if (r.code === "full") return { ok: false, status: 409, error: "busy", message: "Busy right now. Try again in a little while." };
    if (r.code === "concluded") return { ok: false, status: 409, error: "deal_concluded", message: "This has already been agreed with someone else." };
    return { ok: false, status: 400, error: "start_failed", message: r.message };
  }
  const started = await record.startSession({ mandate: input.mandate, previousSessionId: input.previousSessionId ?? null, mandateSource: input.source });
  return started.ok ? { ok: true, sessionId: started.session.id } : { ok: false, status: 400, error: started.error.code, message: started.error.message };
}

/** The listed counterparty's open session in the mandate's current group, if any. */
export async function openSessionFor(groups: DealGroups, mandateId: string, entryId: string): Promise<string | null> {
  const group = groups.latestFor(mandateId);
  if (!group || group.concluded) return null;
  const open = new Set(await groups.openSessions(group));
  return group.members.find((m) => m.entryId === entryId && open.has(m.sessionId))?.sessionId ?? null;
}

export interface GroupRouteDeps {
  record: NegotiationRecord;
  library: MandateLibrary;
  groups: DealGroups;
}

export function registerGroupRoutes(app: Hono, deps: GroupRouteDeps): void {
  const { library, groups, record } = deps;
  const found = (id: string) => {
    const d = library.get(id);
    return d && !d.deleted ? d : null;
  };

  const listView = async (mandateId: string) => {
    const group = groups.latestFor(mandateId);
    const open = new Set(group && !group.concluded ? await groups.openSessions(group) : []);
    return {
      max: groups.maxOpen,
      entries: library.counterparties(mandateId).map((e) => {
        const member = group?.members.filter((m) => m.entryId === e.id).at(-1) ?? null;
        return { ...e, sessionId: member?.sessionId ?? null, open: member ? open.has(member.sessionId) : false };
      }),
    };
  };

  app.get("/api/operator/library/:id/counterparties", async (c) => {
    const id = c.req.param("id");
    if (!found(id)) return c.json({ error: "not_found" }, 404);
    return c.json(await listView(id));
  });

  app.post("/api/operator/library/:id/counterparties", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ name?: string; phone?: string | null; note?: string | null }>().catch(() => ({}) as Record<string, never>);
    const added = library.addCounterparty(id, { name: String(body.name ?? ""), phone: body.phone ?? null, note: body.note ?? null }, groups.maxOpen);
    if (!added.ok) return c.json({ error: added.code, message: added.message }, added.code === "not_found" ? 404 : added.code === "full" ? 409 : 400);
    return c.json({ entry: added.value, ...(await listView(id)) }, 201);
  });

  app.patch("/api/operator/library/:id/counterparties/:entryId", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ name?: string; phone?: string | null; note?: string | null }>().catch(() => ({}) as Record<string, never>);
    const updated = library.updateCounterparty(id, c.req.param("entryId"), { name: String(body.name ?? ""), phone: body.phone ?? null, note: body.note ?? null });
    if (!updated.ok) return c.json({ error: updated.code, message: updated.message }, updated.code === "not_found" ? 404 : 400);
    return c.json(await listView(id));
  });

  app.delete("/api/operator/library/:id/counterparties/:entryId", async (c) => {
    const id = c.req.param("id");
    const removed = library.removeCounterparty(id, c.req.param("entryId"));
    if (!removed.ok) return c.json({ error: removed.code, message: removed.message }, 404);
    return c.json(await listView(id));
  });

  /** Starts a negotiation for every listed counterparty that has none open, up to the cap. */
  app.post("/api/operator/library/:id/start", async (c) => {
    const id = c.req.param("id");
    const detail = found(id);
    if (!detail) return c.json({ error: "not_found" }, 404);
    const active = library.active(id);
    if (!active || detail.state !== "live") return c.json({ error: "not_live", message: "Make this mandate live before starting negotiations." }, 409);
    const started: Array<{ entryId: string; sessionId: string }> = [];
    const refused: Array<{ entryId: string; message: string }> = [];
    for (const entry of library.counterparties(id)) {
      if (await openSessionFor(groups, id, entry.id)) continue;
      const r = await startNegotiation(groups, record, { mandate: active.mandate, source: { mandateId: id, revision: active.revision }, entryId: entry.id, via: "link" });
      if (r.ok) started.push({ entryId: entry.id, sessionId: r.sessionId });
      else refused.push({ entryId: entry.id, message: r.message });
    }
    return c.json({ started, refused, ...(await listView(id)) }, started.length > 0 ? 201 : 200);
  });

  /** The console reports how long a decision took on screen; the header adds it up. */
  app.post("/api/operator/library/:id/time", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ action?: string; sessionId?: string | null; ms?: number }>().catch(() => ({}) as Record<string, never>);
    const group = groups.latestFor(id);
    if (!group || typeof body.ms !== "number" || !Number.isFinite(body.ms) || typeof body.action !== "string" || !/^[a-z_]{1,40}$/.test(body.action)) return c.json({ error: "invalid_time" }, 400);
    groups.recordTime(group.groupId, { action: body.action, sessionId: typeof body.sessionId === "string" ? body.sessionId : null, ms: body.ms });
    return c.json({ ok: true });
  });
}
