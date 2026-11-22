/**
 * Several counterparties on one deal (docs/Kritva_Multiple_Counterparties.md): starting negotiations
 * in a saved mandate's group, the mandate's counterparty list, and the principal's measured time.
 * The board itself is in board-routes (it reads every member session).
 */
import type { Hono } from "hono";
import { formatValue, numericValue, orderTerms, projectBoard, projectState, type ConfirmedMandate, type DealGroups, type JoinVia, type MandateLibrary, type NegotiationRecord, type OfferTerm, type MandateView } from "@kritva/core";

/**
 * Calls Kritva places to counterparties (the telephony work, src/phone/outbound.ts). Numbers come from
 * the mandate's counterparty list and never enter a negotiation record; the dialer keeps them in memory
 * and masks them in logs. One call belongs to one negotiation session.
 */
export interface CallView {
  callId: string;
  sessionId: string;
  /** Masked by the dialer (91******4567). */
  to: string;
  state: "queued" | "dialling" | "ringing" | "answered" | "connected" | "ended";
  outcome: null | "completed" | "no_answer" | "busy" | "failed" | "blocked" | "cancelled";
  startedAt: string;
  answeredAt?: string | null;
  connectedAt?: string | null;
  endedAt?: string | null;
  endReason?: string | null;
}

export interface Dialer {
  call(input: { sessionId: string; to: string; clientRequestId?: string }): Promise<{ ok: true; call: CallView } | { ok: false; code: string; message: string }>;
  listForSession(sessionId: string): CallView[] | Promise<CallView[]>;
  hangup(callId: string): Promise<unknown>;
  /** Whether a number can be called from here (valid and allowed), without calling it. */
  canDial?(to: string): { ok: true } | { ok: false; code: string; message: string };
}

/**
 * Who the "call everyone" campaign reaches next. Each listed counterparty is reached once: someone
 * with no negotiation yet gets a call (or a private link without a number), and someone who only
 * got a link and hasn't said anything gets one call in that negotiation. Anyone who has talked,
 * was already called, or whose negotiation ended is left alone.
 */
export interface CampaignPlan {
  call: Array<{ entryId: string; name: string; sessionId: string | null }>;
  link: Array<{ entryId: string; name: string }>;
  /** Have a number Kritva can't call from this server, with why. */
  blocked: Array<{ entryId: string; name: string; code: string; message: string }>;
  /** Already reached once. */
  reached: number;
}

/** When a deal went elsewhere: stop any call to that counterparty that has not been answered yet. */
export async function hangUpPending(dialer: Dialer | null, sessionId: string): Promise<void> {
  if (!dialer) return;
  for (const call of await dialer.listForSession(sessionId)) {
    if (call.state === "queued" || call.state === "dialling" || call.state === "ringing") await dialer.hangup(call.callId).catch(() => undefined);
  }
}

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
  locale: string;
  /** Session IDs with a voice call connected now (browser or phone), when the server tracks them. */
  liveCalls?: () => Set<string>;
  /** Kritva calling counterparties' numbers. Absent when outbound calling is off. */
  dialer?: Dialer | null;
  /**
   * Whether the board may place calls ("Start negotiations" dialling, and the Call button). Off by
   * default (KRITVA_BOARD_CALLS=on turns it on), so outbound problems never reach a demo.
   */
  boardCalls?: boolean;
  /** Ends one negotiation without agreement (a reset ends the mandate's open ones). */
  endSession?: (sessionId: string) => Promise<unknown>;
}

