/**
 * The principal's log of negotiations: every session, most recent activity first, with the mandate,
 * who it was with, how it came in (a test in the console, a private link, the listing, a phone call
 * in or out) and where it stands. Operator only. Phone numbers never appear here.
 */
import type { Hono } from "hono";
import type { DealGroups, MandateLibrary, NegotiationRecord, PayloadOf, SessionStatus } from "@kritva/core";

export type LogOrigin = "test" | "link" | "listing" | "phone_in" | "phone_out";

export interface LogRow {
  sessionId: string;
  startedAt: string;
  lastAt: string;
  mandate: { id: string | null; title: string };
  /** The listed counterparty's name, when the session belongs to someone on the mandate's list. */
  counterparty: string | null;
  origin: LogOrigin;
  /** Every way they talked: typed chat, a browser call, a phone call. */
  channels: Array<"chat" | "voice" | "phone">;
  calls: { count: number; seconds: number };
  messages: number;
  status: SessionStatus;
  /** A voice call is connected right now. */
  live: boolean;
}

export interface LogDeps {
  record: NegotiationRecord;
  library: MandateLibrary | null;
  groups: DealGroups | null;
  /** The prepared case mandates, for sessions that did not start from a saved mandate. */
  mandates: Array<{ title: string; mandate: { caseId: string } }>;
  liveCalls?: () => Set<string>;
}

export function registerNegotiationLog(app: Hono, deps: LogDeps): void {
  app.get("/api/operator/negotiations", async (c) => {
    const limit = Math.min(300, Math.max(1, Number(c.req.query("limit") ?? 150) || 150));
    // Negotiations a mandate reset set aside are history, not shown.
    const setAside = new Set((deps.groups?.groups() ?? []).filter((g) => g.reset).flatMap((g) => g.members.map((m) => m.sessionId)));
    const sessions = (await deps.record.listSessions()).filter((s) => !setAside.has(s.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit);
    const live = deps.liveCalls?.() ?? new Set<string>();
    const rows = await Promise.all(sessions.map((s) => logRow(deps, s.id, s.caseId, s.createdAt, live)));
    return c.json(rows.sort((a, b) => b.lastAt.localeCompare(a.lastAt)));
  });
}

async function logRow(deps: LogDeps, sessionId: string, caseId: string, createdAt: string, live: Set<string>): Promise<LogRow> {
  const ctx = await deps.record.context(sessionId);
  const events = ctx.events;
  const first = events[0];
  const source = first?.type === "session_started" ? (first.payload as PayloadOf<"session_started">).mandateSource : null;
  const saved = source && deps.library ? deps.library.get(source.mandateId) : null;
  const title = saved?.title ?? deps.mandates.find((m) => m.mandate.caseId === caseId)?.title ?? caseId;

  const member = deps.groups?.groupOf(sessionId)?.members.find((m) => m.sessionId === sessionId) ?? null;
  const group = member ? deps.groups!.groupOf(sessionId) : null;
  const entry = member?.entryId && group && deps.library ? deps.library.counterparties(group.mandateId).find((e) => e.id === member.entryId) ?? null : null;

  const connections = events.filter((e) => e.type === "voice_connection").map((e) => ({ at: e.recordedAt, p: e.payload as PayloadOf<"voice_connection"> }));
  const phone = connections.filter((x) => x.p.transport === "phone");
  const outbound = phone.some((x) => x.p.direction === "outbound");
  // Call time: each connection's start to the end that follows it.
  let seconds = 0;
  let count = 0;
  let openedAt: number | null = null;
  for (const x of connections) {
    if (x.p.status === "connected") {
      count += 1;
      openedAt = Date.parse(x.at);
    } else if (x.p.status === "ended" && openedAt !== null) {
      seconds += Math.max(0, (Date.parse(x.at) - openedAt) / 1000);
      openedAt = null;
    }
  }
  if (openedAt !== null && live.has(sessionId)) seconds += Math.max(0, (Date.now() - openedAt) / 1000);

  const messages = events.filter((e) => e.type === "message");
  const channels = new Set<LogRow["channels"][number]>();
  if (messages.some((e) => e.channel === "text")) channels.add("chat");
  if (phone.length > 0) channels.add("phone");
  if (connections.some((x) => x.p.transport === "browser") || (phone.length === 0 && messages.some((e) => e.channel === "voice"))) channels.add("voice");

  const origin: LogOrigin =
    phone.length > 0 ? (outbound ? "phone_out" : "phone_in")
    : member?.via === "link" ? "link"
    : member?.via === "listing" ? "listing"
    : member?.via === "phone" ? "phone_out"
    : "test";

  return {
    sessionId,
    startedAt: first?.recordedAt ?? createdAt,
    lastAt: events.at(-1)?.recordedAt ?? createdAt,
    mandate: { id: source?.mandateId ?? null, title },
    counterparty: entry?.name ?? null,
    origin,
    channels: [...channels],
    calls: { count, seconds: Math.round(seconds) },
    messages: messages.length,
    status: ctx.status,
    live: live.has(sessionId),
  };
}
