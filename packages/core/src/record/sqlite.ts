/**
 * SQLite storage for the negotiation record (Node's built-in `node:sqlite`).
 *
 * Writes use WAL with synchronous=FULL, so a returned append is on disk. Events are
 * append-only: there is no update or delete path, and the database rejects duplicate
 * IDs and duplicate sequence numbers within a session.
 */
import { DatabaseSync } from "node:sqlite";
import type { EventRow, GroupEventRow, RecordBackend, SessionRow } from "./store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  previous_session_id TEXT REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_party_id TEXT,
  channel TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  payload TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE IF NOT EXISTS group_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (group_id, seq)
);
CREATE TRIGGER IF NOT EXISTS group_events_no_update BEFORE UPDATE ON group_events
BEGIN SELECT RAISE(ABORT, 'group events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS group_events_no_delete BEFORE DELETE ON group_events
BEGIN SELECT RAISE(ABORT, 'group events are append-only'); END;
`;

export class SqliteRecordBackend implements RecordBackend {
  readonly #db: DatabaseSync;
  #depth = 0;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.#db.exec("BEGIN IMMEDIATE");
    this.#depth += 1;
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  insertSession(row: SessionRow): void {
    this.#db
      .prepare("INSERT INTO sessions (id, case_id, created_at, previous_session_id) VALUES (?, ?, ?, ?)")
      .run(row.id, row.caseId, row.createdAt, row.previousSessionId);
  }

  getSession(id: string): SessionRow | null {
    const r = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    return r ? toSession(r) : null;
  }

  listSessions(): SessionRow[] {
    return (this.#db.prepare("SELECT * FROM sessions ORDER BY created_at, id").all() as Record<string, string | null>[]).map(toSession);
  }

  insertEvent(row: EventRow): void {
    this.#db
      .prepare(
        `INSERT INTO events (id, session_id, seq, recorded_at, type, actor_kind, actor_party_id, channel, visibility, payload, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.sessionId, row.seq, row.recordedAt, row.type, row.actorKind, row.actorPartyId, row.channel, row.visibility, row.payloadJson, row.contentHash);
  }

  getEvent(id: string): EventRow | null {
    const r = this.#db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toEvent(r) : null;
  }

  listEvents(sessionId: string): EventRow[] {
    return (this.#db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as Record<string, unknown>[]).map(toEvent);
  }

  insertGroupEvent(row: GroupEventRow): void {
    this.#db
      .prepare("INSERT INTO group_events (id, group_id, seq, recorded_at, type, payload) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, row.groupId, row.seq, row.recordedAt, row.type, row.payloadJson);
  }

  listGroupEvents(): GroupEventRow[] {
    return (this.#db.prepare("SELECT * FROM group_events ORDER BY rowid").all() as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      groupId: r.group_id as string,
      seq: Number(r.seq),
      recordedAt: r.recorded_at as string,
      type: r.type as string,
      payloadJson: r.payload as string,
    }));
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}

function toSession(r: Record<string, string | null>): SessionRow {
  return { id: r.id!, caseId: r.case_id!, createdAt: r.created_at!, previousSessionId: r.previous_session_id ?? null };
}

function toEvent(r: Record<string, unknown>): EventRow {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    seq: Number(r.seq),
    recordedAt: r.recorded_at as string,
    type: r.type as string,
    actorKind: r.actor_kind as string,
    actorPartyId: (r.actor_party_id as string | null) ?? null,
    channel: (r.channel as string | null) ?? null,
    visibility: r.visibility as "public" | "private",
    payloadJson: r.payload as string,
    contentHash: r.content_hash as string,
  };
}
