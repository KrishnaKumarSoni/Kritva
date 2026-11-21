import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { BuyerMessage, BuyerView, TermView } from "./api.ts";
import { AlertIcon, CheckIcon, ClockIcon, SendIcon, SparkIcon } from "./icons.tsx";

const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;

const SUGGESTIONS = ["Is it still available?", "Would you take ₹17,000?", "Can you deliver it?", "What's your lowest price?"];

interface ChatProps {
  view: BuyerView | null;
  pending: { text: string } | null;
  sending: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onRetry: (() => void) | null;
  onDisplayed: (messageIds: string[]) => void;
}

export function Chat({ view, pending, sending, error, onSend, onRetry, onDisplayed }: ChatProps) {
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reduced = useReducedMotion();
  const messages = view?.messages ?? [];
  const listing = view?.listing ?? null;

  // Report agent replies as delivered once they are on screen. Only then does an offer count as communicated.
  useEffect(() => {
    const shown = messages.filter((m) => m.from === "agent").map((m) => m.id);
    if (shown.length > 0) onDisplayed(shown);
  }, [messages, onDisplayed]);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [messages.length, pending, sending, reduced, view?.outcome.kind]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    onSend(text);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const enter = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 } } : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } };

  return (
    <section className="panel" aria-labelledby="chat-title">
      <header className="panel-header">
        <div>
          <h2 className="panel-title" id="chat-title">
            Buyer chat
          </h2>
          <p className="panel-subtitle">You are the buyer. Kritva replies for the seller, using the saved mandate.</p>
          {listing && (
            <ul className="listing" aria-label="Listing">
              {listing.terms.map((t) => (
                <li key={t.termId} className="chip">
                  <span className="term-name">{`${t.name}: `}</span>
                  <span className="tabular">{t.value}</span>
                </li>
              ))}
              {listing.facts.map((f) => (
                <li key={f} className="chip">
                  {f}
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>

      <p className="ai-notice" role="note">
        <SparkIcon width={16} height={16} />
        <span>
          <strong>You're chatting with Kritva, an AI.</strong> It negotiates for the seller and isn't the seller or a person. Anything agreed is confirmed with the seller.
        </span>
      </p>

      <div className="chat-log" ref={logRef} role="log" aria-label="Conversation" aria-live="polite">
        {messages.length === 0 && !pending ? (
          <div className="empty">
            <h3>Start the negotiation</h3>
            <p>Write to the seller as a buyer would. Every message, offer and decision appears in the record beside this chat.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="button button-secondary" onClick={() => setDraft(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <Bubble key={m.id} message={m} enter={enter} />
          ))}
          {pending && (
            <motion.div key="pending" className="bubble-row from-buyer bubble-pending" {...enter} transition={spring}>
              <div className="bubble">{pending.text}</div>
              <span className="bubble-meta">Sending…</span>
            </motion.div>
          )}
          {sending && (
            <motion.div key="typing" className="typing" {...enter} exit={{ opacity: 0 }} transition={spring}>
              <span className="typing-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              Kritva is replying
            </motion.div>
          )}
          {view && view.outcome.kind !== "in_progress" && (
            <motion.div key={`outcome-${view.outcome.kind}`} {...enter} exit={{ opacity: 0 }} transition={spring}>
              <OutcomeCard outcome={view.outcome} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <form className="composer" onSubmit={submit}>
        <label className="composer-label" htmlFor="buyer-message">
          Your message as the buyer
        </label>
        <div className="composer-row">
          <textarea
            id="buyer-message"
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder="e.g. Hi, is the bed still available?"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={2000}
            aria-describedby={error ? "composer-error composer-hint" : "composer-hint"}
            autoComplete="off"
          />
          <button type="submit" className="button button-accent" disabled={sending || draft.trim().length === 0}>
            {sending ? <span className="spinner" aria-hidden="true" /> : <SendIcon />}
            Send
          </button>
        </div>
        {error ? (
          <div className="composer-error" id="composer-error" role="alert">
            <AlertIcon />
            <span style={{ flex: 1 }}>{error}</span>
            {onRetry && (
              <button type="button" className="button button-secondary" onClick={onRetry} disabled={sending} style={{ minHeight: 32 }}>
                Retry message
              </button>
            )}
          </div>
        ) : null}
        <p className="composer-hint" id="composer-hint">
          Press Enter to send, Shift+Enter for a new line.
        </p>
      </form>
    </section>
  );
}

function Bubble({ message, enter }: { message: BuyerMessage; enter: object }) {
  const time = new Date(message.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <motion.div className={`bubble-row from-${message.from}`} {...enter} transition={spring}>
      <div className="bubble">{message.text}</div>
      <span className="bubble-meta">
        {message.from === "agent" ? "Kritva (AI) for the seller" : "You"} · <time dateTime={message.at}>{time}</time>
      </span>
    </motion.div>
  );
}

export function OutcomeCard({ outcome }: { outcome: BuyerView["outcome"] }) {
  const { kind, terms } = outcome;
  if (kind === "agreement") {
    return (
      <section className="outcome outcome-agreement" aria-labelledby="outcome-title">
        <div className="outcome-head">
          <span className="outcome-icon">
            <CheckIcon />
          </span>
          <h3 id="outcome-title">Agreement</h3>
        </div>
        <TermsList terms={terms} />
        {outcome.obligations.length > 0 && (
          <div className="outcome-todo">
            <p className="outcome-todo-title">Still to do</p>
            <ul>
              {outcome.obligations.map((o) => (
                <li key={o}>
                  <ClockIcon width={14} height={14} />
                  <span>{o}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="outcome-note">You accepted these terms and the seller approved them. Payment and pickup are pending and arranged between you directly.</p>
      </section>
    );
  }
  if (kind === "pending_approval") {
    return (
      <section className="outcome outcome-pending" aria-labelledby="outcome-title">
        <div className="outcome-head">
          <span className="outcome-icon">
            <ClockIcon />
          </span>
          <h3 id="outcome-title">Waiting for the seller's approval</h3>
        </div>
        <TermsList terms={terms} />
        <p className="outcome-note">You confirmed these terms. There is no agreement until the seller approves them.</p>
      </section>
    );
  }
  const summary = outcome.noAgreement;
  return (
    <section className="outcome outcome-pending" aria-labelledby="outcome-title">
      <div className="outcome-head">
        <h3 id="outcome-title">No agreement</h3>
      </div>
      {summary && (summary.lastPrincipalOffer.length > 0 || summary.lastCounterpartyOffer.length > 0) && (
        <dl className="terms">
          {summary.lastPrincipalOffer.length > 0 && (
            <div style={{ display: "contents" }}>
              <dt>Seller's last offer</dt>
              <dd>{summary.lastPrincipalOffer.map(capitalize).join(" · ")}</dd>
            </div>
          )}
          {summary.lastCounterpartyOffer.length > 0 && (
            <div style={{ display: "contents" }}>
              <dt>Your last offer</dt>
              <dd>{summary.lastCounterpartyOffer.map(capitalize).join(" · ")}</dd>
            </div>
          )}
        </dl>
      )}
      <p className="outcome-note">
        {summary?.endedBy === "counterparty" ? "You ended the conversation." : summary?.endedBy === "principal" ? "The seller decided not to go ahead." : "No terms worked for both sides."} Nothing was agreed.
      </p>
    </section>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function TermsList({ terms }: { terms: TermView[] | null }) {
  if (!terms) return null;
  return (
    <dl className="terms">
      {terms.map((t) => (
        <div key={t.termId} style={{ display: "contents" }}>
          <dt>{t.name}</dt>
          <dd>{t.value}</dd>
        </div>
      ))}
    </dl>
  );
}
