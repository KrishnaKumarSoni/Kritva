/**
 * Who Kritva negotiates with for one mandate: the people the principal listed, in the chat or here,
 * with their numbers kept private to the principal. From here the principal starts the negotiations
 * (Kritva calls everyone with a number when calling out is on, and the others get a private link),
 * calls one person, or opens someone's negotiation.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type BoardRowView, type BoardView, type CounterpartyListView, type MandateState } from "./api.ts";
import { ArrowUpRightIcon, CheckIcon, CopyIcon, PhoneIcon, PlusIcon, TrashIcon } from "./icons.tsx";

const POLL_MS = 4000;
const spring = { type: "spring", duration: 0.3, bounce: 0 } as const;

interface Props {
  /** The saved mandate (library ID), once the chat has prepared it. */
  mandateId: string | null;
  state: MandateState | "new";
  /** People named in the chat before the mandate was saved. */
  pending: Array<{ name: string; hasPhone: boolean }>;
  onOpen: (sessionId: string) => void;
}

/** Where someone's negotiation stands, in a few words. */
function standing(row: BoardRowView | undefined): string | null {
  if (!row) return null;
  if (row.call && row.call.state !== "ended") return row.call.state === "ringing" ? "Ringing…" : row.call.state === "dialling" ? "Calling…" : "On the call";
  if (row.live) return "On a call now";
  const words: Record<BoardRowView["status"], string> = { not_started: "Link sent", talking: "Negotiating", waiting_for_you: "Waiting for your approval", reserved: "Held for them", paused: "Paused", agreed: "Agreed", closed_elsewhere: "Went elsewhere", ended: "Ended" };
  if (row.call?.outcome && row.call.outcome !== "completed" && row.status === "not_started") {
    return { no_answer: "No answer", busy: "Busy", failed: "Call failed", blocked: "Call blocked", cancelled: "Call stopped" }[row.call.outcome] ?? "Call ended";
  }
  return words[row.status];
}

