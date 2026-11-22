/**
 * The offer board for a deal group (docs/Kritva_Multiple_Counterparties.md, section 8): each
 * counterparty's latest offer read from their own session, whether it is within the mandate's
 * limits, a score from the mandate's priorities, the gap to the principal's limit, and the best.
 *
 * Everything is from the principal's side: "better" means better for the principal, in either
 * direction. Private: the board is for the principal and operator only.
 */
import { applicableLimit, sameValue } from "../dealspace/check.ts";
import type { OfferTerm, PayloadOf } from "../record/events.ts";
import type { GroupState } from "../record/groups.ts";
import type { SessionContext } from "../record/rules.ts";
import type { MandateView } from "./mandate-view.ts";
import { clearedNow, publicDealTerms, type NegotiationState } from "./state.ts";

/** The reason recorded when a session closes because the deal went to another counterparty. */
export const DEAL_ELSEWHERE_REASON = "The principal agreed terms with another counterparty.";

/**
 * Where "can I keep your number?" stands after a session closed because the deal went elsewhere:
 * asked (no answer yet), asked_number (they said yes; Kritva asked which number), kept, declined, or
 * null when it was never asked.
 */
export function contactState(ctx: SessionContext): "asked" | "asked_number" | "kept" | "declined" | null {
  const closedAt = ctx.events.findLast((e) => e.type === "status_changed" && (e.payload as PayloadOf<"status_changed">).reason === DEAL_ELSEWHERE_REASON);
  if (!closedAt) return null;
  let state: "asked" | "asked_number" | "kept" | "declined" = "asked";
  for (const e of ctx.events) {
    if (e.seq <= closedAt.seq) continue;
    if (e.type === "follow_up_noted") {
      const keep = (e.payload as { keepContact?: boolean | null }).keepContact;
      if (keep === true) state = "kept";
      if (keep === false) state = "declined";
    }
    if (e.type === "message" && state === "asked" && (e.payload as PayloadOf<"message">).direction === "outbound" && /best number/i.test((e.payload as PayloadOf<"message">).text)) state = "asked_number";
  }
  return state;
}

export interface BoardOffer {
  offerId: string;
  /** The complete package: their terms over the principal's current terms. */
  terms: OfferTerm[];
  at: string;
  /** Their value on the negotiated term. */
  amount: number | null;
  /** true within limits, false outside them, null when the check needs clarification. */
  withinLimits: boolean | null;
  /** They accepted terms Kritva stated, rather than proposing their own. */
  accepted: boolean;
}

const FINISHED = new Set(["agreed", "no_agreement", "ended"]);

/** The counterparty's latest offer in this session, open or not. */
export function latestOffer(state: NegotiationState, ctx: SessionContext): BoardOffer | null {
  const n = state.view.negotiable;
  const amountIn = (terms: OfferTerm[]) => {
    const t = n ? terms.find((x) => x.termId === n.termId) : undefined;
    return t && "amount" in t.value ? (t.value.amount as number) : null;
  };
  let latest: BoardOffer | null = null;
  for (const e of ctx.events) {
    if (e.type === "offer_extracted") {
      const p = ctx.effective.get(e.id) as PayloadOf<"offer_extracted">;
      if (p.kind && p.kind !== "offer") continue;
      const check = state.checks.get(e.id);
      const terms = check?.checkedTerms ?? overlay(publicDealTerms(state), p.terms);
      const withinLimits = check && check.mandateRevision === state.mandateRevision ? (check.result === "needs_clarification" ? null : clearedNow(state, e.id, check.termsHash)) : null;
      latest = { offerId: e.id, terms, at: e.recordedAt, amount: amountIn(terms), withinLimits, accepted: false };
    } else if (e.type === "acceptance_recorded") {
      const p = e.payload as PayloadOf<"acceptance_recorded">;
      const offered = ctx.offerTerms(p.offerId);
      if (!offered) continue;
      latest = { offerId: p.offerId, terms: offered.terms, at: e.recordedAt, amount: amountIn(offered.terms), withinLimits: true, accepted: true };
    }
  }
  return latest;
}

/** The latest offer while it is live: the session is still open. */
export function liveOffer(state: NegotiationState, ctx: SessionContext): BoardOffer | null {
  return FINISHED.has(state.status) ? null : latestOffer(state, ctx);
}

