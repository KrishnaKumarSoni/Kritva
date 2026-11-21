import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, api, type CommitmentsView, type DecisionView, type OfferView } from "./api.ts";
import { CheckIcon, ClockIcon, ShieldIcon } from "./icons.tsx";

const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;

const OUTCOME_LABEL: Record<CommitmentsView["outcome"], string> = {
  negotiating: "Negotiating",
  paused: "Paused",
  pending_approval: "Waiting for your approval",
  agreement: "Agreement reached",
  no_agreement: "No agreement",
};

const WHO: Record<string, string> = { principal: "you", counterparty: "the buyer", agent: "Kritva", system: "the system" };

const KIND_LABEL: Record<string, string> = {
  offer: "Offer",
  enquiry: "Enquiry",
  interest: "Interest",
  counter: "Counteroffer",
  final_terms: "Complete terms",
};

const VERDICT_LABEL: Record<string, string> = {
  acceptable: "Within your limits",
  unacceptable: "Outside your limits",
  needs_clarification: "Needs clarification",
  not_assessed: "Not assessed",
};

/** Statuses that settle or stop an offer read as solid; open ones as outlined. Text always carries the meaning. */
function statusClass(status: string): string {
  if (status === "agreed" || status === "accepted") return "status status-fits";
  if (status === "rejected" || status === "internal") return "status status-conflict";
  if (status === "superseded" || status === "expired" || status === "withdrawn" || status === "corrected") return "status status-muted";
  return "status status-unclear";
}

interface Props {
  sessionId: string;
  view: CommitmentsView;
  onChanged: () => void;
}

