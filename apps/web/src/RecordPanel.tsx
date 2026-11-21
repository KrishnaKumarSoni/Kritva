import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { OperatorView, RecordEvent } from "./api.ts";
import { BuyerPanel } from "./BuyerPanel.tsx";
import { CommitmentsPanel } from "./CommitmentsPanel.tsx";
import { DealSpace } from "./DealSpace.tsx";
import { MandatePanel } from "./MandatePanel.tsx";
import { CheckIcon, ClockIcon, LockIcon, ShieldIcon } from "./icons.tsx";

const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;

type Filter = "all" | "conversation" | "commitments" | "blocked" | "checks";
const FILTERS: Array<{ id: Filter; label: string; match: (e: RecordEvent) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  { id: "conversation", label: "Messages", match: (e) => e.type === "message" || e.type === "delivery_reported" },
  {
    id: "commitments",
    label: "Offers & decisions",
    match: (e) =>
      ["offer_extracted", "offer_proposed", "decision", "acceptance_recorded", "approval_requested", "approval_responded", "agreement_recorded", "status_changed"].includes(e.type),
  },
  { id: "blocked", label: "Blocked", match: (e) => e.type === "reply_blocked" },
  { id: "checks", label: "Checks", match: (e) => ["proposal_checked", "term_requested", "mandate_revised", "action_checked", "mandate_draft_proposed", "mandate_draft_rejected"].includes(e.type) },
];

type Tab = "record" | "offers" | "deal" | "buyer" | "mandate";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "record", label: "Record" },
  { id: "offers", label: "Offers" },
  { id: "deal", label: "Deal space" },
  { id: "buyer", label: "Buyer" },
  { id: "mandate", label: "Mandate" },
];

const ACTOR_LABEL: Record<RecordEvent["actor"], string> = {
  principal: "Seller",
  counterparty: "Buyer",
  agent: "Kritva",
  system: "System",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Negotiating",
  awaiting_approval: "Waiting for your approval",
  agreed: "Agreed",
  no_agreement: "No agreement",
  paused: "Paused",
  ended: "Ended",
};

interface RecordPanelProps {
  view: OperatorView | null;
  responding: boolean;
  onRespond: (requestId: string, decision: "approved" | "rejected") => void;
  onPause: (paused: boolean) => void;
  onChanged: () => void;
  /** Epic 12: pause and open the saved mandate in the mandate library. Null when the session uses a prepared file. */
  onChangeInstructions?: (() => void) | null;
}

