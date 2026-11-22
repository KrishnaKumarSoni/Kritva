import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Decision, OperatorView, TermValue } from "./api.ts";
import { ApprovalCard, FollowUpStatus } from "./ApprovalCard.tsx";
import { CheckIcon, ClockIcon, LockIcon } from "./icons.tsx";
import { formatAmount, PriceBand, zoneSentence } from "./PriceBand.tsx";

const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;

const STATUS: Record<string, { label: string; tone: "live" | "wait" | "done" | "stop" }> = {
  active: { label: "Negotiating", tone: "live" },
  awaiting_approval: { label: "Needs your approval", tone: "wait" },
  paused: { label: "Paused", tone: "wait" },
  agreed: { label: "Agreed", tone: "done" },
  no_agreement: { label: "No agreement", tone: "stop" },
  ended: { label: "Ended", tone: "stop" },
};

interface InsightsPanelProps {
  view: OperatorView | null;
  responding: boolean;
  sessionId: string | null;
  onDecide: (requestId: string, decision: Decision, extra: { message?: string; counterTerms?: Array<{ termId: string; value: TermValue }> }) => Promise<boolean>;
  onPause: (paused: boolean) => void;
  onEditInstructions: (() => void) | null;
}

/** "price: ₹19,800" → ["price", "₹19,800"]. */
function splitTerm(line: string): [string, string] {
  const at = line.indexOf(": ");
  return at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 2)];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Tab = "price" | "strategy" | "said" | "record";
const TAB_KEY = "kritva.insights.tab";
function savedTab(): Tab {
  try {
    const t = window.localStorage.getItem(TAB_KEY);
    return t === "strategy" || t === "said" || t === "record" ? t : "price";
  } catch {
    return "price";
  }
}

