/**
 * HTTP API for the thin end-to-end slice.
 *
 * The route decides who is acting, never the request body:
 * - /api/buyer/...    counterparty actions and the counterparty's view (public events only)
 * - /api/operator/... the principal's console: full record, approvals, new sessions
 * The buyer chat and the scenario script call the same engine path.
 */
import { Hono } from "hono";
import {
  formatValue,
  orderTerms,
  type MandateView,
  type NegotiationEngine,
  type NegotiationRecord,
  type NegotiationState,
  type OfferTerm,
  type RecordedEvent,
  type ValidConfirmedMandate,
} from "@kritva/core";

export interface MandateEntry {
  id: string;
  title: string;
  mandate: ValidConfirmedMandate;
}

export interface AppDeps {
  record: NegotiationRecord;
  engine: NegotiationEngine;
  mandates: MandateEntry[];
  locale: string;
}

export function createApp(deps: AppDeps): Hono {
  const { record, engine, mandates, locale } = deps;
  const app = new Hono();

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "internal_error", message: "Something went wrong. Nothing further was recorded." }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  // ---------- Operator (principal) ----------

  app.get("/api/operator/mandates", (c) =>
    c.json(
      mandates.map((m) => ({
        id: m.id,
        title: m.title,
        caseId: m.mandate.caseId,
        confirmedAt: m.mandate.approval.confirmedAt,
      })),
    ),
  );

  app.get("/api/operator/sessions", async (c) => c.json(await record.listSessions()));

  /** Starts a session. With previousSessionId it is a reset: a new session, the old one kept. */
  app.post("/api/operator/sessions", async (c) => {
    const body = await c.req.json<{ mandateId?: string; previousSessionId?: string | null }>().catch(() => ({}) as Record<string, never>);
    const entry = mandates.find((m) => m.id === body.mandateId) ?? mandates[0];
    if (!entry) return c.json({ error: "no_mandate", message: "No confirmed mandate is available." }, 400);
    const started = await record.startSession({ mandate: entry.mandate, previousSessionId: body.previousSessionId ?? null });
    if (!started.ok) return c.json({ error: started.error.code, message: started.error.message }, 400);
    return c.json({ session: started.session, state: operatorState(await engine.state(started.session.id), locale) }, 201);
  });

  app.get("/api/operator/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const session = await record.getSession(id);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const [state, events] = await Promise.all([engine.state(id), record.read(id, { viewer: "operator" })]);
    return c.json({ session, state: operatorState(state, locale), events: events.map((e) => describeEvent(e, state.view, locale)) });
  });

  app.post("/api/operator/sessions/:id/approvals/:requestId", async (c) => {
    const body = await c.req.json<{ decision?: string; note?: string }>().catch(() => ({}) as Record<string, never>);
    if (body.decision !== "approved" && body.decision !== "rejected") return c.json({ error: "invalid_decision" }, 400);
    const result = await engine.respondToApproval({ sessionId: c.req.param("id"), requestId: c.req.param("requestId"), decision: body.decision, note: body.note ?? null });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "not_pending" ? 409 : 400);
    return c.json({ reply: result.reply, state: operatorState(result.state, locale) });
  });

  // ---------- Buyer (counterparty) ----------

  app.get("/api/buyer/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await record.getSession(id))) return c.json({ error: "session_not_found" }, 404);
    const [state, events] = await Promise.all([engine.state(id), record.read(id, { viewer: "counterparty" })]);
    return c.json({
      // Public listing content only: the principal's public package and public facts.
      listing: { terms: termsView(state.view, state.view.defaultPackage, locale) ?? [], facts: state.view.publicFacts },
      messages: buyerMessages(events),
      outcome: buyerOutcome(state, locale),
    });
  });

  app.post("/api/buyer/sessions/:id/messages", async (c) => {
    const body = await c.req.json<{ text?: string; clientMessageId?: string }>().catch(() => ({}) as Record<string, never>);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length === 0 || text.length > 2_000) return c.json({ error: "invalid_message", message: "Messages must be 1 to 2,000 characters." }, 400);
    const result = await engine.handleCounterpartyMessage({
      sessionId: c.req.param("id"),
      text,
      channel: "text",
      messageId: typeof body.clientMessageId === "string" && /^[\w-]{8,100}$/.test(body.clientMessageId) ? `msg_${body.clientMessageId}` : undefined,
    });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "session_not_found" ? 404 : 400);
    return c.json({
      reply: result.reply ? { messageId: result.reply.messageId, text: result.reply.text } : null,
      outcome: buyerOutcome(result.state, locale),
      timings: result.timings,
    });
  });

  /** The buyer's chat reports that a reply was displayed. Only then is its offer communicated. */
  app.post("/api/buyer/sessions/:id/deliveries", async (c) => {
    const body = await c.req.json<{ messageId?: string }>().catch(() => ({}) as Record<string, never>);
    if (typeof body.messageId !== "string") return c.json({ error: "invalid_delivery" }, 400);
    const result = await engine.reportDelivery({ sessionId: c.req.param("id"), messageId: body.messageId, channel: "text", status: "delivered" });
    if ("ok" in result && result.ok === false) return c.json({ error: result.code, message: result.message }, 400);
    return c.json({ ok: true });
  });

  return app;
}

