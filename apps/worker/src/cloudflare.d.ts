/**
 * The few Cloudflare runtime types this Worker uses, declared here instead of @cloudflare/workers-types,
 * whose global Request/Response types clash with Node's in the server code this package bundles.
 */
declare module "cloudflare:workers" {
  export interface SqlStorageCursor {
    toArray(): Record<string, unknown>[];
  }
  export interface DurableObjectStorage {
    sql: { exec(query: string, ...bindings: unknown[]): SqlStorageCursor };
    transactionSync<T>(fn: () => T): T;
  }
  export interface DurableObjectState {
    storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  }
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

/** A Durable Object namespace binding (only what index.ts uses). */
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown, options?: { locationHint?: string }): { fetch(request: Request): Promise<Response> };
}

/** An R2 bucket binding (only what recordings use). */
interface R2Bucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** The static assets binding. */
interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}
