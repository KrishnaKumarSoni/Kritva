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

export interface BuyerView {
  listing: { terms: TermView[]; facts: string[] };
  messages: BuyerMessage[];
  outcome: { kind: OutcomeKind; terms: TermView[] | null };
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
  pendingApproval: { requestId: string; terms: TermView[] | null } | null;
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

export interface OperatorView {
  session: { id: string; caseId: string; createdAt: string; previousSessionId: string | null };
  state: OperatorState;
  events: RecordEvent[];
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
  startSession: (previousSessionId: string | null) =>
    call<{ session: SessionRow }>("POST", "/api/operator/sessions", { mandateId: "bed-sale/demo", previousSessionId }),
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
};
