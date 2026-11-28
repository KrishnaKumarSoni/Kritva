/**
 * The small synchronous SQL surface Kritva's stores use, so one store runs on either database:
 * - Node: a SQLite file through node:sqlite (local runs, tests and scripts);
 * - Cloudflare: a Durable Object's own SQLite storage (apps/worker), which is synchronous too.
 *
 * Stores take a path (opened here with node:sqlite) or a ready SqlDatabase. node:sqlite is loaded
 * only when a path is opened, so the Worker bundle never needs it.
 */
import type { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlStatement {
  run(...params: SqlValue[]): void;
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
}

export interface SqlDatabase {
  /** Runs statements without parameters, such as a schema. */
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Runs fn in one transaction: everything it wrote is kept, or nothing is if it throws. Nested calls join the outer one. */
  transaction<T>(fn: () => T): T;
  /** Closes a file database. A database the caller owns (a Durable Object's) stays open. */
  close(): void;
}

/** A SQLite file path for node:sqlite, or a database that is already open. */
export type SqlSource = string | SqlDatabase;

/** The database for a source: a path opens its own node:sqlite connection, as each store always had. */
export function openSql(source: SqlSource): SqlDatabase {
  return typeof source === "string" ? nodeSqlite(source) : source;
}

function nodeSqlite(path: string): SqlDatabase {
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!sqlite) throw new Error("node:sqlite is not available here; pass an open SqlDatabase instead of a path.");
  const db: DatabaseSync = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  let depth = 0;
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (...params) => void statement.run(...params),
        get: (...params) => statement.get(...params) as Record<string, unknown> | undefined,
        all: (...params) => statement.all(...params) as Record<string, unknown>[],
      };
    },
    transaction: (fn) => {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth += 1;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        depth -= 1;
      }
    },
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}
