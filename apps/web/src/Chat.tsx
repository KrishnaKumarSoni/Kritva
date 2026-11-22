import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { BuyerMessage, BuyerView, Roles, TermView } from "./api.ts";
import { AlertIcon, BackIcon, CheckIcon, ClockIcon, EyeIcon, SendIcon } from "./icons.tsx";
import { VoiceBar } from "./VoiceBar.tsx";

const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;

interface ChatProps {
  view: BuyerView | null;
  pending: { id: string; text: string } | null;
  sending: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onRetry: (() => void) | null;
  onDisplayed: (messageIds: string[]) => void;
  /** True on the counterparty's own page: say plainly that they are talking to an AI. */
  disclose?: boolean;
  /** Browser voice for this session (Epic 13). Omit to offer text only. */
  voice?: { sessionId: string | null; startRequest?: number; onTurn: () => void } | null;
  /** The principal's console: the panel's own title and line, and a way back to the log. */
  heading?: { title: string; subtitle: string; onBack: (() => void) | null } | null;
  /**
   * A real negotiation the principal is watching: the conversation is shown as it happened, and the
   * principal never writes or speaks as the other side.
   */
  readOnly?: boolean;
}

export function Chat({ view, pending, sending, error, onSend, onRetry, onDisplayed, voice = null, disclose = false, heading = null, readOnly = false }: ChatProps) {
  const [draft, setDraft] = useState("");
  const [voiceOn, setVoiceOn] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reduced = useReducedMotion();
  const messages = view?.messages ?? [];
  const unsaved = pending && !messages.some((message) => message.id === pending.id) ? pending : null;
  const bubbles = unsaved ? [...messages, unsaved] : messages;
  const roles: Roles = view?.roles ?? { principal: "principal", counterparty: "other party" };

  // Report agent replies as delivered once they are on screen. Only then does an offer count as communicated.
  useEffect(() => {
    // Spoken replies count as delivered only when their audio finishes; the voice bar reports those.
    const shown = messages.filter((m) => m.from === "agent" && m.channel !== "voice").map((m) => m.id);
    if (shown.length > 0) onDisplayed(shown);
  }, [messages, onDisplayed]);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [messages.length, pending, sending, reduced, view?.outcome.kind]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending || voiceOn) return;
    onSend(text);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  // New messages grow in from their own side (see .bubble-row transform-origin); reduced motion only fades.
  const enter = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 } } : { initial: { opacity: 0, y: 6, scale: 0.97 }, animate: { opacity: 1, y: 0, scale: 1 } };

  return (
    <section className="panel" aria-labelledby="chat-title">
      <header className="panel-header chat-header">
        {heading?.onBack && (
          <button type="button" className="icon-button back-button" onClick={heading.onBack} aria-label="All negotiations">
            <BackIcon />
          </button>
        )}
        <div className="chat-heading">
          <h2 className="panel-title" id="chat-title">
            {heading?.title ?? "Conversation"}
          </h2>
          <p className="panel-subtitle">
            {heading?.subtitle ?? (disclose ? `Kritva is an AI negotiating for the ${roles.principal}. Anything agreed is confirmed with them.` : `You write as the ${roles.counterparty}. Kritva replies for the ${roles.principal}.`)}
          </p>
        </div>
      </header>

      <div className="chat-log" ref={logRef} role="log" aria-label="Conversation" aria-live="polite">
        {messages.length === 0 && !unsaved ? (
          <div className="empty">
            <p>{readOnly ? "Nothing has been said yet." : disclose ? "Send a message to start." : `Write the first message as the ${roles.counterparty}.`}</p>
          </div>
        ) : null}
        <AnimatePresence initial={false}>
          {bubbles.map((m) => (
            <Bubble key={m.id} message={m} enter={enter} roles={roles} theirs={readOnly ? cap(roles.counterparty) : "You"} />
          ))}
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
              <OutcomeCard outcome={view.outcome} roles={roles} watching={readOnly} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {readOnly ? (
        <p className="watching">
          <EyeIcon />
          Kritva negotiates this one for you. You're seeing it as it happens.
        </p>
      ) : (
        <>
      {voice?.sessionId && <VoiceBar sessionId={voice.sessionId} messages={messages} paused={view?.paused ?? false} startRequest={voice.startRequest} onActiveChange={setVoiceOn} onTurn={voice.onTurn} />}

      <form className="composer" onSubmit={submit} aria-disabled={voiceOn}>
        <label className="composer-label" htmlFor="buyer-message">
          {voiceOn ? "Typing is off during the voice call. End voice to type." : `Your message as the ${roles.counterparty}`}
        </label>
        <div className="composer-row">
          <textarea
            id="buyer-message"
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder={voiceOn ? "Voice call in progress" : "Ask a question or propose terms"}
            disabled={voiceOn || !view}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={2000}
            aria-describedby={error ? "composer-error composer-hint" : "composer-hint"}
            autoComplete="off"
          />
          <button type="submit" className="button button-accent" disabled={!view || sending || voiceOn || draft.trim().length === 0}>
            {sending ? <span className="spinner" aria-hidden="true" /> : <SendIcon />}
            Send
          </button>
        </div>
        {error ? (
          <div className="composer-error" id="composer-error" role="alert">
            <AlertIcon />
            <span style={{ flex: 1 }}>{error}</span>
            {onRetry && (
              <button type="button" className="button button-secondary button-small" onClick={onRetry} disabled={sending || voiceOn}>
                Retry message
              </button>
            )}
          </div>
        ) : null}
        <p className="composer-hint" id="composer-hint">
          Press Enter to send, Shift+Enter for a new line.
        </p>
      </form>
        </>
      )}
    </section>
  );
}

/** One message. "theirs" labels the other side's messages: "You" in a test, their role when watching. */
function Bubble({ message, enter, roles, theirs }: { message: BuyerMessage | { id: string; text: string }; enter: object; roles: Roles; theirs: string }) {
  const saved = "at" in message;
  const time = saved ? new Date(message.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  return (
    <motion.div className={`bubble-row ${saved ? `from-${message.from}` : "from-buyer bubble-pending"}`} {...enter} transition={spring}>
      <div className="bubble">{message.text}</div>
      <span className="bubble-meta">
        {saved ? (
          <>
            {message.from === "agent" ? `Kritva for the ${roles.principal}` : theirs}
            {message.channel === "voice" ? " · voice" : ""} · <time dateTime={message.at}>{time}</time>
          </>
        ) : "Sending…"}
      </span>
    </motion.div>
  );
}

export function OutcomeCard({ outcome, roles, watching = false }: { outcome: BuyerView["outcome"]; roles: Roles; watching?: boolean }) {
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
        {outcome.subject && <p>{outcome.subject}</p>}
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
        <p className="outcome-note">These terms are agreed. Any outstanding steps are listed above.</p>
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
          <h3 id="outcome-title">Waiting for the {roles.principal}'s approval</h3>
        </div>
        <TermsList terms={terms} />
        <p className="outcome-note">You confirmed these terms. There is no agreement until the {roles.principal} approves them.</p>
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
              <dt>{cap(roles.principal)}'s last offer</dt>
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
        {summary?.endedBy === "counterparty" ? (watching ? `The ${roles.counterparty} ended the conversation.` : "You ended the conversation.") : summary?.endedBy === "principal" ? `The ${roles.principal} decided not to go ahead.` : "No terms worked for both sides."} Nothing was agreed.
      </p>
    </section>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
