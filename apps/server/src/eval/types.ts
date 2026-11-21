/**
 * Epic 10 evaluation types. A run is stored as plain data (transcript, buyer-simulator turns,
 * seller interventions, outcome, metrics), so scoring is a pure function of stored runs and
 * re-scoring the same runs always gives the same counts.
 */

/** Hidden buyer profile for a scenario. Only the buyer simulator ever sees it. */
export interface SimulatorSpec {
  goal: string;
  hiddenLimits: { maxPrice: number; requires: string[] };
  plannedMoves: string;
  openingMessage: string;
  maxBuyerTurns: number;
  /** How the seller answers approval requests for terms within the mandate. Terms outside it are always rejected. */
  sellerApproval: "approved" | "rejected";
}

/** Case facts and seller permissions used to judge runs (cases/<case>/evaluation.json). */
export interface Judge {
  mandate: string;
  currency: string;
  minimum: { amount: number; ruleId: string; exceptionAllowed: boolean };
  privateAmounts: number[];
  privateDisclosureRuleId: string;
  listingPrice: number;
  delivery: { allowed: boolean; ruleId: string; termNamePattern: string; includedValuePattern: string };
  approval: { requiredToAgree: boolean; ruleId: string };
  listingFacts: string[];
  inventedFactPatterns: Array<{ label: string; pattern: string }>;
  uncertaintyPattern: string;
  limitWordPattern: string;
  instructionDisclosurePattern: string;
  negationPattern: string;
  quotingPattern: string;
  offerVerbPattern: string;
  deliveryOfferPattern: string;
  /** Questions and requests to the other party assert nothing. */
  requestPattern: string;
}

export type SystemName = "kritva" | "plain";

export interface TranscriptEntry {
  index: number;
  from: "buyer" | "seller" | "seller_decision";
  text: string;
  /** Inspectable source: the record event ID for Kritva, a run-scoped message ID for the plain seller. */
  ref: string;
}

export interface BuyerTurn {
  index: number;
  acceptsCurrentTerms: boolean;
  acceptedPrice: number | null;
  endsConversation: boolean;
}

export interface SellerOutcome {
  kind: "agreement" | "pending_approval" | "no_agreement" | "in_progress";
  price: number | null;
  terms: Array<{ name: string; value: string }>;
  approvalObtained: boolean;
  endedBy: string | null;
  /** Kritva: an acceptance event exists for the agreed terms. Plain seller: null (it keeps no record). */
  recordedAcceptance: boolean | null;
}

export interface RunMetrics {
  sellerCalls: number;
  sellerFailedCalls: number;
  sellerInputTokens: number;
  sellerOutputTokens: number;
  sellerModelMs: number;
  buyerCalls: number;
  /** Wall time of each seller turn (buyer message in, reply out). */
  sellerTurnMs: number[];
  wallMs: number;
}

export interface RunRecord {
  runId: string;
  label: string;
  system: SystemName;
  scenario: string;
  run: number;
  status: "completed" | "failed";
  error: string | null;
  startedAt: string;
  model: string;
  promptVersions: Record<string, string>;
  sessionId: string | null;
  transcript: TranscriptEntry[];
  buyerTurns: BuyerTurn[];
  interventions: Array<{ index: number; decision: "approved" | "rejected"; price: number | null; terms: string }>;
  outcome: SellerOutcome;
  /** Kritva's recorded strategy decisions (empty for the plain seller, which records none). */
  decisions: Array<{ ref: string; action: string | null; reason: string }>;
  /** Moves stopped before reaching the buyer (diagnostic only; never a buyer-visible violation). */
  blocked: { replies: number; moves: number; refs: string[] };
  metrics: RunMetrics;
}

export type Measure = "private_limit_disclosure" | "unauthorized_offer" | "invalid_agreement" | "invented_fact" | "incorrect_agreement_record";

export interface Violation {
  measure: Measure;
  runId: string;
  ref: string;
  turnIndex: number | null;
  quote: string;
  /** The mandate rule or case fact the check used. */
  rule: string;
  detail: string;
}

export interface ReviewItem {
  runId: string;
  ref: string;
  quote: string;
  reason: string;
}

export type OutcomeClass = "valid_agreement" | "invalid_agreement" | "pending_approval" | "appropriate_no_deal" | "missed_deal" | "unresolved" | "failed";

export interface RunScore {
  runId: string;
  system: SystemName;
  scenario: string;
  run: number;
  status: RunRecord["status"];
  outcomeClass: OutcomeClass;
  feasible: boolean;
  violations: Violation[];
  review: ReviewItem[];
  counts: Record<Measure, number>;
  blockedReplies: number;
  blockedMoves: number;
  buyerTurns: number;
  interventions: number;
  finalPrice: number | null;
  finalTerms: string;
}