/** Operator view of commitments: the outcome, each side's current offer, every offer version and the strategy's recorded actions. */
export function CommitmentsPanel({ sessionId, view, onChanged }: Props) {
  const finished = view.outcome === "agreement" || view.outcome === "no_agreement";
  return (
    <div className="dealspace">
      <OutcomeSection sessionId={sessionId} view={view} finished={finished} onChanged={onChanged} />

      <section className="ds-section" aria-labelledby="cm-current">
        <h3 id="cm-current" className="ds-heading">
          Current offers
        </h3>
        <div className="offer-pair">
          <CurrentOffer title="Buyer's latest" offer={view.currentCounterpartyOffer} empty="The buyer has not offered terms yet." />
          <CurrentOffer title="Seller's current offer" offer={view.currentPrincipalOffer} empty="Only the listing so far." />
        </div>
      </section>

      <section className="ds-section" aria-labelledby="cm-history">
        <h3 id="cm-history" className="ds-heading">
          Offer history
        </h3>
        {view.offers.length === 0 ? (
          <p className="ds-empty">No offers recorded yet.</p>
        ) : (
          <ol className="ds-list" aria-label="Offers, newest first">
            {view.offers.map((o) => (
              <OfferRow key={o.offerId} offer={o} />
            ))}
          </ol>
        )}
      </section>

      <section className="ds-section" aria-labelledby="cm-decisions">
        <h3 id="cm-decisions" className="ds-heading">
          Strategy decisions
        </h3>
        <p className="ds-note">
          Guidance in use: <span className="mono">{view.guidance}</span>. Guidance shapes moves only; your mandate and the outgoing check decide what is sent.
        </p>
        {view.decisions.length === 0 ? (
          <p className="ds-empty">No decisions yet.</p>
        ) : (
          <ol className="ds-list" aria-label="Decisions, newest first">
            {view.decisions.map((d) => (
              <DecisionRow key={d.id} decision={d} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function OutcomeSection({ sessionId, view, finished, onChanged }: { sessionId: string; view: CommitmentsView; finished: boolean; onChanged: () => void }) {
  const reduced = useReducedMotion();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const noteId = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  // Focus moves into the confirmation when it opens, and back to its trigger when it is cancelled.
  useEffect(() => {
    if (confirming) reasonRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      openRef.current?.focus();
    }
  }, [confirming]);
  const cancel = () => {
    returnFocus.current = true;
    setConfirming(false);
  };

  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.endNegotiation(sessionId, reason.trim());
      setConfirming(false);
      setReason("");
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The negotiation could not be ended. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  const stopped = view.stopped;
  return (
    <section className="ds-section" aria-labelledby="cm-outcome">
      <div className="ds-term-head">
        <h3 id="cm-outcome" className="ds-heading">
          Outcome
        </h3>
        <span className={view.outcome === "agreement" ? "status status-fits" : view.outcome === "no_agreement" ? "status status-conflict" : "status status-unclear"}>
          {view.outcome === "agreement" ? <CheckIcon width={12} height={12} /> : view.outcome === "pending_approval" || view.outcome === "paused" ? <ClockIcon width={12} height={12} /> : null}
          {OUTCOME_LABEL[view.outcome]}
        </span>
      </div>

      {view.outcome === "negotiating" && <p className="ds-empty">No agreement yet. Nothing is agreed until the buyer confirms complete terms and you approve them.</p>}
      {view.outcome === "pending_approval" && <p className="ds-empty">The buyer confirmed terms. There is no agreement until you approve them above.</p>}
      {view.outcome === "paused" && (
        <p className="ds-empty">
          Paused{stopped?.by ? ` by ${WHO[stopped.by] ?? stopped.by}` : ""}. The last offers stay as they were and nothing new reaches the buyer until you resume.
        </p>
      )}

      {view.agreement && (
        <div className="ds-card">
          <ul className="offer-terms">
            {view.agreement.terms.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p className="ds-subheading">Still to do</p>
          <ul className="obligations">
            {view.agreement.obligations.map((o) => (
              <li key={o}>
                <ClockIcon width={14} height={14} />
                <span>{o}</span>
                <span className="chip">Pending</span>
              </li>
            ))}
          </ul>
          <p className="ds-note">{view.agreement.approved ? "You approved these exact terms." : "Your mandate let Kritva accept these terms."} Payment and pickup are arranged outside Kritva.</p>
        </div>
      )}

      {view.outcome === "no_agreement" && (
        <div className="ds-card">
          <p className="ds-term-value">
            Ended by {stopped?.by ? (WHO[stopped.by] ?? stopped.by) : "an unknown party"}
            {stopped?.reason ? `: ${stopped.reason}` : "."}
          </p>
          {stopped && stopped.unresolved.length > 0 && <p className="ds-term-value">Left open: {stopped.unresolved.join(", ")}.</p>}
          {view.noAgreement && <LastOffers summary={view.noAgreement} />}
        </div>
      )}

      {!finished && (
        <div className="end-control">
          <AnimatePresence initial={false} mode="popLayout">
            {!confirming ? (
              <motion.div key="open" initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
                <button ref={openRef} type="button" className="button button-secondary" onClick={() => setConfirming(true)}>
                  End negotiation…
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="confirm"
                className="end-confirm"
                role="group"
                aria-labelledby={`${noteId}-title`}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && !busy) cancel();
                }}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={spring}
              >
                <p id={`${noteId}-title`} className="ds-term-name">
                  End without agreement?
                </p>
                <p id={noteId} className="ds-note">
                  Kritva tells the buyer you won't be going ahead. Offers stop, and this session can't be reopened.
                </p>
                <label htmlFor={reasonId} className="ds-subheading">
                  Reason, for your record (optional)
                </label>
                <textarea ref={reasonRef} id={reasonId} className="mandate-text end-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={noteId} placeholder="For example: decided to keep it" />
                {error && (
                  <p className="composer-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="approval-actions">
                  <button type="button" className="button button-neutral" disabled={busy} onClick={end}>
                    {busy ? <span className="spinner" aria-hidden="true" /> : null}
                    End without agreement
                  </button>
                  <button type="button" className="button button-secondary" disabled={busy} onClick={cancel}>
                    Keep negotiating
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

export function LastOffers({ summary }: { summary: { lastPrincipalOffer: string[]; lastCounterpartyOffer: string[]; differences: string[] } }) {
  return (
    <>
      <div className="offer-pair">
        <div>
          <p className="ds-subheading">Seller's last offer</p>
          {summary.lastPrincipalOffer.length > 0 ? (
            <ul className="offer-terms">
              {summary.lastPrincipalOffer.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : (
            <p className="ds-empty">Only the listing.</p>
          )}
        </div>
        <div>
          <p className="ds-subheading">Buyer's last offer</p>
          {summary.lastCounterpartyOffer.length > 0 ? (
            <ul className="offer-terms">
              {summary.lastCounterpartyOffer.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : (
            <p className="ds-empty">No offer made.</p>
          )}
        </div>
      </div>
      {summary.differences.length > 0 && <p className="ds-term-value">Main difference: {summary.differences.join("; ")}.</p>}
    </>
  );
}

function CurrentOffer({ title, offer, empty }: { title: string; offer: OfferView | null; empty: string }) {
  return (
    <div className="ds-card offer-card">
      <div className="ds-term-head offer-card-head">
        <p className="ds-subheading">{title}</p>
        {offer && <span className={statusClass(offer.status)}>{offer.statusLabel}</span>}
      </div>
      {offer ? (
        <>
          <ul className="offer-terms">
            {offer.terms.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          {offer.conditions.length > 0 && <p className="ds-note">Depends on: {offer.conditions.join("; ")}</p>}
          <p className="ds-note">
            {KIND_LABEL[offer.kind] ?? offer.kind}, version {offer.version}
          </p>
        </>
      ) : (
        <p className="ds-empty">{empty}</p>
      )}
    </div>
  );
}

function OfferRow({ offer }: { offer: OfferView }) {
  const reduced = useReducedMotion();
  return (
    <motion.li className="ds-term" layout={!reduced} initial={false} transition={spring}>
      <div className="ds-term-head">
        <p className="ds-term-name">
          {offer.party === "counterparty" ? "Buyer" : "Seller"} · {KIND_LABEL[offer.kind] ?? offer.kind} <span className="offer-version">v{offer.version}</span>
        </p>
        <span className={statusClass(offer.status)}>{offer.statusLabel}</span>
      </div>
      <p className="ds-term-value tabular">{offer.terms.map(capitalize).join(" · ")}</p>
      {offer.conditions.length > 0 && <p className="ds-note">Depends on: {offer.conditions.join("; ")}</p>}
      {offer.blocked && (
        <p className="ds-warning">
          <ShieldIcon width={14} height={14} />
          Held back by the outgoing check. The buyer never received it.
        </p>
      )}
      {offer.approval !== "none" && <p className="ds-note">Your approval: {offer.approval === "requested" ? "requested" : offer.approval}.</p>}
      <p className="ds-note">
        <time dateTime={offer.at}>{new Date(offer.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time> · Mandate revision {offer.mandateRevision}
      </p>
    </motion.li>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function DecisionRow({ decision }: { decision: DecisionView }) {
  return (
    <li className="ds-term">
      <div className="ds-term-head">
        <p className="ds-term-name">{decision.actionLabel ?? "Decision"}</p>
        <time className="event-time" dateTime={decision.at}>
          {new Date(decision.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
        </time>
      </div>
      <p className="ds-term-value">{decision.reason}</p>
      {decision.assessment && (
        <details className="assessment">
          <summary>
            Assessment: {VERDICT_LABEL[decision.assessment.verdict] ?? decision.assessment.verdict}
          </summary>
          <ul className="ds-rules">
            {decision.assessment.drivers.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