export function CounterpartiesPanel({ mandateId, state, pending, onOpen }: Props) {
  const [list, setList] = useState<CounterpartyListView | null>(null);
  const [board, setBoard] = useState<BoardView | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const reduced = useReducedMotion();
  const current = useRef(mandateId);
  current.current = mandateId;

  const refresh = useCallback(async () => {
    const id = current.current;
    if (!id) return;
    try {
      const [l, b] = await Promise.all([api.deals.counterparties(id), api.deals.board(id)]);
      if (current.current !== id) return;
      setList(l);
      setBoard(b);
    } catch (e) {
      if (current.current === id) setError(e instanceof ApiError ? e.message : "Unable to load the counterparties.");
    }
  }, []);

  useEffect(() => {
    setList(null);
    setBoard(null);
    setError(null);
    setNote(null);
    if (!mandateId) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [mandateId, refresh]);

  const run = async (key: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      await action();
      if (done) setNote(done);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't go through. Try again.");
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!mandateId || !name.trim()) return;
    void run("add", async () => {
      setList(await api.deals.addCounterparty(mandateId, { name: name.trim(), phone: phone.trim() || null }));
      setName("");
      setPhone("");
    });
  };

  const copy = async (sessionId: string) => {
    const row = board?.rows.find((r) => r.sessionId === sessionId);
    await navigator.clipboard.writeText(`${window.location.origin}${row?.link ?? `/?view=buyer#session=${sessionId}`}`).catch(() => undefined);
    setCopied(sessionId);
    window.setTimeout(() => setCopied((c) => (c === sessionId ? null : c)), 1600);
  };

  const live = state === "live";
  const canCall = Boolean(board?.canCall);
  const concluded = Boolean(board?.concluded);
  const waiting = board?.waiting.length ?? 0;
  const entries = list?.entries ?? [];
  const withPhone = entries.filter((e) => e.phone).length;
  const startLabel = waiting === 0 ? "Start negotiations" : canCall && withPhone > 0 ? `Start ${waiting}: call and send links` : `Start ${waiting} ${waiting === 1 ? "negotiation" : "negotiations"}`;
  const callBlocked = !live ? "Make the mandate live to call." : concluded ? "This deal is already agreed." : !canCall ? "Calling out is off on this server (KRITVA_BOARD_CALLS)." : null;

  return (
    <section className="panel counterparties" aria-labelledby="counterparties-title">
      <header className="panel-header">
        <div>
          <h2 id="counterparties-title" className="panel-title">Counterparties</h2>
          <p className="panel-subtitle">
            {mandateId ? `${entries.length} of ${list?.max ?? 5}. Who Kritva negotiates with. Numbers stay with you.` : "Name them in the chat, or add them here once the mandate is prepared."}
          </p>
        </div>
      </header>

      {!mandateId ? (
        pending.length > 0 ? (
          <ul className="people-list">
            {pending.map((p) => (
              <li key={p.name} className="people-row">
                <span className="people-who">
                  <span className="board-name">{p.name}</span>
                  <span className="board-meta">{p.hasPhone ? "Number noted" : "No number"} · added when the mandate is saved</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="board-none">Nobody yet. Tell Kritva in the chat who to contact, like vendors to get quotes from.</p>
        )
      ) : (
        <>
          <ul className="people-list">
            <AnimatePresence initial={false}>
              {entries.map((e) => {
                const row = e.sessionId ? board?.rows.find((r) => r.sessionId === e.sessionId) : undefined;
                const status = standing(row);
                const callable = Boolean(e.phone) && !callBlocked;
                return (
                  <motion.li key={e.id} className="people-row" layout={!reduced} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
                    <span className="people-who">
                      <span className="board-name">{e.name}</span>
                      <span className="board-meta">
                        {e.phone ? `Phone ···${e.phone.replace(/\D/g, "").slice(-4)}` : "No number"}
                        {status ? ` · ${status}` : ""}
                      </span>
                    </span>
                    {e.phone && (
                      <button
                        type="button"
                        className="icon-button"
                        disabled={!callable || busy === `call:${e.id}`}
                        title={callBlocked ?? `Call ${e.name}`}
                        aria-label={`Call ${e.name}`}
                        onClick={() => void run(`call:${e.id}`, () => api.deals.callCounterparty(mandateId, e.id), `Calling ${e.name}…`)}
                      >
                        {busy === `call:${e.id}` ? <span className="spinner" aria-hidden="true" /> : <PhoneIcon />}
                      </button>
                    )}
                    {e.sessionId && (
                      <>
                        <button type="button" className="icon-button" onClick={() => void copy(e.sessionId!)} aria-label={`Copy ${e.name}'s private link`} title="Copy their private link">
                          {copied === e.sessionId ? <CheckIcon /> : <CopyIcon />}
                        </button>
                        <button type="button" className="icon-button" onClick={() => onOpen(e.sessionId!)} aria-label={`Open the negotiation with ${e.name}`} title="Open their negotiation">
                          <ArrowUpRightIcon />
                        </button>
                      </>
                    )}
                    {!e.sessionId && (
                      <button type="button" className="icon-button" disabled={busy === `remove:${e.id}`} onClick={() => void run(`remove:${e.id}`, async () => setList(await api.deals.removeCounterparty(mandateId, e.id)))} aria-label={`Remove ${e.name}`} title="Remove">
                        <TrashIcon />
                      </button>
                    )}
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>

          <form className="people-add" onSubmit={add}>
            <label className="visually-hidden" htmlFor="cp-name">Name</label>
            <input id="cp-name" className="text-input" placeholder="Name" value={name} maxLength={100} onChange={(ev) => setName(ev.target.value)} disabled={entries.length >= (list?.max ?? 5)} autoComplete="off" />
            <label className="visually-hidden" htmlFor="cp-phone">Phone (optional)</label>
            <input id="cp-phone" className="text-input" placeholder="Phone (optional)" type="tel" inputMode="tel" autoComplete="off" value={phone} maxLength={40} onChange={(ev) => setPhone(ev.target.value)} disabled={entries.length >= (list?.max ?? 5)} />
            <button type="submit" className="button button-secondary button-small" disabled={!name.trim() || busy === "add"}>
              <PlusIcon />
              Add
            </button>
          </form>

          <div className="counterparties-start">
            {/* The panel's one primary action, shown only when there is something to start. */}
            {live && waiting > 0 && !concluded && (
            <button
              type="button"
              className="button button-accent"
              disabled={busy === "start"}
              onClick={() => void run("start", () => api.deals.start(mandateId), canCall && withPhone > 0 ? "Started. Kritva is calling everyone with a number; the others have a private link." : "Started. Each has a private link to share.")}
            >
              {busy === "start" && <span className="spinner" aria-hidden="true" />}
              {startLabel}
            </button>
            )}
            <p className="counterparties-hint">
              {!live ? "Make the mandate live to start negotiations." : concluded ? "This deal is agreed." : waiting === 0 ? (entries.length === 0 ? "Add someone to start a negotiation with them." : "Everyone on the list has a negotiation.") : canCall ? "Kritva calls everyone with a number. The others get a private link." : "Each gets a private link. Calling out is off on this server."}
            </p>
          </div>
        </>
      )}

      {(error || note) && (
        <p className={error ? "composer-error counterparties-message" : "counterparties-note"} role={error ? "alert" : "status"}>
          {error ?? note}
        </p>
      )}
    </section>
  );
}
