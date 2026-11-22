/**
 * Deal groups: one saved mandate, one deal, several counterparties (docs/Kritva_Multiple_Counterparties.md).
 *
 * A group links the sessions that compete for one deal. It holds only what belongs to the group:
 * who joined, and when the deal was reserved, released and concluded. Offers stay in each session's
 * own record. The group record is append-only and lives on the record's own connection, so a deal
 * can be concluded in the same transaction as the agreement that concludes it.
 *
 * Rules: at most `maxOpen` open sessions per group; at most one active reservation; a concluded
 * group takes nothing more except the principal's time. Nothing here reads conversation content.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConfirmedMandate } from "../schema/records.ts";
import { GroupConflict, type GroupEventRow, type NegotiationRecord } from "./store.ts";

const Id = z.string().min(1).max(128);

export const GROUP_PAYLOADS = {
  group_opened: z.strictObject({ mandateId: Id, caseId: Id, maxOpen: z.number().int().min(1) }),
  counterparty_joined: z.strictObject({
    sessionId: Id,
    /** The mandate's counterparty-list entry, or null for someone who came in without one. */
    entryId: Id.nullable(),
    via: z.enum(["link", "listing", "phone", "console"]),
    /** A reset: the session this one replaces (it no longer counts). */
    replaces: Id.nullable(),
  }),
  deal_reserved: z.strictObject({ sessionId: Id, offerId: Id, termsHash: z.string().length(64), approvalId: Id.nullable() }),
  deal_released: z.strictObject({ sessionId: Id, reason: z.string().trim().min(1).max(500) }),
  deal_concluded: z.strictObject({ sessionId: Id, offerId: Id }),
  principal_time: z.strictObject({ action: z.string().min(1).max(40), sessionId: Id.nullable(), ms: z.number().int().min(0).max(3_600_000) }),
  /** The principal reset the mandate: this group's negotiations are set aside and a fresh group follows. */
  group_reset: z.strictObject({ nextGroupId: Id }),
} as const;
export type GroupEventType = keyof typeof GROUP_PAYLOADS;
export type GroupPayload<T extends GroupEventType> = z.infer<(typeof GROUP_PAYLOADS)[T]>;
export type JoinVia = GroupPayload<"counterparty_joined">["via"];

export interface GroupMember {
  sessionId: string;
  entryId: string | null;
  via: JoinVia;
  joinedAt: string;
}

export interface GroupState {
  groupId: string;
  mandateId: string;
  caseId: string;
  openedAt: string;
  maxOpen: number;
  /** Members in join order, without sessions a reset replaced. */
  members: GroupMember[];
  reservation: { sessionId: string; offerId: string; termsHash: string } | null;
  concluded: { sessionId: string; offerId: string } | null;
  /** The principal's measured decision time on this group, in milliseconds. */
  timeMs: number;
  /** Set aside by a reset of the mandate: its negotiations are history, not shown with the deal. */
  reset: boolean;
}

export type GroupStartResult =
  | { ok: true; sessionId: string; groupId: string }
  | { ok: false; code: "full" | "concluded" | "start_failed"; message: string };

const FINISHED = new Set(["agreed", "no_agreement", "ended"]);