// ---------- Views ----------

function buyerMessages(events: RecordedEvent[]) {
  return events
    .filter((e) => e.type === "message")
    .map((e) => {
      const p = e.payload as { direction: "inbound" | "outbound"; text: string };
      return { id: e.id, seq: e.seq, from: p.direction === "inbound" ? "buyer" : "agent", text: p.text, at: e.recordedAt, channel: e.channel };
    });
}

function termsView(view: MandateView, terms: OfferTerm[] | null, locale: string) {
  if (!terms) return null;
  return orderTerms(view, terms).map((t) => ({ termId: t.termId, name: view.terms.get(t.termId)?.name ?? t.termId, value: formatValue(t.value, locale) }));
}

/** What the buyer may see about the outcome: the kind and the stated terms. Nothing internal. */
function buyerOutcome(state: NegotiationState, locale: string) {
  return { kind: state.outcome.kind, terms: termsView(state.view, state.outcome.terms, locale) };
}

/** The principal's console view: includes private limits and authority, for the operator only. */
function operatorState(state: NegotiationState, locale: string) {
  const n = state.view.negotiable;
  const money = (amount: number | null) => (amount === null || !n ? null : formatValue(n.valueType === "money" ? { type: "money", amount, currency: n.currency } : { type: "quantity", amount, unit: n.unit }, locale));
  return {
    status: state.status,
    mandateRevision: state.mandateRevision,
    outcome: { ...state.outcome, terms: termsView(state.view, state.outcome.terms, locale) },
    pendingApproval: state.pendingApproval
      ? { requestId: state.pendingApproval.requestId, terms: termsView(state.view, state.outcome.terms, locale) }
      : null,
    negotiable: n
      ? { name: n.name, opening: money(n.opening), limit: money(n.limit), limitKind: n.direction === "up" ? "minimum" : "maximum", currentAsk: money(state.currentAsk), canConcede: n.canConcede }
      : null,
    acceptRequiresApproval: state.view.acceptRequiresApproval,
    counterpartyOffers: state.counterpartyAmounts.map((a) => money(a)),
  };
}

/** One event as the console shows it: a short title, a one-line summary, and the raw payload. */
function describeEvent(e: RecordedEvent, view: MandateView, locale: string) {
  const p = e.payload as Record<string, unknown>;
  const terms = (t: unknown) => termsView(view, t as OfferTerm[], locale)?.map((x) => `${x.name}: ${x.value}`).join(" · ") ?? "";
  let title = e.type.replace(/_/g, " ");
  let summary = "";
  switch (e.type) {
    case "session_started":
      title = "Session started";
      summary = `Confirmed mandate, revision ${p.mandateRevision}${p.previousSessionId ? " (reset)" : ""}`;
      break;
    case "message":
      title = p.direction === "inbound" ? "Buyer message" : "Agent reply";
      summary = String(p.text);
      break;
    case "offer_extracted":
      title = "Offer extracted";
      summary = terms(p.terms);
      break;
    case "offer_proposed":
      title = p.basis === "final_terms" ? "Final terms proposed" : "Counteroffer proposed";
      summary = terms(p.terms);
      break;
    case "decision":
      title = `Decision: ${String(p.kind).replace(/_/g, " ")}`;
      summary = String(p.reason);
      break;
    case "reply_blocked":
      title = "Reply blocked";
      summary = (p.violations as Array<{ detail: string }>).map((v) => v.detail).join(" ");
      break;
    case "delivery_reported":
      title = `Delivery ${p.status}`;
      summary = "";
      break;
    case "acceptance_recorded":
      title = "Buyer accepted stated terms";
      break;
    case "approval_requested":
      title = "Approval requested";
      break;
    case "approval_responded":
      title = p.decision === "approved" ? "Seller approved" : "Seller rejected";
      break;
    case "agreement_recorded":
      title = "Agreement recorded";
      summary = terms(p.terms);
      break;
    case "status_changed":
      title = `Status: ${String(p.to).replace(/_/g, " ")}`;
      summary = String(p.reason);
      break;
    case "correction":
      title = "Correction";
      summary = String(p.reason);
      break;
  }
  return {
    id: e.id,
    seq: e.seq,
    at: e.recordedAt,
    type: e.type,
    actor: e.actor.kind,
    channel: e.channel,
    visibility: e.visibility,
    title,
    summary,
    payload: e.type === "session_started" ? { mandateRevision: p.mandateRevision, previousSessionId: p.previousSessionId } : p,
  };
}
