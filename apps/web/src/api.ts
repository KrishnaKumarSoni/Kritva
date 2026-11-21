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
  subject: string | null;
  terms: TermView[] | null;
  /** What still has to happen after an agreement. Pending, never fulfilled here. */
  obligations: string[];
  noAgreement: (NoAgreementSummary & { endedBy: string | null }) | null;
}

/** The parties' roles in the mandate's own words, so no screen assumes a case. */
export interface Roles {
  principal: string;
  counterparty: string;
}

export interface BuyerView {
  listing: { terms: TermView[]; facts: string[] };
  roles: Roles;
  messages: BuyerMessage[];
  paused: boolean;
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
  subject: string | null;
  mandateRevision: number;
  outcome: { kind: OutcomeKind; terms: TermView[] | null };
  pendingApproval: { requestId: string; offerId: string; mandateRevision: number; purpose: "acceptance" | "exception"; requestedAction: string; breachedRules: string[]; terms: TermView[] | null } | null;
  /** The last reply was cut off mid-speech and the buyer hasn't spoken since. */
  voiceInterrupted?: boolean;
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

/** Private numbers for the console (seller side only). Amounts are raw values on the negotiable term. */
export interface Insights {
  locale: string;
  term: { termId: string; name: string; direction: "up" | "down"; currency: string | null; unit: string | null };
  opening: number;
  currentAsk: number | null;
  limit: number | null;
  target: number | null;
  counterparty: {
    latestOffer: number | null;
    bestOffer: number | null;
    statedCeiling: number | null;
    estimate: { status: "unknown" | "working_estimate" | "contradicted"; atLeast: number | null; atMost: number | null };
  };
  zone: { status: "overlap" | "no_overlap" | "unknown"; from: number | null; to: number | null };
  gap: number | null;
  strategy: {
    guidanceId: string;
    countersMade: number;
    maxCounteroffers: number | null;
    nextStepCap: number | null;
    splitAvailable: boolean;
    allowance: { earned: number; used: number; remaining: number } | null;
  };
}

export interface OperatorView {
  session: { id: string; caseId: string; createdAt: string; previousSessionId: string | null };
  roles: Roles;
  insights: Insights | null;
  mandateId: string | null;
  state: OperatorState;
  dealSpace: DealSpaceView;
  principal: PrincipalView;
  counterparty: CounterpartyView;
  commitments: CommitmentsView;
  drafts: DraftSummary[];
  events: RecordEvent[];
}

export interface LibraryInput {
  title: string;
  principalRole: string;
  counterpartyRole: string;
  publicText: string;
  privateText: string;
}

export type MandateState = "draft" | "live" | "paused" | "closed";

export interface LibrarySummary {
  mandateId: string;
  title: string;
  caseId: string;
  activeRevision: number | null;
  hasOpenDraft: boolean;
  state: MandateState;
  updatedAt: string;
}

export type LifecycleStep = "pause" | "resume" | "close" | "reopen";

export interface IntakeDraftSummary {
  id: string;
  title: string;
  updatedAt: string;
  progress: number;
}

export type IntakeCard =
  | { kind: "ready"; versionId: string; draftHash: string; notes: string[]; mode: "new" | "update"; actionable: boolean; review: MandateReview | null }
  | { kind: "live"; revision: number };

export interface IntakeMessageView {
  id: string;
  role: "user" | "assistant";
  text: string;
  images: string[];
  at: string;
  card: IntakeCard | null;
}

export interface IntakeView {
  id: string;
  mandateId: string | null;
  title: string;
  state: MandateState | "new";
  messages: IntakeMessageView[];
  checklist: Array<{ id: string; label: string; required: boolean; status: "known" | "assumed" | "missing" }>;
  progress: number;
  next: "prepare" | null;
  mandate: LibraryDetailView | null;
  appliedToSessions?: string[];
}

export interface LibraryExample extends LibraryInput {
  id: string;
}

export interface ReviewItem {
  recordId: string;
  label: string;
  text: string;
  private: boolean;
  edit: "value" | "mode" | null;
  currentValue: string | null;
  currentMode: string | null;
  removable: boolean;
  inferred: boolean;
  source: string | null;
}

export interface MandateReview {
  parties: { you: string; other: string };
  sources: Array<{ id: string; label: string; private: boolean }>;
  sections: Array<{ id: string; title: string; empty: string; items: ReviewItem[] }>;
  issues: Array<{ id: string; kind: string; message: string; blocking: boolean }>;
}

export interface LibraryDetailView {
  mandateId: string;
  title: string;
  caseId: string;
  state: MandateState;
  input: LibraryInput;
  versions: Array<{ versionId: string; seq: number; origin: "text" | "correction"; status: "draft" | "confirmed" | "superseded" | "discarded"; revision: number | null; createdAt: string; draftHash: string }>;
  active: { revision: number; versionId: string; confirmedAt: string; review: MandateReview } | null;
  latest: { versionId: string; status: "draft" | "confirmed" | "superseded" | "discarded"; draftHash: string; review: MandateReview; blockers: string[]; accept: string } | null;
  appliedToSessions?: string[];
}

export type LibraryCorrection = { recordId: string; value: string } | { recordId: string; mode: string } | { recordId: string; remove: true };


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
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sellerKeyStorage = "kritva.seller-key";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (path.startsWith("/api/operator/")) {
    const key = sessionStorage.getItem(sellerKeyStorage);
    if (key) headers.set("authorization", `Bearer ${key}`);
  }
  try {
    res = await fetch(path, {
      method,
      headers,
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
  hasSellerKey: () => Boolean(sessionStorage.getItem(sellerKeyStorage)),
  rememberSellerKey: (key: string) => sessionStorage.setItem(sellerKeyStorage, key),
  listSessions: () => call<SessionRow[]>("GET", "/api/operator/sessions"),
  listMandates: () => call<MandateOption[]>("GET", "/api/operator/mandates"),
  startSession: (mandateId: string, previousSessionId: string | null) =>
    call<{ session: SessionRow }>("POST", "/api/operator/sessions", { mandateId, previousSessionId }),
  operatorView: (id: string) => call<OperatorView>("GET", `/api/operator/sessions/${id}`),
  respond: (id: string, requestId: string, decision: "approved" | "rejected", offerId: string, mandateRevision: number) =>
    call<unknown>("POST", `/api/operator/sessions/${id}/approvals/${requestId}`, { decision, offerId, mandateRevision }),
  buyerView: (id: string) => call<BuyerView>("GET", `/api/buyer/sessions/${id}`),
  send: (id: string, text: string, clientMessageId: string) =>
    call<{ reply: { messageId: string; text: string } | null; outcome: BuyerView["outcome"] }>("POST", `/api/buyer/sessions/${id}/messages`, {
      text,
      clientMessageId,
    }),
  reportDelivered: (id: string, messageId: string) => call<unknown>("POST", `/api/buyer/sessions/${id}/deliveries`, { messageId }),
  reportVoiceDelivery: async (id: string, messageId: string, status: "delivered" | "interrupted" | "failed", deliveredText: string | null, audioStartMs: number | null) => {
    const res = await fetch(`/api/buyer/sessions/${id}/deliveries`, {
      method: "POST", keepalive: true, headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId, channel: "voice", status, deliveredText, audioStartMs }),
    });
    if (!res.ok) throw new ApiError(res.status, "The reply's delivery couldn't be saved.");
  },
  voiceStart: (id: string) => call<{ afterSeq: number; reply: { messageId: string; text: string } | null }>("POST", `/api/buyer/sessions/${id}/voice/start`),
  voiceInterrupted: (id: string) => fetch(`/api/buyer/sessions/${id}/voice/interruption`, { method: "POST", keepalive: true }),
  voiceUtterance: async (id: string, clientMessageId: string, wav: Blob) => {
    let res: Response;
    try {
      res = await fetch(`/api/buyer/sessions/${id}/voice/utterances?clientMessageId=${encodeURIComponent(clientMessageId)}`, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
    } catch {
      throw new ApiError(0, "Unable to reach the Kritva server. Nothing was sent.");
    }
    const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (!res.ok) throw new ApiError(res.status, json.message ?? "That didn't go through. Nothing was sent.", json.error);
    return json as { transcript: string; reply: { messageId: string; text: string } | null; timings: { transcribeMs: number; turnMs: number; serverMs: number } };
  },
  /** Live voice: the browser's WebRTC offer in, the call's answer out. 501 means live voice is off. */
  voiceRealtime: async (id: string, sdp: string) => {
    let res: Response;
    try {
      res = await fetch(`/api/buyer/sessions/${id}/voice/realtime`, { method: "POST", headers: { "content-type": "application/sdp" }, body: sdp });
    } catch {
      throw new ApiError(0, "Unable to reach the Kritva server. Voice didn't start.");
    }
    const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string; sdp?: string; afterSeq?: number };
    if (!res.ok) throw new ApiError(res.status, json.message ?? "Voice couldn't connect. You can keep typing.", json.error);
    return json as { sdp: string; afterSeq: number };
  },
  voiceRealtimeEnd: (id: string) => fetch(`/api/buyer/sessions/${id}/voice/realtime/end`, { method: "POST", keepalive: true }),
  speechUrl: (id: string, messageId: string) => `/api/buyer/sessions/${id}/voice/speech/${encodeURIComponent(messageId)}`,
  endNegotiation: (id: string, reason: string) => call<unknown>("POST", `/api/operator/sessions/${id}/end`, { reason }),
  library: {
    list: () => call<LibrarySummary[]>("GET", "/api/operator/library"),
    examples: () => call<LibraryExample[]>("GET", "/api/operator/library/examples"),
    get: (id: string) => call<LibraryDetailView>("GET", `/api/operator/library/${id}`),
    create: (input: LibraryInput) => call<LibraryDetailView>("POST", "/api/operator/library", input),
    remap: (id: string, input: LibraryInput) => call<LibraryDetailView>("POST", `/api/operator/library/${id}/drafts`, input),
    correct: (id: string, versionId: string, corrections: LibraryCorrection[]) => call<LibraryDetailView>("POST", `/api/operator/library/${id}/corrections`, { versionId, corrections }),
    confirm: (id: string, versionId: string, draftHash: string, acknowledgedIssueIds: string[]) => call<LibraryDetailView>("POST", `/api/operator/library/${id}/confirm`, { versionId, draftHash, acknowledgedIssueIds }),
    discard: (id: string, versionId: string) => call<LibraryDetailView>("POST", `/api/operator/library/${id}/discard`, { versionId }),
    lifecycle: (id: string, action: LifecycleStep) => call<LibraryDetailView>("POST", `/api/operator/library/${id}/lifecycle`, { action }),
    remove: (id: string) => call<{ ok: true }>("DELETE", `/api/operator/library/${id}`),
  },
  intake: {
    drafts: () => call<IntakeDraftSummary[]>("GET", "/api/operator/intake"),
    start: () => call<IntakeView>("POST", "/api/operator/intake"),
    get: (id: string) => call<IntakeView>("GET", `/api/operator/intake/${id}`),
    forMandate: (mandateId: string) => call<IntakeView>("GET", `/api/operator/intake/mandate/${mandateId}`),
    send: (id: string, text: string, images: string[]) => call<IntakeView>("POST", `/api/operator/intake/${id}/messages`, { text, images }),
    prepare: (id: string) => call<IntakeView>("POST", `/api/operator/intake/${id}/prepare`),
    goLive: (id: string, versionId: string, draftHash: string) => call<IntakeView>("POST", `/api/operator/intake/${id}/live`, { versionId, draftHash }),
    discard: (id: string) => call<{ ok: true }>("DELETE", `/api/operator/intake/${id}`),
  },
  setPaused: (id: string, paused: boolean) => call<unknown>("POST", `/api/operator/sessions/${id}/pause`, { paused }),
  instructions: (id: string) => call<{ instructions: string }>("GET", `/api/operator/sessions/${id}/instructions`),
  proposeDraft: (id: string, instructions: string) => call<{ draft: DraftSummary }>("POST", `/api/operator/sessions/${id}/drafts`, { instructions }),
  confirmDraft: (id: string, draftId: string, acknowledgedIssueIds: string[]) => call<unknown>("POST", `/api/operator/sessions/${id}/drafts/${draftId}/confirm`, { acknowledgedIssueIds }),
  rejectDraft: (id: string, draftId: string) => call<unknown>("POST", `/api/operator/sessions/${id}/drafts/${draftId}/reject`),
};
