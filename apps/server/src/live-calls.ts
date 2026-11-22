/**
 * Voice calls connected now (browser and phone), by negotiation session. When a deal goes to another
 * counterparty, the engine closes the other sessions and the server breaks into any live call
 * (docs/Kritva_Multiple_Counterparties.md, section 12). The caller's number is kept here only while
 * the call lasts, for the engine to save if they agree to be contacted later.
 */
import type { RealtimeCall } from "./realtime-voice.ts";

export class LiveCalls {
  readonly #calls = new Map<string, { call: RealtimeCall; contact: string | null }>();

  register(sessionId: string, call: RealtimeCall, contact: string | null = null): void {
    this.#calls.set(sessionId, { call, contact });
  }

  unregister(sessionId: string, call: RealtimeCall): void {
    if (this.#calls.get(sessionId)?.call === call) this.#calls.delete(sessionId);
  }

  /** Sessions with a call connected now. */
  sessions(): Set<string> {
    return new Set([...this.#calls].filter(([, c]) => !c.call.closed).map(([id]) => id));
  }

  contactFor(sessionId: string): string | null {
    return this.#calls.get(sessionId)?.contact ?? null;
  }

  breakIn(sessionId: string): void {
    const live = this.#calls.get(sessionId);
    if (live && !live.call.closed) void live.call.breakIn().catch(() => undefined);
  }
}
