import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";
import { api, ApiError, type Decision, type EditableTerm, type FollowUpView, type OperatorState, type TermValue } from "./api.ts";
import { ClockIcon, PhoneIcon, PlayIcon } from "./icons.tsx";

const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Extra = { message?: string; counterTerms?: Array<{ termId: string; value: TermValue }> };

interface ApprovalCardProps {
  sessionId: string;
  state: OperatorState;
  roles: { principal: string; counterparty: string };
  responding: boolean;
  onDecide: (requestId: string, decision: Decision, extra: Extra) => Promise<boolean>;
}

/** "in 3 h" / "20 min ago": how far a time is from now, in words. */
function relative(iso: string, now: number): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  return Math.abs(hours) < 48 ? format.format(hours, "hour") : format.format(Math.round(hours / 24), "day");
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

/** The minute, for times that read "in 3 h". Updates once a minute while the card is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** How to reach the other party, in the seller's words. */
function reachLine(f: FollowUpView, counterparty: string): string | null {
  if (f.contact === "call") return f.phone ? `A call on ${f.phone}` : "A call (number not given yet)";
  if (f.contact === "whatsapp") return f.phone ? `WhatsApp on ${f.phone}. WhatsApp isn't connected yet, so Kritva will call.` : "WhatsApp (number not given yet)";
  if (f.contact === "chat") return `Here in the ${counterparty}'s chat`;
  return null;
}

const FOLLOW_UP_STATUS: Record<NonNullable<FollowUpView["status"]>, string | null> = {
  following_up: "Kritva is telling them now.",
  calling: "Kritva is calling them now.",
  retrying: "No answer. Kritva will try once more.",
  waiting_for_yes: "Kritva told them. Waiting for their yes.",
  declined: "Kritva told them you can't do it.",
  lapsed: "Lapsed: no answer after two tries. Nothing was agreed.",
  ended: "Ended without agreement.",
  agreed: null,
};

/**
 * The seller's approval card: the exact terms, what Kritva learned for following up (how long the
 * offer stands, how and when to reach them, the call recording), and approve, counter or decline.
 * Nothing is agreed here: after an approval Kritva asks the other party again.
 */
