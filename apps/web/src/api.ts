/** Typed client for the slice API. Buyer and operator calls go to separate routes. */

export interface TermView {
  termId: string;
  name: string;
  value: string;
}

export type OutcomeKind = "in_progress" | "pending_approval" | "agreement" | "no_agreement";

export interface BuyerMessage {
  id: string;
  seq: number;
  from: "buyer" | "agent";
  text: string;
  at: string;
  channel: "text" | "voice" | null;
}

export interface NoAgreementSummary {
  lastPrincipalOffer: string[];
  lastCounterpartyOffer: string[];
  differences: string[];
}

export interface BuyerOutcome {
  kind: OutcomeKind;
  terms: TermView[] | null;
  /** What still has to happen after an agreement. Pending, never fulfilled here. */
  obligations: string[];
  noAgreement: (NoAgreementSummary & { endedBy: string | null }) | null;
}

export interface BuyerView {
  listing: { terms: TermView[]; facts: string[] };
  messages: BuyerMessage[];
  outcome: BuyerOutcome;
}

export interface OfferView {
  offerId: string;
  party: "principal" | "counterparty";
  kind: string;
  version: number;
  status: string;
  statusLabel: string;
  blocked: boolean;
  approval: "none" | "requested" | "approved" | "rejected";
  terms: string[];
  conditions: string[];
  mandateRevision: number;
  at: string;
}

export interface DecisionView {
  id: string;
  at: string;
  action: string | null;
  actionLabel: string | null;
  reason: string;
  assessment: { verdict: string; drivers: string[] } | null;
  mandateRevision: number | null;
  guidance: string | null;
}

export interface CommitmentsView {
  guidance: string;
  outcome: "negotiating" | "paused" | "pending_approval" | "agreement" | "no_agreement";
  stopped: { by: string | null; reason: string; unresolved: string[] } | null;
  currentCounterpartyOffer: OfferView | null;
  currentPrincipalOffer: OfferView | null;
  offers: OfferView[];
  agreement: { terms: string[]; approved: boolean; obligations: string[] } | null;
  noAgreement: NoAgreementSummary | null;
  decisions: DecisionView[];
}

export interface RecordEvent {
  id: string;
  seq: number;
  at: string;
  type: string;
  actor: "principal" | "counterparty" | "agent" | "system";
  channel: "text" | "voice" | null;
  visibility: "public" | "private";
  title: string;
  summary: string;
  payload: unknown;
}

export interface OperatorState {
  status: string;
  mandateRevision: number;
  outcome: { kind: OutcomeKind; terms: TermView[] | null };
  pendingApproval: { requestId: string; purpose: "acceptance" | "exception"; requestedAction: string; breachedRules: string[]; terms: TermView[] | null } | null;
  paused: boolean;
  negotiable: {
    name: string;
    opening: string | null;
    limit: string | null;
    limitKind: "minimum" | "maximum";
    currentAsk: string | null;
    canConcede: boolean;
  } | null;
  acceptRequiresApproval: boolean;
  counterpartyOffers: Array<string | null>;
}

export interface DealSpaceView {
  terms: Array<{
    termId: string;
    name: string;
    kind: string;
    kindLabel: string;
    value: string | null;
    valueIsPrivate: boolean;
    rules: Array<{ id: string; text: string; private: boolean; conditional: boolean }>;
    inconsistent: boolean;
    openIssues: number;
  }>;
  facts: Array<{ id: string; statement: string; private: boolean }>;
  requested: Array<{ id: string; name: string; value: string | null }>;
  lastBuyerCheck: { result: "fits" | "conflicts" | "needs_clarification"; terms: string[]; findings: Array<{ term: string; status: string; detail: string }> } | null;
}

export interface PrincipalView {
  revision: number;
  goals: Array<{ id: string; kind: string; text: string; priority: number | null; terms: string[]; private: boolean }>;
  targets: Array<{ id: string; text: string; private: boolean }>;
  preferences: Array<{ id: string; text: string; private: boolean }>;
  alternatives: Array<{ id: string; text: string; value: string | null; private: boolean }>;
  limits: Array<{ id: string; text: string; conditional: boolean; exception: string }>;
  permissions: Array<{ action: string; mode: string }>;
  unresolved: Array<{ term: string; reason: string }>;
  issues: Array<{ id: string; kind: string; message: string }>;
}