/** One value per term from 0 to 1, weighted by the mandate's priorities. Outside-limit offers are not scored. */
export function scoreOffer(view: MandateView, terms: OfferTerm[]): { score: number; parts: Array<{ termId: string; value: number; weight: number }> } {
  const m = view.mandate;
  const mine = <T extends { partyId: string; status: string }>(list: T[]) => list.filter((r) => r.partyId === view.principalId && r.status === "stated");
  const ranked = mine(m.goals).filter((g) => g.priority !== null && g.termIds.length > 0);
  const maxPriority = Math.max(0, ...ranked.map((g) => g.priority!));
  const priorityWeight = (termId: string) => {
    const best = Math.min(...ranked.filter((g) => g.termIds.includes(termId)).map((g) => g.priority!));
    return Number.isFinite(best) ? 1 + (maxPriority - best + 1) : null;
  };
  const parts: Array<{ termId: string; value: number; weight: number }> = [];
  const n = view.negotiable;
  for (const t of terms) {
    let value: number | null = null;
    if (n && t.termId === n.termId && "amount" in t.value) {
      const v = t.value.amount as number;
      const span = n.direction === "up" ? n.opening - n.limit : n.limit - n.opening;
      const room = n.direction === "up" ? v - n.limit : n.limit - v;
      value = span <= 0 ? (room >= 0 ? 1 : 0) : clamp(room / span);
      parts.push({ termId: t.termId, value, weight: priorityWeight(t.termId) ?? 2 });
      continue;
    }
    const prefs = mine(m.preferences).filter((p) => p.termId === t.termId && p.value !== null && p.conditionIds.length === 0);
    const targets = mine(m.targets).filter((x) => x.termId === t.termId && x.value !== null && x.conditionIds.length === 0);
    for (const p of prefs) {
      const match = sameValue(p.value!, t.value);
      if (p.strength === "preferred") value = Math.min(value ?? 1, match ? 1 : 0.5);
      if (p.strength === "avoid") value = Math.min(value ?? 1, match ? 0 : 1);
    }
    for (const x of targets) value = Math.min(value ?? 1, sameValue(x.value!, t.value) ? 1 : 0.5);
    const weight = priorityWeight(t.termId) ?? (value === null ? 0 : 1);
    if (weight > 0) parts.push({ termId: t.termId, value: value ?? 1, weight });
  }
  const total = parts.reduce((s, p) => s + p.weight, 0);
  return { score: total === 0 ? 0 : parts.reduce((s, p) => s + p.value * p.weight, 0) / total, parts };
}

/** The gap to the principal's own limit on the negotiated term; positive is room in the principal's favour. */
export function gapToLimit(state: NegotiationState, terms: OfferTerm[]): number | null {
  const n = state.view.negotiable;
  const t = n ? terms.find((x) => x.termId === n.termId) : undefined;
  if (!n || !t || !("amount" in t.value)) return null;
  const limit = applicableLimit(state.space, n.termId, terms)?.amount ?? n.limit;
  return n.direction === "up" ? (t.value.amount as number) - limit : limit - (t.value.amount as number);
}

export type BoardStatus = "not_started" | "talking" | "waiting_for_you" | "reserved" | "paused" | "agreed" | "closed_elsewhere" | "ended";

export interface BoardRowInput {
  sessionId: string;
  state: NegotiationState;
  ctx: SessionContext;
  entry: { id: string; name: string } | null;
  via: string;
}

export interface BoardRow {
  sessionId: string;
  entryId: string | null;
  name: string | null;
  via: string;
  channel: "none" | "chat" | "browser_call" | "phone";
  /** A voice call is connected now. */
  live: boolean;
  status: BoardStatus;
  offer: BoardOffer | null;
  score: number | null;
  gap: number | null;
  flag: "outside_limits" | "unclear" | null;
  best: boolean;
  /** After the deal went elsewhere: whether they agreed to be contacted if it falls through. */
  contact: ReturnType<typeof contactState>;
  lastActivityAt: string;
}

export interface Board {
  rows: BoardRow[];
  bestSessionId: string | null;
  counters: { negotiationsRun: number; timeMs: number; dealsOutsideLimits: number };
}

