/**
 * Who Kritva negotiates with for one mandate: the people the principal listed, in the chat or here,
 * with their numbers kept private to the principal. Once the mandate is live, one action calls
 * everyone on the list from Kritva's phone number (people without a number get a private link).
 * The server decides who that reaches, and reaches each person once, however often it is pressed.
 * From here the principal can also call one person, copy a link, or open someone's negotiation.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type BoardRowView, type BoardView, type CampaignView, type CounterpartyListView, type MandateState } from "./api.ts";
import { ArrowUpRightIcon, CheckIcon, CopyIcon, PhoneIcon, PlusIcon, TrashIcon } from "./icons.tsx";

const POLL_MS = 4000;
const spring = { type: "spring", duration: 0.3, bounce: 0 } as const;

interface Props {
  /** The saved mandate (library ID), once the chat has prepared it. */
  mandateId: string | null;
  state: MandateState | "new";
  /** People named in the chat before the mandate was saved. */
  pending: Array<{ name: string; hasPhone: boolean }>;
  /** The mandate's title: each mandate has its own list. */
  title: string;
  onOpen: (sessionId: string) => void;
}

/** Where someone's negotiation stands, in a few words. */
function standing(row: BoardRowView | undefined): string | null {
  if (!row) return null;
  if (row.call && row.call.state !== "ended") {
    return { queued: "Waiting for a free line", dialling: "Calling…", ringing: "Ringing…", answered: "On the call", connected: "On the call" }[row.call.state];
  }
  if (row.live) return "On a call now";
  const words: Record<BoardRowView["status"], string> = { not_started: "Link sent", talking: "Negotiating", waiting_for_you: "Waiting for your approval", reserved: "Held for them", paused: "Paused", agreed: "Agreed", closed_elsewhere: "Went elsewhere", ended: "Ended" };
  if (row.call?.outcome && row.call.outcome !== "completed" && row.status === "not_started") {
    return { no_answer: "No answer", busy: "Busy", failed: "Call failed", blocked: "Call blocked", cancelled: "Call stopped" }[row.call.outcome] ?? "Call ended";
  }
  if (row.call && row.status === "not_started") return "Called";
  return words[row.status];
}