export class DealGroups {
  readonly #record: NegotiationRecord;
  readonly #maxOpen: number;
  readonly #now: () => Date;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(record: NegotiationRecord, options: { maxOpen: number; now?: () => Date }) {
    this.#record = record;
    this.#maxOpen = Math.max(1, Math.floor(options.maxOpen));
    this.#now = options.now ?? (() => new Date());
  }

  get maxOpen(): number {
    return this.#maxOpen;
  }

  /** Every group, oldest first, projected from the record. */
  groups(): GroupState[] {
    const byId = new Map<string, GroupState>();
    const replaced = new Set<string>();
    for (const row of this.#record.groupBackend().listGroupEvents()) {
      const payload = JSON.parse(row.payloadJson);
      if (row.type === "group_opened") {
        byId.set(row.groupId, { groupId: row.groupId, mandateId: payload.mandateId, caseId: payload.caseId, openedAt: row.recordedAt, maxOpen: payload.maxOpen, members: [], reservation: null, concluded: null, timeMs: 0, reset: false });
        continue;
      }
      const g = byId.get(row.groupId);
      if (!g) continue;
      switch (row.type) {
        case "counterparty_joined":
          if (payload.replaces) replaced.add(payload.replaces);
          g.members.push({ sessionId: payload.sessionId, entryId: payload.entryId, via: payload.via, joinedAt: row.recordedAt });
          break;
        case "deal_reserved":
          g.reservation = { sessionId: payload.sessionId, offerId: payload.offerId, termsHash: payload.termsHash };
          break;
        case "deal_released":
          g.reservation = null;
          break;
        case "deal_concluded":
          g.concluded = { sessionId: payload.sessionId, offerId: payload.offerId };
          g.reservation = null;
          break;
        case "principal_time":
          g.timeMs += payload.ms;
          break;
        case "group_reset":
          g.reset = true;
          break;
      }
    }
    const all = [...byId.values()];
    for (const g of all) g.members = g.members.filter((m) => !replaced.has(m.sessionId));
    return all;
  }

  /** The newest group for a saved mandate (concluded or not), if any. */
  latestFor(mandateId: string): GroupState | null {
    return this.groups().filter((g) => g.mandateId === mandateId).at(-1) ?? null;
  }

  /** The group a session belongs to. */
  groupOf(sessionId: string): GroupState | null {
    return this.groups().find((g) => g.members.some((m) => m.sessionId === sessionId)) ?? null;
  }

  /**
   * Open sessions that hold a place under the cap. A walk-in (no list entry) whose voice call has
   * ended cannot be resumed (calling again starts a new negotiation), so it no longer holds one:
   * test calls never fill the cap and turn the next caller away.
   */
  async heldPlaces(group: GroupState): Promise<string[]> {
    const held: string[] = [];
    for (const m of group.members) {
      const ctx = await this.#record.context(m.sessionId);
      if (FINISHED.has(ctx.status)) continue;
      const call = ctx.events.findLast((e) => e.type === "voice_connection");
      if (m.entryId === null && (call?.payload as { status?: string } | undefined)?.status === "ended") continue;
      held.push(m.sessionId);
    }
    return held;
  }

  async openSessions(group: GroupState): Promise<string[]> {
    const open: string[] = [];
    for (const m of group.members) {
      const ctx = await this.#record.context(m.sessionId);
      if (!FINISHED.has(ctx.status)) open.push(m.sessionId);
    }
    return open;
  }

  /**
   * Starts a session under a saved mandate and joins it to that mandate's group, opening the group
   * if needed. Refused when the group is full or its deal has concluded (reopening the mandate
   * starts a new group: see reopen). Starts for one mandate run one at a time.
   */
  start(input: { mandate: ConfirmedMandate; mandateSource: { mandateId: string; revision: number }; entryId: string | null; via: JoinVia; previousSessionId?: string | null }): Promise<GroupStartResult> {
    return this.#serialize(input.mandateSource.mandateId, async () => {
      let group = this.latestFor(input.mandateSource.mandateId);
      if (group?.concluded) return { ok: false, code: "concluded", message: "This deal has already been agreed with someone else." };
      const replaces = input.previousSessionId && group?.members.some((m) => m.sessionId === input.previousSessionId) ? input.previousSessionId : null;
      if (group) {
        const open = (await this.heldPlaces(group)).filter((id) => id !== replaces);
        if (open.length >= this.#maxOpen) return { ok: false, code: "full", message: `This deal already has ${this.#maxOpen} open negotiations.` };
      }
      const started = await this.#record.startSession({ mandate: input.mandate, previousSessionId: input.previousSessionId ?? null, mandateSource: input.mandateSource });
      if (!started.ok) return { ok: false, code: "start_failed", message: started.error.message };
      this.#record.groupBackend().transaction(() => {
        if (!group) {
          const groupId = `grp_${randomUUID()}`;
          this.#write(groupId, "group_opened", { mandateId: input.mandateSource.mandateId, caseId: input.mandate.caseId, maxOpen: this.#maxOpen });
          group = this.latestFor(input.mandateSource.mandateId);
        }
        this.#write(group!.groupId, "counterparty_joined", { sessionId: started.session.id, entryId: input.entryId, via: input.via, replaces });
      });
      return { ok: true, sessionId: started.session.id, groupId: group!.groupId };
    });
  }

  /** After the principal reopens a mandate whose deal concluded, the next start opens a fresh group. */
  reopen(mandateId: string, caseId: string): void {
    const latest = this.latestFor(mandateId);
    if (!latest?.concluded) return;
    this.#write(`grp_${randomUUID()}`, "group_opened", { mandateId, caseId, maxOpen: this.#maxOpen });
  }

  /**
   * Starts the mandate over: every group so far is set aside and a fresh, empty group opens, so the
   * counterparty list can be reached again. Returns the sessions still open in the old group, for
   * the caller to end. Nothing is deleted from the record.
   */
  reset(mandateId: string, caseId: string): Promise<string[]> {
    return this.#serialize(mandateId, async () => {
      const latest = this.latestFor(mandateId);
      const open = latest ? await this.openSessions(latest) : [];
      const nextGroupId = `grp_${randomUUID()}`;
      this.#record.groupBackend().transaction(() => {
        for (const g of this.groups().filter((x) => x.mandateId === mandateId && !x.reset)) this.#write(g.groupId, "group_reset", { nextGroupId });
        this.#write(nextGroupId, "group_opened", { mandateId, caseId, maxOpen: this.#maxOpen });
      });
      return open;
    });
  }

  /** Holds the deal for one session's accepted terms. Only one session may hold it at a time. */
  reserve(sessionId: string, r: { offerId: string; termsHash: string; approvalId: string | null }): { ok: true } | { ok: false; code: "reserved_elsewhere" | "concluded"; holderSessionId: string } {
    return this.#record.groupBackend().transaction(() => {
      const g = this.groupOf(sessionId);
      if (!g) return { ok: true as const };
      if (g.concluded) return { ok: false as const, code: "concluded" as const, holderSessionId: g.concluded.sessionId };
      if (g.reservation && g.reservation.sessionId !== sessionId) return { ok: false as const, code: "reserved_elsewhere" as const, holderSessionId: g.reservation.sessionId };
      if (g.reservation?.termsHash === r.termsHash) return { ok: true as const };
      this.#write(g.groupId, "deal_reserved", { sessionId, offerId: r.offerId, termsHash: r.termsHash, approvalId: r.approvalId });
      return { ok: true as const };
    });
  }

  /** Lets go of a reservation this session holds. Nobody else is told: they never knew. */
  release(sessionId: string, reason: string): void {
    const g = this.groupOf(sessionId);
    if (!g || g.reservation?.sessionId !== sessionId) return;
    this.#write(g.groupId, "deal_released", { sessionId, reason: reason.slice(0, 500) });
  }

  /**
   * The group write that concludes the deal, for NegotiationRecord.append's `alsoWrite`, so it
   * commits with the agreement or not at all. A mandate that agrees without approval has no
   * reservation yet: it reserves and concludes together if nobody else holds the deal.
   */
  concludeWrite(sessionId: string, r: { offerId: string; termsHash: string }): () => void {
    return () => {
      const g = this.groupOf(sessionId);
      if (!g) return;
      if (g.concluded) throw new GroupConflict("This deal has already been agreed with someone else.");
      if (g.reservation && g.reservation.sessionId !== sessionId) throw new GroupConflict("This deal is held for another counterparty.");
      if (!g.reservation || g.reservation.termsHash !== r.termsHash) this.#write(g.groupId, "deal_reserved", { sessionId, offerId: r.offerId, termsHash: r.termsHash, approvalId: null });
      this.#write(g.groupId, "deal_concluded", { sessionId, offerId: r.offerId });
    };
  }

  /** Records how long one principal action took on screen (the console measures it). */
  recordTime(groupId: string, t: { action: string; sessionId: string | null; ms: number }): void {
    const ms = Math.max(0, Math.min(3_600_000, Math.round(t.ms)));
    this.#write(groupId, "principal_time", { action: t.action.slice(0, 40), sessionId: t.sessionId, ms });
  }

  #write<T extends GroupEventType>(groupId: string, type: T, payload: GroupPayload<T>): void {
    const parsed = GROUP_PAYLOADS[type].parse(payload);
    const backend = this.#record.groupBackend();
    backend.transaction(() => {
      const seq = backend.listGroupEvents().filter((e) => e.groupId === groupId).length + 1;
      const row: GroupEventRow = { id: `gev_${randomUUID()}`, groupId, seq, recordedAt: this.#now().toISOString(), type, payloadJson: JSON.stringify(parsed) };
      backend.insertGroupEvent(row);
    });
  }

  #serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.#locks.set(key, next.catch(() => undefined));
    return next;
  }
}