export function projectBoard(inputs: BoardRowInput[], group: GroupState): Board {
  const rows: BoardRow[] = inputs.map(({ sessionId, state, ctx, entry, via }) => {
    const offer = latestOffer(state, ctx);
    const open = !FINISHED.has(state.status);
    const scored = offer && offer.withinLimits === true ? scoreOffer(state.view, offer.terms).score : null;
    return {
      sessionId,
      entryId: entry?.id ?? null,
      name: entry?.name ?? null,
      via,
      ...connection(ctx),
      status: statusOf(state, ctx, group, sessionId),
      offer,
      score: open ? scored : null,
      gap: offer ? gapToLimit(state, offer.terms) : null,
      flag: offer === null ? null : offer.withinLimits === false ? "outside_limits" : offer.withinLimits === null ? "unclear" : null,
      best: false,
      contact: contactState(ctx),
      lastActivityAt: ctx.events.at(-1)?.recordedAt ?? "",
    };
  });
  // The best live offer within limits; ties go to the earlier offer.
  const candidates = rows.filter((r) => r.score !== null && r.offer).sort((a, b) => b.score! - a.score! || a.offer!.at.localeCompare(b.offer!.at));
  const best = group.concluded ? rows.find((r) => r.sessionId === group.concluded!.sessionId) ?? null : candidates[0] ?? null;
  if (best) best.best = true;
  return {
    rows,
    bestSessionId: best?.sessionId ?? null,
    counters: {
      negotiationsRun: rows.length,
      timeMs: group.timeMs,
      dealsOutsideLimits: inputs.filter(({ state }) => state.outcome.kind === "agreement" && outsideLimits(state)).length,
    },
  };
}

/** An agreement whose terms break the mandate's hard limits without an approved exception. Zero by design. */
function outsideLimits(state: NegotiationState): boolean {
  const terms = state.outcome.terms ?? [];
  const n = state.view.negotiable;
  const t = n ? terms.find((x) => x.termId === n.termId) : undefined;
  if (!n || !t || !("amount" in t.value)) return false;
  const limit = applicableLimit(state.space, n.termId, terms)?.amount ?? n.limit;
  const crosses = n.direction === "up" ? (t.value.amount as number) < limit : (t.value.amount as number) > limit;
  const excepted = state.approvals.some((a) => a.decision === "approved" && a.purpose === "exception" && a.termsHash === state.outcome.termsHash);
  return crosses && !excepted;
}

function statusOf(state: NegotiationState, ctx: SessionContext, group: GroupState, sessionId: string): BoardStatus {
  if (state.status === "agreed") return "agreed";
  if (state.status === "no_agreement" || state.status === "ended") {
    const last = ctx.events.findLast((e) => e.type === "status_changed");
    return (last?.payload as PayloadOf<"status_changed"> | undefined)?.reason === DEAL_ELSEWHERE_REASON ? "closed_elsewhere" : "ended";
  }
  if (group.reservation?.sessionId === sessionId) return "reserved";
  if (state.status === "paused") return "paused";
  if (state.status === "awaiting_approval") return "waiting_for_you";
  const spoke = ctx.events.some((e) => e.type === "message" && (e.payload as PayloadOf<"message">).direction === "inbound");
  return spoke ? "talking" : "not_started";
}

function connection(ctx: SessionContext): { channel: BoardRow["channel"]; live: boolean } {
  const call = ctx.events.findLast((e) => e.type === "voice_connection");
  const p = call?.payload as PayloadOf<"voice_connection"> | undefined;
  const live = p?.status === "connected";
  const phone = ctx.events.some((e) => e.type === "voice_connection" && (e.payload as PayloadOf<"voice_connection">).transport === "phone");
  const lastInbound = ctx.events.findLast((e) => e.type === "message" && (e.payload as PayloadOf<"message">).direction === "inbound");
  if (phone) return { channel: "phone", live };
  if (call || lastInbound?.channel === "voice") return { channel: "browser_call", live };
  return { channel: lastInbound ? "chat" : "none", live: false };
}

function overlay(base: OfferTerm[], theirs: OfferTerm[]): OfferTerm[] {
  const map = new Map(base.map((t) => [t.termId, t]));
  for (const t of theirs) map.set(t.termId, t);
  return [...map.values()];
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