/** "Ravi", "Ravi and Asha", "Ravi, Asha and Meera", "Ravi, Asha and 3 others". */
function names(list: Array<{ name: string }>): string {
  const n = list.map((x) => x.name);
  if (n.length <= 1) return n[0] ?? "";
  if (n.length <= 3) return `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
  return `${n.slice(0, 2).join(", ")} and ${n.length - 2} others`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why a listed number can't be called, short enough for the row. */
function blockedWords(code: string): string {
  return code === "not_allowed" ? "Number not allowed on this server yet" : code === "invalid_number" ? "Check this number" : "Can't call this number";
}

export function CounterpartiesPanel({ mandateId, state, pending, title, onOpen }: Props) {
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
  // Guards the campaign against a second press before the first one re-renders the button.
  const starting = useRef(false);

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
  const entries = list?.entries ?? [];
  const campaign: CampaignView | null = board?.campaign ?? null;
  const toCall = campaign?.call ?? [];
  const toLink = campaign?.link ?? [];
  const blocked = new Map((campaign?.blocked ?? []).map((b) => [b.entryId, b]));
  const callBlocked = !live ? "Make the mandate live to call." : concluded ? "This deal is already agreed." : !canCall ? "Calling out is off on this server (KRITVA_BOARD_CALLS)." : null;

  // The panel's one primary action: reach everyone on the list not reached yet. Filled only when it can run.
  const pendingReach = toCall.length + toLink.length;
  const canStart = live && !concluded && pendingReach > 0 && board !== null;
  const ctaLabel = toCall.length > 0 ? `Call ${toCall.length === 1 ? "1 counterparty" : `${toCall.length} counterparties`}` : toLink.length > 0 ? `Send ${plural(toLink.length, "private link", "private links")}` : "Call everyone";
  const hint = !live
    ? entries.length === 0
      ? "Add counterparties with their numbers. Once the mandate is live, Kritva calls them all from here."
      : "Make the mandate live to start the calls."
    : concluded
      ? "This deal is agreed, so nobody else is called."
      : entries.length === 0
        ? "Add counterparties with their numbers to call them."
        : pendingReach === 0
          ? `${blocked.size > 0 ? "Everyone Kritva may call has been contacted" : "Everyone on the list has been contacted"}, once each. To try someone again, use the call button on their row.`
          : `${toCall.length > 0 ? `Kritva calls ${names(toCall)} from its phone number, one call each` : ""}${toCall.length > 0 && toLink.length > 0 ? ". " : ""}${toLink.length > 0 ? `${names(toLink)} ${toLink.length === 1 ? "gets" : "get"} a private link${canCall ? "" : " (calling out is off on this server)"}` : ""}.`;

  const startCampaign = async () => {
    if (!mandateId || !canStart || starting.current) return;
    starting.current = true;
    setBusy("start");
    setError(null);
    setNote(null);
    try {
      const r = await api.deals.start(mandateId);
      const nameOf = (entryId: string) => entries.find((e) => e.id === entryId)?.name ?? "someone";
      const called = r.calls.filter((c) => c.ok);
      const failed = [...r.calls.filter((c) => !c.ok), ...r.refused.map((x) => ({ entryId: x.entryId, message: x.message }))];
      const linked = r.started.filter((s) => !r.calls.some((c) => c.entryId === s.entryId)).length;
      const parts = [called.length > 0 ? `Calling ${names(called.map((c) => ({ name: nameOf(c.entryId) })))} now. Each row shows how the call is going.` : "", linked > 0 ? `${plural(linked, "private link is", "private links are")} ready to share.` : ""].filter(Boolean);
      setNote(parts.length > 0 ? parts.join(" ") : failed.length === 0 ? "Everyone on the list has already been reached." : null);
      if (failed.length > 0) setError(failed.map((f) => `Couldn't reach ${nameOf(f.entryId)}: ${f.message ?? "the call didn't go through."}`).join(" "));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't go through. Try again.");
    } finally {
      starting.current = false;
      setBusy(null);
      await refresh();
    }
  };

  return (
    <section className="panel counterparties" aria-labelledby="counterparties-title">
      <header className="panel-header">
        <div>
          <h2 id="counterparties-title" className="panel-title">Counterparties</h2>
          <p className="panel-subtitle">
            {mandateId ? `Who Kritva negotiates with for ${title}. ${entries.length} of ${list?.max ?? 5} listed. Numbers stay with you.` : `Who Kritva negotiates with for ${title}. Name them in the chat, or add them here once it's prepared.`}
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
                const held = blocked.get(e.id);
                // Each counterparty is negotiated with once: a finished negotiation isn't called again.
                const finished = Boolean(e.sessionId) && !e.open;
                const callable = Boolean(e.phone) && !callBlocked && !finished && !held;
                const callTitle = callBlocked ?? (finished ? `Kritva has already negotiated with ${e.name}` : held ? held.message : `Call ${e.name}`);
                return (
                  <motion.li key={e.id} className="people-row" layout={!reduced} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
                    <span className="people-who">
                      <span className="board-name">{e.name}</span>
                      <span className="board-meta">
                        {e.phone ? `Phone ···${e.phone.replace(/\D/g, "").slice(-4)}` : "No number"}
                        {status ? ` · ${status}` : held ? ` · ${blockedWords(held.code)}` : ""}
                      </span>
                    </span>
                    {e.phone && (
                      <button
                        type="button"
                        className="icon-button"
                        disabled={!callable || busy === `call:${e.id}`}
                        title={callTitle}
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
            {/* Shown for every saved mandate; it fills with the accent only when it can run (live, someone left to reach). */}
            <button type="button" className={`button ${canStart ? "button-accent" : "button-secondary"}`} disabled={!canStart || busy === "start"} aria-describedby="counterparties-hint" onClick={() => void startCampaign()}>
              {busy === "start" ? <span className="spinner" aria-hidden="true" /> : toCall.length > 0 || toLink.length === 0 ? <PhoneIcon /> : null}
              {ctaLabel}
            </button>
            <p id="counterparties-hint" className="counterparties-hint">{hint}</p>
          </div>
        </>
      )}

      <p className="counterparties-note" role="status">
        {note}
      </p>
      {error && (
        <p className="composer-error counterparties-message" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