export interface DraftSummary {
  draftId: string;
  status: "open" | "confirmed" | "rejected" | "stale";
  basedOnRevision: number;
  instructions: string;
  createdAt: string;
  rules: string[];
  readiness: { accept: string; unresolved: Array<{ termId: string; name: string; reason: string }> };
  issues: Array<{ id: string; kind: string; message: string }>;
}

export interface CounterpartyView {
  items: Array<{ id: string; kind: string; quote: string; summary: string; term: string | null; value: string | null; condition: string | null; basis: "stated" | "inferred" }>;
  estimates: Array<{ package: string; highestOffer: string | null; statedBudget: string | null; finalStatements: string[]; maximum: { status: string; text: string } }>;
  contradictions: string[];
  questions: Array<{ id: string; kind: string; text: string; purpose: string; status: string }>;
  failedMessages: number;
}

export interface OperatorView {
  session: { id: string; caseId: string; createdAt: string; previousSessionId: string | null };
  mandateId: string | null;
  state: OperatorState;
  dealSpace: DealSpaceView;
  principal: PrincipalView;
  counterparty: CounterpartyView;
  commitments: CommitmentsView;
  drafts: DraftSummary[];
  events: RecordEvent[];
}

export interface MandateOption {
  id: string;
  title: string;
  description: string | null;
  caseId: string;
}

export interface SessionRow {
  id: string;
  caseId: string;
  createdAt: string;
  previousSessionId: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Unable to reach the Kritva server. Check that it is running, then try again.");
  }
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new ApiError(res.status, json.message ?? `Request failed (${res.status}). Try again.`);
  return json as T;
}

export const api = {
  listSessions: () => call<SessionRow[]>("GET", "/api/operator/sessions"),
  listMandates: () => call<MandateOption[]>("GET", "/api/operator/mandates"),
  startSession: (mandateId: string, previousSessionId: string | null) =>
    call<{ session: SessionRow }>("POST", "/api/operator/sessions", { mandateId, previousSessionId }),
  operatorView: (id: string) => call<OperatorView>("GET", `/api/operator/sessions/${id}`),
  respond: (id: string, requestId: string, decision: "approved" | "rejected") =>
    call<unknown>("POST", `/api/operator/sessions/${id}/approvals/${requestId}`, { decision }),
  buyerView: (id: string) => call<BuyerView>("GET", `/api/buyer/sessions/${id}`),
  send: (id: string, text: string, clientMessageId: string) =>
    call<{ reply: { messageId: string; text: string } | null; outcome: BuyerView["outcome"] }>("POST", `/api/buyer/sessions/${id}/messages`, {
      text,
      clientMessageId,
    }),
  reportDelivered: (id: string, messageId: string) => call<unknown>("POST", `/api/buyer/sessions/${id}/deliveries`, { messageId }),
  endNegotiation: (id: string, reason: string) => call<unknown>("POST", `/api/operator/sessions/${id}/end`, { reason }),
  setPaused: (id: string, paused: boolean) => call<unknown>("POST", `/api/operator/sessions/${id}/pause`, { paused }),
  instructions: (id: string) => call<{ instructions: string }>("GET", `/api/operator/sessions/${id}/instructions`),
  proposeDraft: (id: string, instructions: string) => call<{ draft: DraftSummary }>("POST", `/api/operator/sessions/${id}/drafts`, { instructions }),
  confirmDraft: (id: string, draftId: string, acknowledgedIssueIds: string[]) => call<unknown>("POST", `/api/operator/sessions/${id}/drafts/${draftId}/confirm`, { acknowledgedIssueIds }),
  rejectDraft: (id: string, draftId: string) => call<unknown>("POST", `/api/operator/sessions/${id}/drafts/${draftId}/reject`),
};