export function ApprovalCard({ sessionId, state, roles, responding, onDecide }: ApprovalCardProps) {
  const reduced = useReducedMotion();
  const now = useNow();
  const pending = state.pendingApproval!;
  const f = state.followUp ?? null;
  const [message, setMessage] = useState("");
  const [countering, setCountering] = useState(false);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const messageId = useId();
  const recording = (state.recordings ?? []).at(-1) ?? null;

  // A second click confirms the decline; it un-arms itself after a few seconds.
  useEffect(() => {
    if (!confirmDecline) return;
    const timer = setTimeout(() => setConfirmDecline(false), 4_000);
    return () => clearTimeout(timer);
  }, [confirmDecline]);

  const decide = async (decision: Decision, extra: Extra = {}) => {
    const sent = await onDecide(pending.requestId, decision, { ...extra, message: message.trim() || undefined });
    if (sent) {
      setMessage("");
      setCountering(false);
    }
  };

  const expired = f?.validUntil ? Date.parse(f.validUntil) < now : false;
  const reach = f ? reachLine(f, roles.counterparty) : null;
  const enter = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 } } : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } };

  return (
    <div className="approval">
      {f?.supersededTerms && (
        <p className="approval-changed" role="status">
          <strong>Terms changed, approve again.</strong> The earlier request was for {f.supersededTerms.map((t) => `${t.name} ${t.value}`).join(", ")}.
        </p>
      )}
      <p className="callout-text">{pending.requestedAction}</p>
      {pending.terms && (
        <dl className="kv">
          {pending.terms.map((t) => (
            <div key={t.termId} className="kv-row">
              <dt>{cap(t.name)}</dt>
              <dd className="tabular">{t.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {pending.breachedRules.length > 0 && <p className="callout-note">Outside your instructions: {pending.breachedRules.join("; ")}</p>}

      <section className="approval-facts" aria-label="For following up">
        <dl className="kv">
          <div className="kv-row">
            <dt>Offer stands</dt>
            <dd>
              {f?.validity ? (
                <>
                  <span>“{f.validity}”</span>
                  {f.validUntil && (
                    <span className={`approval-when ${expired ? "is-expired" : ""}`}>
                      {expired ? `Time passed ${relative(f.validUntil, now)}. Kritva will check it still stands.` : `Until ${clock(f.validUntil)}, ${relative(f.validUntil, now)}`}
                    </span>
                  )}
                </>
              ) : (
                <span className="approval-missing">Not said yet</span>
              )}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Reach them</dt>
            <dd>{reach ?? <span className="approval-missing">Not said yet. Kritva will reply in the chat.</span>}</dd>
          </div>
          {f?.bestTime && (
            <div className="kv-row">
              <dt>Best time</dt>
              <dd>“{f.bestTime}”</dd>
            </div>
          )}
        </dl>
        {recording && <Recording key={recording.id} sessionId={sessionId} recordingId={recording.id} durationMs={recording.durationMs} />}
      </section>

      <div className="field">
        <label htmlFor={messageId}>Message for the {roles.counterparty} (optional)</label>
        <textarea id={messageId} className="approval-message" rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="For example: Thanks for your patience!" />
        <p className="field-hint">Kritva passes it on in its own words, with your decision.</p>
      </div>

      <AnimatePresence initial={false} mode="popLayout">
        {countering ? (
          <motion.div key="counter" {...enter} exit={{ opacity: 0 }} transition={spring}>
            <CounterEditor terms={pending.editable ?? []} responding={responding} onCancel={() => setCountering(false)} onSend={(counterTerms) => decide("countered", { counterTerms })} />
          </motion.div>
        ) : (
          <motion.div key="actions" className="callout-actions approval-actions" {...enter} exit={{ opacity: 0 }} transition={spring}>
            <button type="button" className="button button-accent" disabled={responding} onClick={() => void decide("approved")}>
              Approve
            </button>
            <button type="button" className="button button-secondary" disabled={responding || !(pending.editable?.length)} onClick={() => setCountering(true)}>
              Counter
            </button>
            <button
              type="button"
              className={`button ${confirmDecline ? "button-danger" : "button-secondary"}`}
              disabled={responding}
              aria-live="polite"
              onClick={() => (confirmDecline ? void decide("declined") : setConfirmDecline(true))}
            >
              {confirmDecline ? "Confirm decline" : "Decline"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <p className="field-hint">Approving doesn't close the deal: Kritva asks the {roles.counterparty} again, and only their yes records it.</p>
    </div>
  );
}

/** A counter: the same terms, with the ones the seller changes. */
function CounterEditor({ terms, responding, onCancel, onSend }: { terms: EditableTerm[]; responding: boolean; onCancel: () => void; onSend: (changes: Array<{ termId: string; value: TermValue }>) => void }) {
  const [values, setValues] = useState<Record<string, TermValue>>(() => Object.fromEntries(terms.map((t) => [t.termId, t.value])));
  const [error, setError] = useState<string | null>(null);
  const baseId = useId();
  const set = (termId: string, value: TermValue) => {
    setError(null);
    setValues((v) => ({ ...v, [termId]: value }));
  };

  const send = () => {
    const changes = terms.filter((t) => JSON.stringify(values[t.termId]) !== JSON.stringify(t.value)).map((t) => ({ termId: t.termId, value: values[t.termId]! }));
    const bad = changes.find((c) => (c.value.type === "money" || c.value.type === "quantity") && !(c.value.amount > 0));
    if (bad) return setError("Enter an amount above zero.");
    if (changes.some((c) => (c.value.type === "text" || c.value.type === "date_text") && !c.value.value.trim())) return setError("A term can't be left empty.");
    if (changes.length === 0) return setError("Change at least one term, or approve the offer as it is.");
    onSend(changes);
  };

  // The negotiated price first, then the rest in the offer's order.
  const ordered = [...terms].sort((a, b) => Number(b.negotiated) - Number(a.negotiated));
  return (
    <div className="counter" role="group" aria-labelledby={`${baseId}-title`}>
      <h4 id={`${baseId}-title`} className="counter-title">Your counter</h4>
      {ordered.map((t) => {
        const id = `${baseId}-${t.termId}`;
        const v = values[t.termId]!;
        if (v.type === "boolean") {
          return (
            <div key={t.termId} className="field">
              <span className="counter-label" id={id}>{cap(t.name)}</span>
              <div className="segmented" role="group" aria-labelledby={id}>
                {[true, false].map((option) => (
                  <button key={String(option)} type="button" className="segmented-option" aria-pressed={v.value === option} onClick={() => set(t.termId, { type: "boolean", value: option })}>
                    {option ? "Yes" : "No"}
                  </button>
                ))}
              </div>
            </div>
          );
        }
        if (v.type === "money" || v.type === "quantity") {
          return (
            <div key={t.termId} className="field">
              <label htmlFor={id}>{cap(t.name)}</label>
              <div className="counter-amount">
                {v.type === "money" && <span aria-hidden="true">{v.currency === "INR" ? "₹" : v.currency}</span>}
                <input
                  id={id}
                  className="text-input tabular"
                  inputMode="numeric"
                  autoFocus={t.negotiated}
                  value={Number.isFinite(v.amount) ? String(v.amount) : ""}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/[^\d]/g, "");
                    set(t.termId, { ...v, amount: digits ? Number(digits) : NaN });
                  }}
                />
              </div>
            </div>
          );
        }
        return (
          <div key={t.termId} className="field">
            <label htmlFor={id}>{cap(t.name)}</label>
            <input id={id} className="text-input" value={v.value} maxLength={200} onChange={(e) => set(t.termId, { ...v, value: e.target.value })} />
          </div>
        );
      })}
      {error && (
        <p className="counter-error" role="alert">
          {error}
        </p>
      )}
      <div className="callout-actions">
        <button type="button" className="button button-accent" disabled={responding} onClick={send}>
          Send counter
        </button>
        <button type="button" className="button button-ghost" disabled={responding} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="field-hint">Kritva puts these terms to them. If they say yes, it comes back to you to approve.</p>
    </div>
  );
}

/** A call recording: fetched on demand (the console's routes need the seller key), then played inline. */
function Recording({ sessionId, recordingId, durationMs }: { sessionId: string; recordingId: string; durationMs: number | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setUrl(URL.createObjectURL(await api.recording(sessionId, recordingId)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The recording couldn't be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  };
  const length = durationMs ? `${Math.floor(durationMs / 60_000)}:${String(Math.round((durationMs % 60_000) / 1000)).padStart(2, "0")}` : null;
  if (url) return <audio className="approval-audio" controls autoPlay src={url} aria-label="Call recording" />;
  return (
    <div className="approval-recording">
      <button type="button" className="button button-secondary" disabled={loading} onClick={() => void load()}>
        <PlayIcon width={16} height={16} aria-hidden="true" />
        {loading ? "Loading recording" : `Play the call recording${length ? ` (${length})` : ""}`}
      </button>
      {error && <p className="counter-error" role="alert">{error}</p>}
    </div>
  );
}

/** After the decision: where the follow-up stands. */
export function FollowUpStatus({ followUp, roles }: { followUp: FollowUpView; roles: { counterparty: string } }) {
  const status = followUp.status ? FOLLOW_UP_STATUS[followUp.status] : null;
  if (!followUp.decision || !status) return null;
  const word = followUp.decision.decision === "approved" ? "approved" : followUp.decision.decision === "countered" ? "countered" : "declined";
  const Icon = followUp.status === "calling" || followUp.status === "retrying" ? PhoneIcon : ClockIcon;
  return (
    <section className="callout" aria-labelledby="follow-up-title">
      <h3 id="follow-up-title" className="section-title">
        <Icon width={16} height={16} aria-hidden="true" />
        Following up with the {roles.counterparty}
      </h3>
      <p className="callout-text">
        You {word} at {clock(followUp.decision.at)}. {status}
      </p>
    </section>
  );
}
