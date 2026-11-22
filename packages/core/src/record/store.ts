/**
 * The negotiation record: validated, append-only, durable.
 *
 * - Append validates every event against the session's history before it is written.
 * - Each event is saved once. Retrying the same ID and content returns the stored event;
 *   different content under a used ID is rejected.
 * - Success means the event is committed to storage. A failed write returns an error
 *   and leaves recorded state unchanged.
 * - Reads never write. Counterparty reads include only public events.
 */
import { createHash, randomUUID } from "node:crypto";
import { validateConfirmedMandate } from "../mandate/confirm.ts";
import type { ConfirmedMandate } from "../schema/records.ts";
import type { ValidationIssue } from "../schema/validate.ts";
import { canonicalJson, PAYLOADS, type Actor, type EventType, type NewEvent, type RecordedEvent } from "./events.ts";
import { SessionContext, validateNewEvent, visibilityFor } from "./rules.ts";

export interface SessionRow {
  id: string;
  caseId: string;
  createdAt: string;
  previousSessionId: string | null;
}

export interface EventRow {
  id: string;
  sessionId: string;
  seq: number;
  recordedAt: string;
  type: string;
  actorKind: string;
  actorPartyId: string | null;
  channel: string | null;
  visibility: "public" | "private";
  payloadJson: string;
  contentHash: string;
}

/** Storage behind the record. SQLite today; the interface is what a managed database replaces. */
export interface RecordBackend {
  transaction<T>(fn: () => T): T;
  insertSession(row: SessionRow): void;
  getSession(id: string): SessionRow | null;
  listSessions(): SessionRow[];
  insertEvent(row: EventRow): void;
  getEvent(id: string): EventRow | null;
  listEvents(sessionId: string): EventRow[];
  /** The deal-group record (record/groups.ts): append-only, on the same connection as sessions. */
  insertGroupEvent(row: GroupEventRow): void;
  listGroupEvents(): GroupEventRow[];
  close(): void;
}

export interface GroupEventRow {
  id: string;
  groupId: string;
  seq: number;
  recordedAt: string;
  type: string;
  payloadJson: string;
}

/** Who is reading. Taken from the application, never from request content. */
export type Viewer = "principal" | "operator" | "evaluator" | "counterparty";

export type RecordErrorCode = "invalid_event" | "id_conflict" | "session_not_found" | "invalid_mandate" | "write_failed" | "group_conflict";
export interface RecordError {
  code: RecordErrorCode;
  message: string;
  errors: ValidationIssue[];
}

export type AppendResult =
  | { ok: true; event: RecordedEvent; created: boolean }
  | { ok: false; error: RecordError };

export type StartResult = { ok: true; session: SessionRow; startEvent: RecordedEvent } | { ok: false; error: RecordError };

export interface RecordOptions {
  now?: () => Date;
}

/** Thrown by a deal-group write that conflicts (for example the deal is held by another session). */
export class GroupConflict extends Error {}

export function newEventId(): string {
  return `evt_${randomUUID()}`;
}

export class NegotiationRecord {
  readonly #backend: RecordBackend;
  readonly #now: () => Date;

  constructor(backend: RecordBackend, options: RecordOptions = {}) {
    this.#backend = backend;
    this.#now = options.now ?? (() => new Date());
  }

