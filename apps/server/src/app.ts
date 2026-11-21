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
  numericValue,
  projectCounterparty,
  projectCommitments,
  noAgreementSummary,
  type CommitmentsModel,
  type SessionContext,
  type CounterpartyModel,
  type DraftView,
  type MandateRevisions,
  type Value,
  type ConditionRef,
  type MandateView,
  type RuleRef,
  type TermKind,
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
  description: string | null;
  mandate: ValidConfirmedMandate;
}

export interface AppDeps {
  record: NegotiationRecord;
  engine: NegotiationEngine;
  revisions: MandateRevisions;
  mandates: MandateEntry[];
  locale: string;
}

export function createApp(deps: AppDeps): Hono {
  const { record, engine, mandates, locale, revisions } = deps;
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
        description: m.description,
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
    const mandateId = mandates.find((m) => JSON.stringify(m.mandate) === JSON.stringify(state.view.mandate))?.id ?? null;
    const ctx = await record.context(id);
    return c.json({
      session,
      mandateId,
      state: operatorState(state, locale),
      dealSpace: dealSpaceView(state, locale),
      principal: principalView(state, locale),
      counterparty: counterpartyView(projectCounterparty(ctx, state.view.negotiable?.termId ?? null), state, locale),
      commitments: commitmentsView(ctx, state, locale, engine.guidance.id),
      drafts: (await revisions.drafts(id)).map((d) => draftView(d, locale)),
      events: events.map((e) => describeEvent(e, state.view, locale)),
    });
  });

  app.post("/api/operator/sessions/:id/approvals/:requestId", async (c) => {
    const body = await c.req.json<{ decision?: string; note?: string }>().catch(() => ({}) as Record<string, never>);
    if (body.decision !== "approved" && body.decision !== "rejected") return c.json({ error: "invalid_decision" }, 400);
    const result = await engine.respondToApproval({ sessionId: c.req.param("id"), requestId: c.req.param("requestId"), decision: body.decision, note: body.note ?? null });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "not_pending" ? 409 : 400);
    return c.json({ reply: result.reply, state: operatorState(result.state, locale) });
  });

  /** End without agreement. Records who stopped and why; an agreement already recorded cannot be ended. */
  app.post("/api/operator/sessions/:id/end", async (c) => {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as Record<string, never>);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;
    const result = await engine.endNegotiation({ sessionId: c.req.param("id"), reason });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, result.code === "not_pending" ? 409 : 400);
    return c.json({ reply: result.reply, state: operatorState(result.state, locale) });
  });

  /** Pause or resume. While paused, no negotiation content reaches the counterparty. */
  app.post("/api/operator/sessions/:id/pause", async (c) => {
    const body = await c.req.json<{ paused?: boolean }>().catch(() => ({}) as Record<string, never>);
    const result = await engine.setPaused({ sessionId: c.req.param("id"), paused: body.paused === true });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, 409);
    return c.json({ state: operatorState(result.state, locale) });
  });

  app.get("/api/operator/sessions/:id/instructions", async (c) => c.json({ instructions: await revisions.currentInstructions(c.req.param("id")) }));

  /** Maps changed instructions into a draft. The draft has no authority until confirmed. */
  app.post("/api/operator/sessions/:id/drafts", async (c) => {
    const body = await c.req.json<{ instructions?: string }>().catch(() => ({}) as Record<string, never>);
    const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
    if (instructions.length === 0 || instructions.length > 5_000) return c.json({ error: "invalid_instructions", message: "Write your instructions (up to 5,000 characters)." }, 400);
    const result = await revisions.propose({ sessionId: c.req.param("id"), instructions });
    if (!result.ok) return c.json({ error: result.error.code, message: "The instructions could not be turned into a draft. Your current mandate is unchanged." }, 422);
    return c.json({ draft: draftView(result.draft, locale) }, 201);
  });

  /** Only this principal control confirms a draft. */
  app.post("/api/operator/sessions/:id/drafts/:draftId/confirm", async (c) => {
    const body = await c.req.json<{ acknowledgedIssueIds?: string[] }>().catch(() => ({}) as Record<string, never>);
    const result = await revisions.confirm({ sessionId: c.req.param("id"), draftId: c.req.param("draftId"), acknowledgedIssueIds: Array.isArray(body.acknowledgedIssueIds) ? body.acknowledgedIssueIds : [] });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, 409);
    return c.json({ state: operatorState(result.state, locale) });
  });

  app.post("/api/operator/sessions/:id/drafts/:draftId/reject", async (c) => {
    const result = await revisions.reject({ sessionId: c.req.param("id"), draftId: c.req.param("draftId") });
    if (!result.ok) return c.json({ error: result.code, message: result.message }, 409);
    return c.json({ ok: true });
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
      outcome: buyerOutcome(state, await record.context(id), locale),
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
      outcome: buyerOutcome(result.state, await record.context(c.req.param("id")), locale),
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

const KIND_LABEL: Record<TermKind, string> = {
  range: "Negotiable range",
  options: "Options",
  fixed: "Fixed",
  restricted: "Restricted",
  stated: "Stated by seller",
  linked: "Condition detail",
  descriptive: "Description",
  unresolved: "Unresolved",
};

/** Operator-only view of the deal space: term status, the rules behind it, and the latest buyer check. */
function dealSpaceView(state: NegotiationState, locale: string) {
  const space = state.space;
  const nameOf = (id: string | null) => (id ? (space.terms.find((t) => t.termId === id)?.name ?? id) : "");
  const conditionText = (c: ConditionRef) =>
    c.checkable && c.value ? `${nameOf(c.termId)} ${OPERATOR_TEXT[c.operator!]} ${formatValue(c.value, locale)}` : `${c.description} (cannot be checked automatically)`;
  const ruleText = (r: RuleRef) => {
    const value = formatValue(r.value, locale);
    const base =
      r.kind === "minimum" ? `Minimum ${value}` :
      r.kind === "maximum" ? `Maximum ${value}` :
      r.kind === "must_equal" ? `Only ${value}` :
      r.kind === "must_not_equal" ? `Not ${value}` :
      r.kind === "allowed_value" ? `Allowed: ${value}` :
      `${value}`;
    return r.conditions.length > 0 ? `${base}, only if ${r.conditions.map(conditionText).join(" and ")}` : base;
  };
  const last = state.lastCounterpartyCheck;
  return {
    terms: space.terms.map((t) => ({
      termId: t.termId,
      name: t.name,
      kind: t.kind,
      kindLabel: KIND_LABEL[t.kind],
      value: t.principalValue ? formatValue(t.principalValue.value, locale) : null,
      valueIsPrivate: t.principalValue?.disclosure === "private",
      rules: t.rules.map((r) => ({ id: r.id, text: ruleText(r), private: r.disclosure === "private", conditional: r.conditions.length > 0 })),
      inconsistent: t.inconsistent,
      openIssues: t.issueIds.length,
    })),
    facts: space.facts.map((f) => ({ id: f.id, statement: f.statement, private: f.disclosure === "private" })),
    requested: state.requestedTerms.map((r) => ({ id: r.id, name: r.name, value: r.value ? formatValue(r.value, locale) : null })),
    lastBuyerCheck: last
      ? {
          result: last.result,
          terms: last.checkedTerms.map((t) => `${nameOf(t.termId)}: ${formatValue(t.value, locale)}`),
          findings: last.findings.filter((f) => f.status !== "fits").map((f) => ({ term: f.termName, status: f.status, detail: f.detail })),
        }
      : null,
  };
}

/** One mandate rule in words, for the operator. */
function ruleText(state: NegotiationState, ruleId: string, locale: string): string {
  for (const t of state.space.terms) {
    const r = t.rules.find((x) => x.id === ruleId);
    if (!r) continue;
    const value = formatValue(r.value, locale);
    const label = r.kind === "minimum" ? `Minimum ${value}` : r.kind === "maximum" ? `Maximum ${value}` : r.kind === "must_equal" ? `Only ${value}` : r.kind === "must_not_equal" ? `Not ${value}` : `${value}`;
    return `${t.name}: ${label}`;
  }
  return ruleId;
}

const MODE_LABEL: Record<string, string> = {
  autonomous: "Kritva may do this",
  requires_approval: "Needs your approval",
  prohibited: "Not allowed",
  unresolved: "Unresolved: clarify first",
};

/** The active mandate as the principal set it: goals, targets, preferences, alternatives, limits, permissions. */
function principalView(state: NegotiationState, locale: string) {
  const m = state.view.mandate;
  const principalId = state.view.principalId;
  const nameOf = (id: string) => m.terms.find((t) => t.id === id)?.name ?? id;
  const val = (v: Value | null) => (v ? formatValue(v, locale) : "unknown");
  const mine = <T extends { partyId: string }>(xs: T[]) => xs.filter((x) => x.partyId === principalId);
  const authority = state.view.authority;
  return {
    revision: state.mandateRevision,
    goals: mine(m.goals).map((g) => ({ id: g.id, kind: g.kind, text: g.description, priority: g.priority, terms: g.termIds.map(nameOf), private: g.disclosure === "private" })),
    targets: mine(m.targets).map((t) => ({ id: t.id, text: `${nameOf(t.termId)}: ${val(t.value)}`, private: t.disclosure === "private" })),
    preferences: mine(m.preferences).map((p) => ({ id: p.id, text: `${nameOf(p.termId)}: ${val(p.value)} (${p.strength})`, private: p.disclosure === "private" })),
    alternatives: mine(m.alternatives).map((a) => ({ id: a.id, text: a.description, value: a.value ? val(a.value) : null, private: a.disclosure === "private" })),
    limits: mine(m.limits).map((l) => ({
      id: l.id,
      text: ruleText(state, l.id, locale),
      conditional: l.conditionIds.length > 0,
      exception: authority.exceptionFor(l.id) === "with_approval" ? "Exception possible with your approval" : l.exception === "not_allowed" ? "No exceptions" : "No exception path given",
    })),
    permissions: [
      ...[...new Set(m.positions.filter((p) => p.partyId === principalId).map((p) => p.termId))].map((termId) => ({ action: `Change ${nameOf(termId)}`, mode: MODE_LABEL[authority.propose(termId)] })),
      { action: "Accept an agreement", mode: MODE_LABEL[authority.accept()] },
      { action: "Disclose private details", mode: MODE_LABEL[authority.disclose(null)] },
    ],
    unresolved: [...authority.unresolvedTerms].map(([termId, reason]) => ({ term: nameOf(termId), reason })),
    issues: m.issues.map((i) => ({ id: i.id, kind: i.kind, message: i.message })),
  };
}

function draftView(d: DraftView, locale: string) {
  const m = d.draft;
  const nameOf = (id: string) => m.terms.find((t) => t.id === id)?.name ?? id;
  const val = (v: Value | null) => (v ? formatValue(v, locale) : "unknown");
  const principalId = m.parties.find((p) => p.isPrincipal)?.id;
  return {
    draftId: d.draftId,
    status: d.status,
    basedOnRevision: d.basedOnRevision,
    instructions: d.instructions,
    createdAt: d.createdAt,
    rules: [
      ...m.limits.filter((l) => l.partyId === principalId).map((l) => `${nameOf(l.termId)}: ${l.kind.replace("_", " ")} ${val(l.value)}${l.conditionIds.length ? " (conditional)" : ""}${l.exception === "with_approval" ? ", exception with your approval" : l.exception === "not_allowed" ? ", no exceptions" : ""}`),
      ...m.targets.filter((t) => t.partyId === principalId).map((t) => `Target ${nameOf(t.termId)}: ${val(t.value)}`),
      ...m.preferences.filter((p) => p.partyId === principalId).map((p) => `${p.strength === "avoid" ? "Avoid" : p.strength === "preferred" ? "Prefer" : "Acceptable"} ${nameOf(p.termId)}: ${val(p.value)}`),
      ...m.alternatives.filter((a) => a.partyId === principalId).map((a) => `If no deal: ${a.description}`),
      ...m.goals.filter((g) => g.partyId === principalId).map((g) => `${g.kind === "need" ? "Need" : g.kind === "reason" ? "Reason" : "Goal"}: ${g.description}`),
      ...m.permissions.map((p) => `${p.action.replace(/_/g, " ")}: ${p.mode.replace("_", " ")}${p.conditionIds.length ? " (conditional)" : ""}`),
    ],
    readiness: d.readiness,
    issues: m.issues.map((i) => ({ id: i.id, kind: i.kind, message: i.message })),
  };
}

/** What the counterparty said, the estimate of their limit with its basis, and open questions. */
function counterpartyView(model: CounterpartyModel, state: NegotiationState, locale: string) {
  const n = state.view.negotiable;
  const money = (amount: number | null) => (amount === null || !n ? null : formatValue(numericValue(n, amount), locale));
  const nameOf = (id: string) => state.space.terms.find((t) => t.termId === id)?.name ?? id;
  return {
    items: model.items.map((i) => ({ id: i.id, kind: i.kind, quote: i.quote, summary: i.summary, term: i.termId ? nameOf(i.termId) : null, value: i.value ? formatValue(i.value, locale) : null, condition: i.condition, basis: i.basis })),
    estimates: model.estimates.map((e) => ({
      package: e.packageTerms.map((t) => `${nameOf(t.termId)}: ${formatValue(t.value, locale)}`).join(" · ") || "Seller's listed terms",
      highestOffer: e.highestOffer ? money(e.highestOffer.amount) : null,
      statedBudget: e.statedMaximum?.value ? formatValue(e.statedMaximum.value, locale) : null,
      finalStatements: e.finalStatements.map((f) => f.quote),
      maximum:
        e.maximum.status === "unknown"
          ? { status: "unknown", text: `Maximum unknown. ${e.maximum.reason}` }
          : e.maximum.status === "contradicted"
            ? { status: "contradicted", text: e.maximum.reason }
            : { status: "working_estimate", text: `Working estimate (low confidence): ${e.maximum.atLeast !== null ? `at least ${money(e.maximum.atLeast)}, ` : ""}at most ${money(e.maximum.atMost)}. Assumes: ${e.maximum.assumptions.join(" ")}` },
    })),
    contradictions: model.contradictions.map((c) => c.detail),
    questions: model.questions.map((q) => ({ id: q.id, kind: q.issueKind, text: q.text, purpose: q.purpose, status: q.status })),
    failedMessages: model.failedMessages.length,
  };
}

const OPERATOR_TEXT: Record<NonNullable<ConditionRef["operator"]>, string> = {
  equals: "is",
  not_equals: "is not",
  at_least: "is at least",
  at_most: "is at most",
  includes: "includes",
};

const RESULT_LABEL = { fits: "fits known constraints", conflicts: "conflicts", needs_clarification: "needs clarification" } as const;

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
/**
 * What the counterparty may see about the outcome: the agreed terms and what is still to happen,
 * or, without agreement, each side's last offer the counterparty already saw. Never a private limit.
 */
function buyerOutcome(state: NegotiationState, ctx: SessionContext, locale: string) {
  const model = commitmentsFor(ctx, state, locale);
  const options = commitmentOptions(state, locale);
  const ended = model.outcome === "no_agreement";
  return {
    kind: state.outcome.kind,
    terms: termsView(state.view, state.outcome.terms, locale),
    obligations: model.agreement ? model.agreement.obligations.map((o) => o.description) : [],
    noAgreement: ended ? { ...noAgreementSummary(model, options), endedBy: model.stopped?.by ?? null } : null,
  };
}

function commitmentOptions(state: NegotiationState, locale: string) {
  return {
    negotiableTermId: state.view.negotiable?.termId ?? null,
    termName: (id: string) => state.space.terms.find((t) => t.termId === id)?.name ?? id,
    format: (v: Value) => formatValue(v, locale),
  };
}

/** Commitments with each offer's terms in the listing's order, so every view reads the same way. */
function commitmentsFor(ctx: SessionContext, state: NegotiationState, locale: string): CommitmentsModel {
  const model = projectCommitments(ctx, commitmentOptions(state, locale));
  for (const o of model.offers) o.terms = orderTerms(state.view, o.terms);
  return model;
}

const STATUS_LABEL: Record<string, string> = {
  enquiry: "Enquiry",
  interest: "Interest only",
  proposed: "Open offer",
  pending_clarification: "Needs clarification",
  internal: "Internal, not sent",
  awaiting_approval: "Awaiting your approval",
  delivered: "Delivered, open",
  accepted: "Accepted",
  agreed: "Agreed",
  rejected: "Rejected",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
  expired: "Expired",
};

const ACTION_LABEL: Record<string, string> = {
  ask: "Ask",
  clarify: "Clarify",
  propose: "Propose terms",
  counter: "Counter",
  accept: "Accept",
  decline: "Decline",
  request_approval: "Request approval",
  pause: "Pause",
  end: "End",
  wait: "Wait",
  answer: "Answer",
};

/** Operator view of commitments: every offer version and status, the outcome, and the strategy's recorded actions. */
function commitmentsView(ctx: SessionContext, state: NegotiationState, locale: string, guidanceId: string) {
  const model = commitmentsFor(ctx, state, locale);
  const options = commitmentOptions(state, locale);
  const line = (t: OfferTerm) => `${options.termName(t.termId)}: ${formatValue(t.value, locale)}`;
  const offer = (o: CommitmentsModel["offers"][number]) => ({
    offerId: o.offerId,
    party: o.party,
    kind: o.kind,
    version: o.version,
    status: o.status,
    statusLabel: STATUS_LABEL[o.status] ?? o.status,
    blocked: o.blocked,
    approval: o.approval,
    terms: orderTerms(state.view, o.terms).map(line),
    conditions: o.conditions,
    mandateRevision: o.mandateRevision,
    at: o.at,
  });
  const decisions = ctx.events
    .filter((e) => e.type === "decision")
    .map((e) => {
      const p = e.payload as { kind: string; reason: string; action: string | null; assessment: { verdict: string; drivers: string[] } | null; mandateRevision: number | null; guidance: string | null };
      return { id: e.id, at: e.recordedAt, action: p.action, actionLabel: p.action ? (ACTION_LABEL[p.action] ?? p.action) : null, reason: p.reason, assessment: p.assessment, mandateRevision: p.mandateRevision, guidance: p.guidance };
    })
    .reverse()
    .slice(0, 30);
  return {
    guidance: guidanceId,
    outcome: model.outcome,
    stopped: model.stopped,
    currentCounterpartyOffer: model.currentCounterpartyOffer ? offer(model.currentCounterpartyOffer) : null,
    currentPrincipalOffer: model.currentPrincipalOffer ? offer(model.currentPrincipalOffer) : null,
    offers: [...model.offers].reverse().map(offer),
    agreement: model.agreement ? { terms: orderTerms(state.view, model.agreement.terms).map(line), approved: model.agreement.approvalId !== null, obligations: model.agreement.obligations.map((o) => o.description) } : null,
    noAgreement: model.outcome === "no_agreement" ? noAgreementSummary(model, options) : null,
    decisions,
  };
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
      ? {
          requestId: state.pendingApproval.requestId,
          purpose: state.pendingApproval.purpose,
          requestedAction: state.pendingApproval.requestedAction,
          breachedRules: state.pendingApproval.breachedRuleIds.map((id) => ruleText(state, id, locale)),
          // The exact terms under review: the pending offer itself, not the buyer-facing outcome.
          terms: termsView(state.view, state.lastProposed?.offerId === state.pendingApproval.offerId ? state.lastProposed.terms : state.outcome.terms, locale),
        }
      : null,
    paused: state.status === "paused",
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
      title = p.action ? `Decision: ${ACTION_LABEL[String(p.action)] ?? String(p.action)}` : `Decision: ${String(p.kind).replace(/_/g, " ")}`;
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
    case "term_requested":
      title = "Buyer requested a new term";
      summary = `${p.name}${p.description ? ` — ${p.description}` : ""}`;
      break;
    case "proposal_checked": {
      const findings = (p.findings as Array<{ status: string; termName: string; detail: string }>).filter((f) => f.status !== "fits");
      title = `Check: ${RESULT_LABEL[p.result as keyof typeof RESULT_LABEL]}`;
      summary = findings.length > 0 ? findings.map((f) => `${f.termName}: ${f.detail}`).join(" ") : `Mandate revision ${p.mandateRevision}. ${terms(p.checkedTerms)}`;
      break;
    }
    case "mandate_revised":
      title = "Mandate revised";
      summary = `Revision ${p.mandateRevision}: ${p.reason}`;
      break;
    case "mandate_draft_proposed":
      title = "Mandate draft prepared";
      summary = `Based on revision ${p.basedOnRevision}. Not in force until you confirm it.`;
      break;
    case "mandate_draft_rejected":
      title = "Mandate draft rejected";
      summary = String(p.reason);
      break;
    case "action_checked": {
      const reasons = p.reasons as Array<{ rule: string; detail: string }>;
      title = `Gate (${p.phase}): ${String(p.decision).replace("_", " ")}`;
      summary = reasons.length > 0 ? reasons.map((r) => `${r.rule}: ${r.detail}`).join(" ") : `Move ${p.move}, mandate revision ${p.mandateRevision}.`;
      break;
    }
    case "counterparty_noted": {
      const items = p.items as Array<{ kind: string; quote: string }>;
      title = p.failed ? "Could not read buyer message" : "Buyer context noted";
      summary = p.failed ? "Earlier context is unchanged." : items.map((i) => `${i.kind.replace("_", " ")}: “${i.quote}”`).join(" · ");
      break;
    }
    case "question_prepared":
      title = "Question prepared";
      summary = `${p.text} (${p.purpose})`;
      break;
    case "question_asked":
      title = "Question asked";
      break;
    case "question_answered":
      title = `Question ${p.resolution}`;
      summary = p.quote ? `“${p.quote}”` : "";
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
    payload: e.type === "session_started" || e.type === "mandate_revised" ? { mandateRevision: p.mandateRevision, previousSessionId: p.previousSessionId ?? null } : p,
  };
}