export function RecordPanel({ view, responding, onRespond, onPause, onChanged, onChangeInstructions = null }: RecordPanelProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [tab, setTab] = useState<Tab>("record");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Tabs follow the APG pattern: arrow keys move between tabs, and only the active tab is in the tab order.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = e.key === "ArrowRight" ? (index + 1) % TABS.length : e.key === "ArrowLeft" ? (index - 1 + TABS.length) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };
  const reduced = useReducedMotion();
  const events = view?.events ?? [];
  const visible = useMemo(() => {
    const match = FILTERS.find((f) => f.id === filter)!.match;
    return events.filter(match).slice().reverse();
  }, [events, filter]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, events.filter(f.match).length])), [events]);
  const state = view?.state;
  const n = state?.negotiable;

  return (
    <section className="panel" aria-labelledby="record-title">
      <header className="panel-header">
        <div>
          <h2 className="panel-title" id="record-title">
            Seller console
          </h2>
          <p className="panel-subtitle">Operator view of the shared record. Private items never reach the buyer.</p>
        </div>
        {view && !["agreed", "no_agreement", "ended"].includes(view.state.status) && (
          <div className="console-actions">
            {onChangeInstructions && (
              <button type="button" className="button button-secondary" onClick={onChangeInstructions}>
                Change instructions
              </button>
            )}
            <button type="button" className={`button ${view.state.paused ? "button-neutral" : "button-secondary"}`} onClick={() => onPause(!view.state.paused)} aria-pressed={view.state.paused}>
              {view.state.paused ? "Resume" : "Pause"}
            </button>
          </div>
        )}
      </header>

      {state && (
        <dl className="summary">
          <Stat label="Status" value={`${STATUS_LABEL[state.status] ?? state.status}${state.voiceInterrupted ? " · voice reply cut off" : ""}`} />
          <Stat label="Current ask" value={n?.currentAsk ?? "Not set"} />
          <Stat label="Asking price" value={n?.opening ?? "Not set"} />
          <Stat label={n?.limitKind === "maximum" ? "Maximum" : "Minimum"} value={n?.limit ?? "Not set"} isPrivate />
          <Stat label="Buyer offers" value={state.counterpartyOffers.length > 0 ? state.counterpartyOffers.join(", ") : "None yet"} />
          <Stat label="Accepting" value={state.acceptRequiresApproval ? "Needs your approval" : "Kritva may accept"} isPrivate />
          {view?.commitments.decisions[0] && (
            <div className="stat stat-wide">
              <dt className="stat-label">Last action</dt>
              <dd className="stat-value stat-value-text" style={{ margin: 0 }}>
                {view.commitments.decisions[0].actionLabel ?? "Decision"}
                <span className="stat-detail">{view.commitments.decisions[0].reason}</span>
              </dd>
            </div>
          )}
        </dl>
      )}

      {view && <OutcomeStrip view={view} />}

      <AnimatePresence initial={false}>
        {state?.pendingApproval && (
          <motion.section
            key={state.pendingApproval.requestId}
            className="approval"
            aria-labelledby="approval-title"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={spring}
          >
            <h3 id="approval-title">{state.pendingApproval.purpose === "exception" ? "Exception requested" : "The buyer confirmed these terms"}</h3>
            {state.pendingApproval.terms && (
              <dl className="terms">
                {state.pendingApproval.terms.map((t) => (
                  <div key={t.termId} style={{ display: "contents" }}>
                    <dt>{t.name}</dt>
                    <dd>{t.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {state.pendingApproval.breachedRules.length > 0 && <p>Crosses: {state.pendingApproval.breachedRules.join("; ")}. Approval covers these exact terms once; your standing limit stays.</p>}
            <p>{state.pendingApproval.requestedAction || "Your mandate requires your approval before Kritva records an agreement."}</p>
            <div className="approval-actions">
              <button type="button" className="button button-accent" disabled={responding} onClick={() => onRespond(state.pendingApproval!.requestId, "approved")}>
                {responding ? <span className="spinner" aria-hidden="true" /> : null}
                Approve terms
              </button>
              <button type="button" className="button button-secondary" disabled={responding} onClick={() => onRespond(state.pendingApproval!.requestId, "rejected")}>
                Reject terms
              </button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <div className="tabs" role="tablist" aria-label="Console views">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className="tab"
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "offers" && view && (
        <div role="tabpanel" id="panel-offers" aria-labelledby="tab-offers" className="tabpanel">
          <CommitmentsPanel sessionId={view.session.id} view={view.commitments} onChanged={onChanged} />
        </div>
      )}
      {tab === "deal" && view && (
        <div role="tabpanel" id="panel-deal" aria-labelledby="tab-deal" className="tabpanel">
          <DealSpace view={view.dealSpace} />
        </div>
      )}
      {tab === "buyer" && view && (
        <div role="tabpanel" id="panel-buyer" aria-labelledby="tab-buyer" className="tabpanel">
          <BuyerPanel view={view.counterparty} />
        </div>
      )}
      {tab === "mandate" && view && (
        <div role="tabpanel" id="panel-mandate" aria-labelledby="tab-mandate" className="tabpanel">
          <MandatePanel principal={view.principal} onChangeInstructions={onChangeInstructions} />
        </div>
      )}

      {tab === "record" && (
      <div role="tabpanel" id="panel-record" aria-labelledby="tab-record" className="tabpanel">
      <div className="filters" role="group" aria-label="Filter events">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className="filter" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
            <span className="count">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      <ol className="events" aria-label="Recorded events, newest first">
        {visible.length === 0 && (
          <li className="events-empty">
            {filter === "blocked" ? "No replies were blocked in this session." : filter === "checks" ? "No proposals checked yet." : "Nothing recorded yet."}
          </li>
        )}
        <AnimatePresence initial={false}>
          {visible.map((e) => (
            <motion.li
              key={e.id}
              layout={!reduced}
              className={`event${e.type === "reply_blocked" ? " event-blocked" : ""}`}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={spring}
            >
              <span className="event-seq" aria-label={`Event ${e.seq}`}>
                {e.seq}
              </span>
              <div>
                <div className="event-head">
                  <span className="event-title">
                    {e.type === "reply_blocked" && <ShieldIcon />}
                    {e.title}
                  </span>
                  <time className="event-time" dateTime={e.at}>
                    {new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                  </time>
                </div>
                {e.summary && <p className="event-summary">{e.summary}</p>}
                <div className="event-tags">
                  <span className="chip">{ACTOR_LABEL[e.actor]}</span>
                  {offerStatus(view, e) && <span className="chip chip-strong">{offerStatus(view, e)}</span>}
                  {e.channel && <span className="chip">{e.channel === "voice" ? "Voice" : "Text"}</span>}
                  {e.visibility === "private" && (
                    <span className="chip chip-strong">
                      <LockIcon width={12} height={12} />
                      Private
                    </span>
                  )}
                </div>
                <details>
                  <summary>Event data</summary>
                  <pre>{JSON.stringify(e.payload, null, 2)}</pre>
                </details>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
      </div>
      )}
    </section>
  );
}

function Stat({ label, value, isPrivate = false }: { label: string; value: string; isPrivate?: boolean }) {
  return (
    <div className="stat">
      <dt className="stat-label">
        {label}
        {isPrivate && (
          <>
            <LockIcon width={12} height={12} />
            <span className="visually-hidden">(private)</span>
          </>
        )}
      </dt>
      <dd className="stat-value" style={{ margin: 0 }}>
        {value}
      </dd>
    </div>
  );
}

/** A seller offer in the record, labelled with its current status so an unsent offer never looks delivered. */
function offerStatus(view: OperatorView | null, e: RecordEvent): string | null {
  if (!view || (e.type !== "offer_proposed" && e.type !== "offer_extracted")) return null;
  const o = view.commitments.offers.find((x) => x.offerId === e.id);
  if (!o) return null;
  return o.blocked ? "Held back, never sent" : o.statusLabel;
}

/** Epic 12: the outcome at a glance, from the saved offer and approval records. */
function OutcomeStrip({ view }: { view: OperatorView }) {
  const c = view.commitments;
  if (c.outcome === "agreement" && c.agreement) {
    return (
      <section className="outcome outcome-agreement console-outcome" aria-labelledby="console-outcome-title">
        <div className="outcome-head">
          <span className="outcome-icon">
            <CheckIcon />
          </span>
          <h3 id="console-outcome-title">Agreement reached</h3>
        </div>
        <ul className="offer-terms">
          {c.agreement.terms.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <div className="outcome-todo">
          <p className="outcome-todo-title">Still to do</p>
          <ul>
            {c.agreement.obligations.map((o) => (
              <li key={o}>
                <ClockIcon width={14} height={14} />
                <span>{o}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="outcome-note">{c.agreement.approved ? "You approved these exact terms." : "Your mandate let Kritva accept these terms."} Payment and pickup stay pending until they actually happen.</p>
      </section>
    );
  }
  if (c.outcome === "no_agreement") {
    const by = c.stopped?.by === "counterparty" ? "the buyer" : c.stopped?.by === "principal" ? "you" : c.stopped?.by === "agent" ? "Kritva" : "an unknown party";
    return (
      <section className="outcome outcome-pending console-outcome" aria-labelledby="console-outcome-title">
        <div className="outcome-head">
          <h3 id="console-outcome-title">No agreement</h3>
        </div>
        <p className="outcome-note">
          Ended by {by}
          {c.stopped?.reason ? `: ${c.stopped.reason}` : "."}
        </p>
      </section>
    );
  }
  return null;
}