  /** Starts a session from a confirmed mandate. A reset is a new session that names the old one. */
  async startSession(input: {
    mandate: ConfirmedMandate;
    sessionId?: string;
    previousSessionId?: string | null;
    mandateSource?: { mandateId: string; revision: number } | null;
  }): Promise<StartResult> {
    const checked = validateConfirmedMandate(input.mandate);
    if (!checked.ok) return fail("invalid_mandate", "The mandate is not a valid confirmed mandate.", checked.errors);
    const sessionId = input.sessionId ?? `ses_${randomUUID()}`;
    const previous = input.previousSessionId ?? null;
    if (previous !== null && !this.#backend.getSession(previous)) {
      return fail("session_not_found", "The previous session does not exist.", []);
    }
    if (this.#backend.getSession(sessionId)) return fail("id_conflict", "A session with this ID already exists.", []);

    const at = this.#now().toISOString();
    const session: SessionRow = { id: sessionId, caseId: checked.mandate.caseId, createdAt: at, previousSessionId: previous };
    const event: NewEvent<"session_started"> = {
      id: newEventId(),
      type: "session_started",
      channel: null,
      payload: { mandate: checked.mandate, mandateRevision: 1, previousSessionId: previous, mandateSource: input.mandateSource ?? null },
    };
    const row = toRow(event, { kind: "system", partyId: null }, sessionId, 1, at, "private");
    try {
      this.#backend.transaction(() => {
        this.#backend.insertSession(session);
        this.#backend.insertEvent(row);
      });
    } catch {
      return fail("write_failed", "The session could not be saved.", []);
    }
    return { ok: true, session, startEvent: fromRow(row) };
  }

  /** Resets by starting a new session with the selected mandate. The old session is kept unchanged. */
  async resetSession(previousSessionId: string, mandate: ConfirmedMandate): Promise<StartResult> {
    return this.startSession({ mandate, previousSessionId });
  }

  /**
   * Validates and saves one event. `actor` comes from application metadata. `alsoWrite` runs in
   * the same transaction once the event is written (a deal-group write that must commit with it);
   * if it throws, neither is saved.
   */
  async append(sessionId: string, event: NewEvent, actor: Actor, options: { alsoWrite?: () => void } = {}): Promise<AppendResult> {
    try {
      return this.#backend.transaction(() => {
        const result = this.#appendInTransaction(sessionId, event, actor);
        if (result.ok && result.created && options.alsoWrite) options.alsoWrite();
        return result;
      });
    } catch (error) {
      if (error instanceof GroupConflict) return fail("group_conflict", error.message, []);
      return fail("write_failed", "The event could not be saved. Nothing was recorded.", []);
    }
  }

  /** The deal-group tables, for record/groups.ts. */
  groupBackend(): Pick<RecordBackend, "insertGroupEvent" | "listGroupEvents" | "transaction"> {
    return this.#backend;
  }

  #appendInTransaction(sessionId: string, event: NewEvent, actor: Actor): AppendResult {
    if (!this.#backend.getSession(sessionId)) return fail("session_not_found", "The session does not exist.", []);

    const contentHash = hashContent(event, actor);
    const existing = this.#backend.getEvent(event.id);
    if (existing) {
      if (existing.sessionId === sessionId && existing.contentHash === contentHash) {
        return { ok: true, event: fromRow(existing), created: false };
      }
      return fail("id_conflict", "This event ID is already used for different content.", [
        { path: "id", reason: "already used for different content" },
      ]);
    }

    const ctx = new SessionContext(this.#backend.listEvents(sessionId).map(fromRow));
    const errors = validateNewEvent(event, actor, ctx);
    if (errors.length > 0) return fail("invalid_event", "The event was rejected.", errors);

    const seq = (ctx.events.at(-1)?.seq ?? 0) + 1;
    // Store the parsed payload, so defaults are written down rather than implied.
    const stored = { ...event, payload: PAYLOADS[event.type].parse(event.payload) } as NewEvent;
    const row = toRow(stored, actor, sessionId, seq, this.#now().toISOString(), visibilityFor(event.type, ctx, event.payload));
    row.contentHash = contentHash;
    this.#backend.insertEvent(row);
    return { ok: true, event: fromRow(row), created: true };
  }

  /** One ordered history for a session. Order is the assigned sequence number. */
  async read(sessionId: string, options: { viewer: Viewer; afterSeq?: number }): Promise<RecordedEvent[]> {
    const rows = this.#backend.listEvents(sessionId);
    const events = rows.map(fromRow).filter((e) => e.seq > (options.afterSeq ?? 0));
    return options.viewer === "counterparty" ? events.filter((e) => e.visibility === "public") : events;
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    return this.#backend.getSession(sessionId);
  }

  async listSessions(): Promise<SessionRow[]> {
    return this.#backend.listSessions();
  }

  /** Session context for components that must decide from recorded state (never from memory). */
  async context(sessionId: string): Promise<SessionContext> {
    return new SessionContext(this.#backend.listEvents(sessionId).map(fromRow));
  }

  close(): void {
    this.#backend.close();
  }
}

function fail(code: RecordErrorCode, message: string, errors: ValidationIssue[]): { ok: false; error: RecordError } {
  return { ok: false, error: { code, message, errors } };
}

function hashContent(event: NewEvent, actor: Actor): string {
  return createHash("sha256")
    .update(canonicalJson({ type: event.type, channel: event.channel, actor, payload: event.payload }))
    .digest("hex");
}

function toRow(event: NewEvent, actor: Actor, sessionId: string, seq: number, at: string, visibility: "public" | "private"): EventRow {
  return {
    id: event.id,
    sessionId,
    seq,
    recordedAt: at,
    type: event.type,
    actorKind: actor.kind,
    actorPartyId: actor.partyId,
    channel: event.channel,
    visibility,
    payloadJson: JSON.stringify(event.payload),
    contentHash: hashContent(event, actor),
  };
}

function fromRow(row: EventRow): RecordedEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    recordedAt: row.recordedAt,
    type: row.type as EventType,
    actor: { kind: row.actorKind as Actor["kind"], partyId: row.actorPartyId },
    channel: row.channel as RecordedEvent["channel"],
    visibility: row.visibility,
    payload: JSON.parse(row.payloadJson),
  };
}
