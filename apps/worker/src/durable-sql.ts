/**
 * Kritva's SqlDatabase (packages/core/src/record/sql.ts) over a Durable Object's own SQLite storage.
 * Like node:sqlite it is synchronous, so the stores run unchanged. Differences handled here:
 * - transactions go through storage.transactionSync (exec() refuses BEGIN/COMMIT);
 * - PRAGMA settings are the platform's (writes are durable before a response leaves), so none are sent.
 */
import type { DurableObjectStorage } from "cloudflare:workers";
import type { SqlDatabase } from "@kritva/core";

export function durableSql(storage: DurableObjectStorage): SqlDatabase {
  const sql = storage.sql;
  let depth = 0;
  return {
    exec: (query) => void sql.exec(query).toArray(),
    prepare: (query) => ({
      run: (...params) => void sql.exec(query, ...params).toArray(),
      get: (...params) => sql.exec(query, ...params).toArray()[0],
      all: (...params) => sql.exec(query, ...params).toArray(),
    }),
    transaction: (fn) => {
      if (depth > 0) return fn();
      depth += 1;
      try {
        return storage.transactionSync(fn);
      } finally {
        depth -= 1;
      }
    },
    close: () => undefined,
  };
}