export function registerGroupRoutes(app: Hono, deps: GroupRouteDeps): void {
  const { library, groups, record } = deps;
  // The board places calls only when switched on and a dialer exists.
  const dialer = deps.boardCalls ? (deps.dialer ?? null) : null;
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

  const campaignPlan = async (mandateId: string): Promise<CampaignPlan> => {
    const plan: CampaignPlan = { call: [], link: [], blocked: [], reached: 0 };
    const group = groups.latestFor(mandateId);
    const entries = library.counterparties(mandateId);
    if (group?.concluded) return { ...plan, reached: entries.length };
    const open = new Set(group ? await groups.openSessions(group) : []);
    const dialCheck = (phone: string) => (dialer?.canDial ? dialer.canDial(phone) : ({ ok: true } as const));
    for (const e of entries) {
      const member = group?.members.filter((m) => m.entryId === e.id).at(-1) ?? null;
      if (!member) {
        if (!e.phone || !dialer) plan.link.push({ entryId: e.id, name: e.name });
        else {
          const ok = dialCheck(e.phone);
          if (ok.ok) plan.call.push({ entryId: e.id, name: e.name, sessionId: null });
          else plan.blocked.push({ entryId: e.id, name: e.name, code: ok.code, message: ok.message });
        }
        continue;
      }
      // Already in a negotiation: one call only for someone who got a link and hasn't said anything.
      const linkOnly = e.phone && dialer && member.via !== "phone" && open.has(member.sessionId) && (await dialer.listForSession(member.sessionId)).length === 0;
      const spoke = linkOnly ? (await record.context(member.sessionId)).events.some((ev) => ev.type === "message" && (ev.payload as { direction?: string }).direction === "inbound") : true;
      if (linkOnly && !spoke) {
        const ok = dialCheck(e.phone!);
        if (ok.ok) plan.call.push({ entryId: e.id, name: e.name, sessionId: member.sessionId });
        else plan.blocked.push({ entryId: e.id, name: e.name, code: ok.code, message: ok.message });
      } else plan.reached += 1;
    }
    return plan;
  };

  // One campaign start (or single call) per mandate at a time, so a double click or a second tab
  // can't reach anyone twice.
  const running = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(mandateId: string, run: () => Promise<T>): Promise<T> => {
    const next = (running.get(mandateId) ?? Promise.resolve()).then(run, run);
    running.set(mandateId, next.catch(() => undefined));
    return next;
  };

  /**
   * Reset: start the mandate over without making a new one. Its open negotiations end (calls still
   * ringing are stopped), they leave the deal and the log, and a fresh group starts so everyone on
   * the list can be reached again. The record keeps everything; nothing is deleted.
   */
  app.post("/api/operator/library/:id/reset", async (c) => {
    const id = c.req.param("id");
    const detail = found(id);
    if (!detail) return c.json({ error: "not_found" }, 404);
    const ended = await oneAtATime(id, async () => {
      const open = await groups.reset(id, detail.caseId);
      for (const sessionId of open) {
        await hangUpPending(deps.dialer ?? null, sessionId);
        await Promise.resolve(deps.endSession?.(sessionId)).catch(() => undefined);
      }
      return open.length;
    });
    return c.json({ ended, ...(await listView(id)) });
  });

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

  /**
   * The campaign: reaches every listed counterparty not reached yet, once (see CampaignPlan). Kritva
   * calls everyone with a number it may call; the others get a private link. Runs one at a time per
   * mandate, so pressing it twice reaches nobody twice.
   */
  app.post("/api/operator/library/:id/start", async (c) => {
    const id = c.req.param("id");
    const detail = found(id);
    if (!detail) return c.json({ error: "not_found" }, 404);
    const active = library.active(id);
    if (!active || detail.state !== "live") return c.json({ error: "not_live", message: "Make this mandate live before starting negotiations." }, 409);
    if (groups.latestFor(id)?.concluded) return c.json({ error: "deal_concluded", message: "This deal is already agreed." }, 409);
    const result = await oneAtATime(id, async () => {
      const plan = await campaignPlan(id);
      const entries = new Map(library.counterparties(id).map((e) => [e.id, e]));
      const started: Array<{ entryId: string; sessionId: string }> = [];
      const refused: Array<{ entryId: string; message: string }> = [];
      const calls: Array<{ entryId: string; ok: boolean; message: string | null }> = [];
      const begin = async (entryId: string, via: JoinVia) => {
        const r = await startNegotiation(groups, record, { mandate: active.mandate, source: { mandateId: id, revision: active.revision }, entryId, via });
        if (!r.ok) refused.push({ entryId, message: r.message });
        else started.push({ entryId, sessionId: r.sessionId });
        return r.ok ? r.sessionId : null;
      };
      for (const target of plan.call) {
        const sessionId = target.sessionId ?? (await begin(target.entryId, "phone"));
        const phone = entries.get(target.entryId)?.phone;
        if (!sessionId || !phone || !dialer) continue;
        const placed = await dialer.call({ sessionId, to: phone, clientRequestId: `campaign-${sessionId}` });
        calls.push({ entryId: target.entryId, ok: placed.ok, message: placed.ok ? null : placed.message });
      }
      for (const target of plan.link) await begin(target.entryId, "link");
      return { started, refused, calls, blocked: plan.blocked };
    });
    const reachedNow = result.started.length + result.calls.filter((x) => x.ok).length;
    return c.json({ ...result, ...(await listView(id)), campaign: await campaignPlan(id) }, reachedNow > 0 ? 201 : 200);
  });

  /** Calls one listed counterparty (again): their open negotiation, or a new one within the cap. */
  app.post("/api/operator/library/:id/counterparties/:entryId/call", async (c) => {
    const id = c.req.param("id");
    if (!dialer) return c.json({ error: "phone_off", message: "Calling from the board is off on this server." }, 409);
    const entry = library.counterparties(id).find((e) => e.id === c.req.param("entryId"));
    if (!entry) return c.json({ error: "not_found" }, 404);
    if (!entry.phone) return c.json({ error: "no_number", message: `${entry.name} has no phone number on the list.` }, 409);
    const body = await c.req.json<{ clientRequestId?: string }>().catch(() => ({}) as { clientRequestId?: string });
    const out = await oneAtATime(id, async (): Promise<{ status: 202 | 400 | 409; json: Record<string, unknown> }> => {
      let sessionId = await openSessionFor(groups, id, entry.id);
      if (!sessionId) {
        // Each counterparty is negotiated with once: a finished negotiation isn't started over.
        if (groups.latestFor(id)?.members.some((m) => m.entryId === entry.id)) return { status: 409, json: { error: "already_negotiated", message: `Kritva has already negotiated with ${entry.name} for this deal.` } };
        const active = library.active(id);
        if (!active || found(id)?.state !== "live") return { status: 409, json: { error: "not_live", message: "Make this mandate live before calling." } };
        const r = await startNegotiation(groups, record, { mandate: active.mandate, source: { mandateId: id, revision: active.revision }, entryId: entry.id, via: "phone" });
        if (!r.ok) return { status: r.status, json: { error: r.error, message: r.message } };
        sessionId = r.sessionId;
      }
      // A call already on its way or connected is that call: pressing Call again doesn't ring them twice.
      const current = (await dialer.listForSession(sessionId)).find((x) => x.state !== "ended");
      if (current) return { status: 202, json: { call: current } };
      const placed = await dialer.call({ sessionId, to: entry.phone!, clientRequestId: typeof body.clientRequestId === "string" ? body.clientRequestId.slice(0, 100) : undefined });
      return placed.ok ? { status: 202, json: { call: placed.call } } : { status: 409, json: { error: placed.code, message: placed.message } };
    });
    return c.json(out.json, out.status);
  });

  /** The deal's board: one row per counterparty, the best live offer, pending approvals and the counters. */
  app.get("/api/operator/library/:id/board", async (c) => {
    const id = c.req.param("id");
    const detail = found(id);
    if (!detail) return c.json({ error: "not_found" }, 404);
    const group = groups.latestFor(id);
    const entries = library.counterparties(id);
    if (!group) return c.json({ mandateId: id, title: detail.title, state: detail.state, max: groups.maxOpen, canCall: Boolean(dialer), campaign: await campaignPlan(id), rows: [], waiting: entries.map((e) => ({ entryId: e.id, name: e.name })), bestSessionId: null, reservation: null, concluded: null, counters: { negotiationsRun: 0, timeMs: 0, dealsOutsideLimits: 0 } });
    const live = deps.liveCalls?.() ?? null;
    const inputs = await Promise.all(group.members.map(async (m) => {
      const ctx = await record.context(m.sessionId);
      const entry = entries.find((e) => e.id === m.entryId) ?? null;
      return { sessionId: m.sessionId, state: projectState(ctx), ctx, entry: entry ? { id: entry.id, name: entry.name } : null, via: m.via };
    }));
    const board = projectBoard(inputs, group);
    const lastCalls = new Map<string, CallView | null>();
    for (const m of group.members) lastCalls.set(m.sessionId, deps.dialer ? ((await deps.dialer.listForSession(m.sessionId)).at(-1) ?? null) : null);
    const nameOf = (sessionId: string) => board.rows.find((r) => r.sessionId === sessionId)?.name ?? null;
    const rows = board.rows.map((row, i) => {
      const state = inputs[i]!.state;
      const view = state.view;
      const pending = state.pendingApproval;
      return {
        sessionId: row.sessionId,
        name: row.name,
        via: row.via,
        channel: row.channel,
        live: live ? live.has(row.sessionId) : row.live,
        status: row.status,
        offer: row.offer ? { amount: amountText(view, row.offer.amount, deps.locale), changes: changedTerms(view, row.offer.terms, deps.locale), accepted: row.offer.accepted, at: row.offer.at } : null,
        gap: gapText(view, row.gap, deps.locale),
        gapValue: row.gap,
        score: row.score === null ? null : Math.round(row.score * 100),
        flag: row.flag,
        best: row.best,
        contact: row.contact,
        lastActivityAt: row.lastActivityAt,
        link: `/?view=buyer#session=${row.sessionId}`,
        // The latest call Kritva placed to them, with its number masked by the dialer.
        call: lastCalls.get(row.sessionId) ?? null,
        approval: pending
          ? {
              requestId: pending.requestId,
              offerId: pending.offerId,
              mandateRevision: state.mandateRevision,
              purpose: pending.purpose,
              terms: orderTerms(view, inputs[i]!.ctx.offerTerms(pending.offerId)?.terms ?? []).map((t) => ({ name: view.terms.get(t.termId)?.name ?? t.termId, value: formatValue(t.value, deps.locale) })),
              // An earlier request in this negotiation was for different terms: this is a new decision.
              termsChanged: inputs[i]!.ctx.events.some((e) => e.type === "approval_requested" && e.id !== pending.requestId && (e.payload as { termsHash: string }).termsHash !== pending.termsHash),
              // Another counterparty holds the deal: this one can be approved only if that falls through.
              heldBy: group.reservation && group.reservation.sessionId !== row.sessionId ? (nameOf(group.reservation.sessionId) ?? "another counterparty") : null,
            }
          : null,
      };
    });
    const started = new Set(group.members.map((m) => m.entryId));
    return c.json({
      mandateId: id,
      title: detail.title,
      state: detail.state,
      max: groups.maxOpen,
      canCall: Boolean(dialer),
      campaign: await campaignPlan(id),
      rows,
      waiting: entries.filter((e) => !started.has(e.id)).map((e) => ({ entryId: e.id, name: e.name })),
      bestSessionId: board.bestSessionId,
      reservation: group.reservation ? { sessionId: group.reservation.sessionId, name: nameOf(group.reservation.sessionId) } : null,
      concluded: group.concluded ? { sessionId: group.concluded.sessionId, name: nameOf(group.concluded.sessionId) } : null,
      counters: board.counters,
    });
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

function amountText(view: MandateView, amount: number | null, locale: string): string | null {
  const n = view.negotiable;
  return n && amount !== null ? formatValue(numericValue(n, amount), locale) : null;
}

/** "₹1,500 above your floor" or "₹500 below your floor", in the principal's direction. */
function gapText(view: MandateView, gap: number | null, locale: string): string | null {
  const n = view.negotiable;
  if (!n || gap === null) return null;
  const word = n.direction === "up" ? "floor" : "ceiling";
  if (gap === 0) return `At your ${word}`;
  const amount = formatValue(numericValue(n, Math.abs(gap)), locale);
  return n.direction === "up" ? `${amount} ${gap > 0 ? "above" : "below"} your ${word}` : `${amount} ${gap > 0 ? "under" : "over"} your ${word}`;
}

/** The terms of an offer that differ from the principal's public package (the price is shown on its own). */
function changedTerms(view: MandateView, terms: OfferTerm[], locale: string): string[] {
  return orderTerms(view, terms)
    .filter((t) => t.termId !== view.negotiable?.termId)
    .filter((t) => {
      const base = view.defaultPackage.find((d) => d.termId === t.termId);
      return !base || JSON.stringify(base.value) !== JSON.stringify(t.value);
    })
    .map((t) => `${view.terms.get(t.termId)?.name ?? t.termId}: ${formatValue(t.value, locale)}`);
}