export function InsightsPanel({ view, responding, sessionId, onDecide, onPause, onEditInstructions }: InsightsPanelProps) {
  const reduced = useReducedMotion();
  const [tab, setTabState] = useState<Tab>(savedTab);
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      window.localStorage.setItem(TAB_KEY, t);
    } catch {
      /* the choice just isn't remembered */
    }
  };
  if (!view) {
    return (
      <section className="panel" aria-labelledby="insights-title">
        <header className="panel-header">
          <h2 className="panel-title" id="insights-title">Negotiation</h2>
        </header>
        <div className="empty">
          <p>Choose a mandate and start a new negotiation. What Kritva knows and decides shows up here.</p>
        </div>
      </section>
    );
  }
  const { state, commitments, counterparty } = view;
  // A server older than this console sends neither; the panel still renders without the band.
  const insights = view.insights ?? null;
  const roles = view.roles ?? { principal: "principal", counterparty: "other party" };
  const status = STATUS[state.status] ?? { label: state.status, tone: "live" as const };
  const finished = ["agreed", "no_agreement", "ended"].includes(state.status);
  const last = commitments.decisions[0];
  const pending = state.pendingApproval;
  const enter = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 } } : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } };

  // Terms side by side: your current package against their latest offer, term by term.
  const ours = new Map((commitments.currentPrincipalOffer?.terms ?? view.dealSpace.terms.filter((t) => t.value && !t.valueIsPrivate).map((t) => `${t.name}: ${t.value}`)).map(splitTerm));
  const theirs = new Map((commitments.currentCounterpartyOffer?.terms ?? []).map(splitTerm));
  const termNames = [...new Set([...ours.keys(), ...theirs.keys()])];
  const signals = counterparty.items.slice().reverse();
  const openQuestions = counterparty.questions.filter((q) => q.status === "open" || q.status === "asked");
  const zone = insights ? zoneSentence(insights, roles) : null;
  const s = insights?.strategy;

  return (
    <section className="panel insights" aria-labelledby="insights-title">
      <header className="panel-header">
        <div className="insights-heading">
          <h2 className="panel-title" id="insights-title">{state.subject ?? "Negotiation"}</h2>
          <span className={`pill pill-${status.tone}`}>
            <span className="pill-dot" aria-hidden="true" />
            {status.label}
          </span>
        </div>
        {!finished && (
          <div className="insights-actions">
            {onEditInstructions && (
              <button type="button" className="button button-ghost" onClick={onEditInstructions}>
                Edit instructions
              </button>
            )}
            <button type="button" className="button button-secondary" onClick={() => onPause(!state.paused)} aria-pressed={state.paused}>
              {state.paused ? "Resume" : "Pause"}
            </button>
          </div>
        )}
      </header>

      <div className="insights-body">
        <AnimatePresence initial={false}>
          {pending && (
            <motion.section key={pending.requestId} className="callout callout-approval" aria-labelledby="approval-title" {...enter} exit={{ opacity: 0 }} transition={spring}>
              <h3 id="approval-title" className="section-title">
                <ClockIcon width={16} height={16} aria-hidden="true" />
                {pending.purpose === "exception" ? "Approve an exception?" : `The ${roles.counterparty} accepted. Approve?`}
              </h3>
              {sessionId && <ApprovalCard sessionId={sessionId} state={state} roles={roles} responding={responding} onDecide={onDecide} />}
            </motion.section>
          )}
          {!pending && state.followUp?.decision && state.followUp.status && state.followUp.status !== "agreed" && (
            <motion.div key="follow-up" {...enter} exit={{ opacity: 0 }} transition={spring}>
              <FollowUpStatus followUp={state.followUp} roles={roles} />
            </motion.div>
          )}
          {commitments.agreement && (
            <motion.section key="agreement" className="callout callout-done" aria-labelledby="agreement-title" {...enter} transition={spring}>
              <h3 id="agreement-title" className="section-title">
                <CheckIcon width={16} height={16} aria-hidden="true" />
                Agreed{commitments.agreement.approved ? " with your approval" : ""}
              </h3>
              <dl className="kv">
                {commitments.agreement.terms.map(splitTerm).map(([name, value]) => (
                  <div key={name} className="kv-row">
                    <dt>{cap(name)}</dt>
                    <dd className="tabular">{value}</dd>
                  </div>
                ))}
              </dl>
              {commitments.agreement.obligations.length > 0 && <p className="callout-note">Still to do: {commitments.agreement.obligations.join("; ")}</p>}
            </motion.section>
          )}
          {commitments.outcome === "no_agreement" && commitments.stopped && (
            <motion.section key="stopped" className="callout" {...enter} transition={spring}>
              <h3 className="section-title">No agreement</h3>
              <p className="callout-text">{commitments.stopped.reason}</p>
            </motion.section>
          )}
        </AnimatePresence>

        <Tabs
          label="Negotiation details"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "price", label: "Price" },
            { id: "strategy", label: "Strategy & terms" },
            { id: "said", label: "What they said" },
            { id: "record", label: "Record" },
          ]}
        >
          {tab === "price" && (
            <>
        {insights ? (
          <section className="block" aria-labelledby="band-title">
            <div className="block-head">
              <h3 className="section-title" id="band-title">{cap(insights.term.name)}</h3>
              <p className="block-hint">
                <LockIcon width={12} height={12} aria-hidden="true" /> Only you see this
              </p>
            </div>
            <dl className="figures">
              <Figure label="On the table" value={insights.currentAsk !== null ? formatAmount(insights, insights.currentAsk) : "None"} />
              <Figure label="Their latest" value={insights.counterparty.latestOffer !== null ? formatAmount(insights, insights.counterparty.latestOffer) : "No offer"} />
              <Figure label="Gap" value={insights.gap !== null ? formatAmount(insights, insights.gap) : "Not yet"} />
            </dl>
            <PriceBand insights={insights} roles={roles} />
            {zone && (
              <p className={`zone zone-${zone.tone}`}>
                <span className="zone-label">Zone of agreement</span>
                {zone.text}
              </p>
            )}
          </section>
        ) : (
          <p className="muted">No price yet. The {roles.counterparty} hasn't said anything about it.</p>
        )}
            </>
          )}
          {tab === "strategy" && (
            <>
        <section className="block" aria-labelledby="strategy-title">
          <h3 className="section-title" id="strategy-title">Strategy</h3>
          {last ? (
            <div className="move">
              <p className="move-label">{last.actionLabel ?? "Decision"}</p>
              <p className="move-reason">{last.reason}</p>
            </div>
          ) : (
            <p className="muted">No move yet. Kritva decides after the {roles.counterparty}'s first message.</p>
          )}
          {s && insights && (
            <dl className="kv">
              <div className="kv-row">
                <dt>Counteroffers</dt>
                <dd>
                  {s.maxCounteroffers !== null ? (
                    <span className="pips">
                      {Array.from({ length: s.maxCounteroffers }, (_, i) => (
                        <span key={i} className={`pip${i < s.countersMade ? " is-used" : ""}`} aria-hidden="true" />
                      ))}
                      <span className="tabular">{s.countersMade} of {s.maxCounteroffers} used</span>
                    </span>
                  ) : (
                    <span className="tabular">{s.countersMade} made</span>
                  )}
                </dd>
              </div>
              <div className="kv-row">
                <dt>Next concession</dt>
                <dd className="tabular">{nextConcession(insights, roles.counterparty)}</dd>
              </div>
              <div className="kv-row">
                <dt>Discount earned</dt>
                <dd>
                  {s.allowance && s.allowance.earned === 0 ? (
                    "None earned yet"
                  ) : s.allowance ? (
                    <span className="meter-wrap">
                      <span className="meter" aria-hidden="true">
                        <motion.span className="meter-fill" initial={false} animate={{ width: `${s.allowance.earned ? (s.allowance.used / s.allowance.earned) * 100 : 0}%` }} transition={reduced ? { duration: 0 } : spring} />
                      </span>
                      <span className="tabular">
                        {formatAmount(insights, s.allowance.remaining)} left of {formatAmount(insights, s.allowance.earned)}
                      </span>
                    </span>
                  ) : (
                    "No allowance set"
                  )}
                </dd>
              </div>
            </dl>
          )}
        </section>

        {termNames.length > 0 && (
          <section className="block" aria-labelledby="terms-title">
            <h3 className="section-title" id="terms-title">Terms</h3>
            <table className="terms-table">
              <thead>
                <tr>
                  <th scope="col"><span className="visually-hidden">Term</span></th>
                  <th scope="col">You</th>
                  <th scope="col">Them</th>
                </tr>
              </thead>
              <tbody>
                {termNames.map((name) => {
                  const a = ours.get(name) ?? "";
                  const b = theirs.get(name) ?? "";
                  return (
                    <tr key={name} className={b && a && a !== b ? "is-different" : undefined}>
                      <th scope="row">{cap(name)}</th>
                      <td className="tabular">{a || "Not set"}</td>
                      <td className="tabular">{b || "Not stated"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

            </>
          )}
          {tab === "said" && (
            <section className="block" aria-labelledby="signals-title">
              <h3 className="section-title" id="signals-title">What the {roles.counterparty} said</h3>
              {signals.length === 0 && openQuestions.length === 0 ? (
                <p className="muted">Nothing noted yet.</p>
              ) : (
                <ul className="signals">
                  {signals.map((item) => (
                    <li key={item.id}>
                      <span className="signal-kind">{cap(item.kind.replace(/_/g, " "))}</span>
                      <span className="signal-text">{item.summary}</span>
                      <q className="signal-quote">{item.quote}</q>
                    </li>
                  ))}
                  {openQuestions.map((q) => (
                    <li key={q.id}>
                      <span className="signal-kind">Asked</span>
                      <span className="signal-text">{q.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {tab === "record" && (
        <section className="block" aria-labelledby="record-title">
          <h3 className="section-title" id="record-title">
            Full record <span className="tabular muted">{view.events.length}</span>
          </h3>
          <ol className="record-list">
            {view.events.slice().reverse().map((e) => (
              <li key={e.id}>
                <span className="record-title">
                  {e.title}
                  {e.visibility === "private" && (
                    <>
                      <LockIcon width={11} height={11} />
                      <span className="visually-hidden">(private)</span>
                    </>
                  )}
                </span>
                {e.summary && <span className="record-summary">{e.summary}</span>}
                <time className="record-time tabular" dateTime={e.at}>
                  {new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                </time>
              </li>
            ))}
          </ol>
        </section>
          )}
        </Tabs>
      </div>
    </section>
  );
}

/** The most the next counteroffer may concede: the approved step, capped by the discount the other side has earned. */
function nextConcession(insights: NonNullable<OperatorView["insights"]>, counterparty: string): string {
  const { nextStepCap, allowance } = insights.strategy;
  const cap = nextStepCap === null ? null : Math.min(nextStepCap, allowance ? allowance.remaining : nextStepCap);
  if (allowance && allowance.remaining <= 0) {
    return insights.counterparty.bestOffer === null ? `None until the ${counterparty} makes an offer` : `None until the ${counterparty} improves their offer`;
  }
  if (cap === null) return "Half the distance to your limit";
  return cap > 0 ? `Up to ${formatAmount(insights, cap)}` : "None left";
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="figure">
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

/**
 * Tabs in the WAI-ARIA pattern: arrow keys, Home and End move between tabs (roving focus), and the
 * current tab's underline springs to the next one.
 */
function Tabs<T extends string>({ label, value, onChange, tabs, children }: { label: string; value: T; onChange: (t: T) => void; tabs: Array<{ id: T; label: string }>; children: ReactNode }) {
  const base = useId();
  const reduced = useReducedMotion();
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value);
    const next = event.key === "ArrowRight" ? (i + 1) % tabs.length : event.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const t = tabs[next]!.id;
    onChange(t);
    refs.current.get(t)?.focus();
  };
  return (
    <div className="tabs">
      <div className="tab-list" role="tablist" aria-label={label} onKeyDown={move}>
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={value === t.id}
            aria-controls={`${base}-panel`}
            tabIndex={value === t.id ? 0 : -1}
            className="tab"
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {value === t.id && <motion.span layoutId={`${base}-underline`} className="tab-underline" transition={reduced ? { duration: 0 } : { type: "spring", duration: 0.3, bounce: 0 }} aria-hidden="true" />}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${value}`}>
        {children}
      </div>
    </div>
  );
}
