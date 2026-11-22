/**
 * The deal board (docs/Kritva_Multiple_Counterparties.md, section 14): one saved mandate, one deal,
 * every counterparty negotiating for it. A row per counterparty with status, latest offer, gap to the
 * principal's limit and a star on the best; approvals waiting on the principal; the mandate's
 * counterparty list; and the header counters. Everything here is private to the principal.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type BoardRowView, type BoardView, type CounterpartyListView, type LibrarySummary } from "./api.ts";
import { AlertIcon, ArrowUpRightIcon, CheckIcon, ClockIcon, PhoneIcon, StarIcon } from "./icons.tsx";
import { Select } from "./Select.tsx";

const POLL_MS = 2500;
const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;
const iconSpring = { type: "spring", duration: 0.3, bounce: 0 } as const;

interface Props {
  /** Opens one counterparty's negotiation in the console. */
  onOpen: (sessionId: string) => void;
  /** Opens the mandate, where its counterparties are listed and called. */
  onManage: (libraryId: string) => void;
}

const STATUS: Record<BoardRowView["status"], { label: string; tone: "live" | "wait" | "done" | "stop" | "plain" }> = {
  not_started: { label: "Not started", tone: "plain" },
  talking: { label: "Negotiating", tone: "live" },
  waiting_for_you: { label: "Waiting for you", tone: "wait" },
  reserved: { label: "Held for them", tone: "wait" },
  paused: { label: "Paused", tone: "stop" },
  agreed: { label: "Agreed", tone: "done" },
  closed_elsewhere: { label: "Closed: went elsewhere", tone: "stop" },
  ended: { label: "Ended", tone: "stop" },
};

const CHANNEL: Record<BoardRowView["channel"], string> = { none: "Link sent", chat: "Chat", browser_call: "Browser call", phone: "Phone" };

/** What the latest call Kritva placed to them is doing, in plain words. */
function callLabel(call: NonNullable<BoardRowView["call"]>): string {
  if (call.state === "dialling") return "Calling…";
  if (call.state === "ringing") return "Ringing…";
  if (call.state !== "ended") return "On the call";
  const ended: Record<string, string> = { completed: "Call ended", no_answer: "No answer", busy: "Busy", failed: "Call failed", blocked: "Call blocked", cancelled: "Call stopped" };
  return ended[call.outcome ?? "completed"] ?? "Call ended";
}

function formatTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}

const ORDER: Record<string, number> = { live: 0, paused: 1, closed: 2 };

export function BoardPage({ onOpen, onManage }: Props) {
  // Every confirmed saved mandate has a deal board: live ones first, then paused, then closed (an
  // agreed deal closes its mandate, and its board stays here to show the outcome).
  const [saved, setSaved] = useState<LibrarySummary[] | null>(null);
  useEffect(() => {
    api.library.list().then(setSaved, () => setSaved([]));
  }, []);
  const deals = (saved ?? [])
    .filter((m) => m.activeRevision !== null && m.state !== "draft")
    .sort((a, b) => (ORDER[a.state] ?? 3) - (ORDER[b.state] ?? 3))
    .map((m) => ({ id: `library:${m.mandateId}`, title: m.title, state: m.state }));
  const [mandateId, setMandateId] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardView | null>(null);
  const [list, setList] = useState<CounterpartyListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reduced = useReducedMotion();
  const libraryId = mandateId?.slice("library:".length) ?? null;
  const current = useRef(libraryId);
  current.current = libraryId;
  /** When each decision first appeared on screen, for "your time used". */
  const shownAt = useRef(new Map<string, number>());

  const firstDeal = deals[0]?.id ?? null;
  const known = deals.some((d) => d.id === mandateId);
  useEffect(() => {
    if (!known) setMandateId(firstDeal);
  }, [known, firstDeal]);

  const refresh = useCallback(async () => {
    const id = current.current;
    if (!id) return;
    try {
      const [b, l] = await Promise.all([api.deals.board(id), api.deals.counterparties(id)]);
      if (current.current !== id) return;
      setBoard(b);
      setList(l);
    } catch (e) {
      if (current.current === id) setError(e instanceof ApiError ? e.message : "Unable to load the deal.");
    }
  }, []);

  useEffect(() => {
    setBoard(null);
    setList(null);
    setError(null);
    if (!libraryId) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [libraryId, refresh]);

  const timed = (key: string) => {
    if (!shownAt.current.has(key)) shownAt.current.set(key, performance.now());
  };
  const spent = (key: string) => Math.max(0, performance.now() - (shownAt.current.get(key) ?? performance.now()));

  const act = async (key: string, run: () => Promise<unknown>, timing?: { action: string; sessionId: string | null }) => {
    if (!libraryId) return;
    setBusy(key);
    setError(null);
    const ms = spent(key);
    try {
      await run();
      if (timing) void api.deals.recordTime(libraryId, timing.action, timing.sessionId, ms).catch(() => undefined);
      shownAt.current.delete(key);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't go through. Try again.");
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const waiting = board?.waiting.length ?? 0;
  if (waiting > 0) timed("start");
  const approvals = (board?.rows ?? []).filter((r) => r.approval);
  for (const r of approvals) timed(`approval:${r.approval!.requestId}`);

  if (saved !== null && deals.length === 0) {
    return (
      <main className="board-page">
        <section className="panel board-empty">
          <h1 className="panel-title">Deals</h1>
          <p className="panel-subtitle">Make a saved mandate live to negotiate one deal with several counterparties at once.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="board-page">
      <header className="board-header">
        <div className="board-heading">
          {/* The deal is the page's filter: it sits above the title it changes. */}
          {deals.length > 0 && (
            <div className="board-filter">
              <Select label="Deal" value={mandateId} align="start" options={deals.map((d) => ({ value: d.id, label: d.title, description: d.state === "live" ? "Live" : d.state === "paused" ? "Paused" : "Closed" }))} onChange={setMandateId} />
            </div>
          )}
          <h1 className="board-title">{board?.title ?? deals.find((d) => d.id === mandateId)?.title ?? "Deal"}</h1>
          <p className="board-counters tabular" aria-live="polite">
            {board ? (
              <>
                <span>{board.counters.negotiationsRun} {board.counters.negotiationsRun === 1 ? "negotiation" : "negotiations"} run</span>
                <span aria-hidden="true">·</span>
                <span>{formatTime(board.counters.timeMs)} of your time</span>
                <span aria-hidden="true">·</span>
                <span>{board.counters.dealsOutsideLimits} {board.counters.dealsOutsideLimits === 1 ? "deal" : "deals"} outside limits</span>
              </>
            ) : (
              "Loading…"
            )}
          </p>
        </div>
        <div className="board-actions">
          <button
            type="button"
            className="button button-accent"
            disabled={!board || waiting === 0 || busy === "start" || Boolean(board.concluded)}
            onClick={() => act("start", () => api.deals.start(libraryId!), { action: "start", sessionId: null })}
          >
            {busy === "start" && <span className="spinner" aria-hidden="true" />}
            {waiting > 0 ? `Start ${waiting} ${waiting === 1 ? "negotiation" : "negotiations"}` : "Start negotiations"}
          </button>
        </div>
      </header>

      {error && <p className="composer-error board-error" role="alert">{error}</p>}
      {board?.concluded && (
        <p className="board-banner" role="status">
          <CheckIcon width={16} height={16} aria-hidden="true" />
          Agreed with {board.concluded.name ?? "a counterparty"}. The others were told politely, and the listing is closed.
        </p>
      )}

      <div className="board-grid">
        <section className="panel board-rows" aria-labelledby="board-rows-title">
          <div className="panel-header">
            <div>
              <h2 id="board-rows-title" className="panel-title">Counterparties</h2>
              <p className="panel-subtitle">The best offer within your limits has a star. Open a row to see the conversation.</p>
            </div>
          </div>
          {board && board.rows.length === 0 ? (
            <p className="board-none">No negotiations yet. Add counterparties on the mandate, then start negotiations, or share the listing.</p>
          ) : (
            <ol className="board-list">
              <AnimatePresence initial={false}>
                {(board?.rows ?? []).map((row) => (
                  <motion.li key={row.sessionId} layout={!reduced} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
                    <Row row={row} winner={board?.concluded?.name ?? null} reduced={Boolean(reduced)} onOpen={() => onOpen(row.sessionId)} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          )}
        </section>

        <div className="board-side">
          <AnimatePresence initial={false}>
            {approvals.map((row) => {
              const a = row.approval!;
              const key = `approval:${a.requestId}`;
              const held = a.heldBy !== null && a.purpose === "acceptance";
              return (
                <motion.section key={a.requestId} className="callout callout-approval" aria-labelledby={`${key}-title`} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
                  <h3 id={`${key}-title`} className="section-title">
                    <ClockIcon width={16} height={16} aria-hidden="true" />
                    {a.purpose === "exception" ? `${row.name ?? "A counterparty"}: approve an exception?` : `${row.name ?? "A counterparty"} accepted. Approve?`}
                  </h3>
                  {a.termsChanged && <p className="callout-note">Terms changed since the last request. Approve again.</p>}
                  <dl className="kv">
                    {a.terms.map((t) => (
                      <div key={t.name} className="kv-row">
                        <dt>{t.name.charAt(0).toUpperCase() + t.name.slice(1)}</dt>
                        <dd className="tabular">{t.value}</dd>
                      </div>
                    ))}
                  </dl>
                  {held && <p className="callout-note">Held for {a.heldBy}. You can approve this if that falls through.</p>}
                  <div className="callout-actions">
                    <button type="button" className="button button-accent" disabled={held || busy === key} onClick={() => act(key, () => api.respond(row.sessionId, a.requestId, "approved", a.offerId, a.mandateRevision), { action: "approve", sessionId: row.sessionId })}>
                      Approve
                    </button>
                    <button type="button" className="button button-secondary" disabled={busy === key} onClick={() => act(key, () => api.respond(row.sessionId, a.requestId, "rejected", a.offerId, a.mandateRevision), { action: "reject", sessionId: row.sessionId })}>
                      Reject
                    </button>
                  </div>
                </motion.section>
              );
            })}
          </AnimatePresence>
          {libraryId && <CounterpartySummary list={list} onManage={() => onManage(libraryId)} />}
        </div>
      </div>
    </main>
  );
}

function Row({ row, winner, reduced, onOpen }: { row: BoardRowView; winner: string | null; reduced: boolean; onOpen: () => void }) {
  const status = STATUS[row.status];
  const name = row.name ?? (row.via === "phone" ? "Phone caller" : row.via === "listing" ? "From the listing" : "Walk-in");
  return (
    <button type="button" className={`board-row${row.best ? " board-row-best" : ""}`} onClick={onOpen}>
      <span className="board-star" aria-hidden={!row.best}>
        <AnimatePresence initial={false}>
          {row.best && (
            <motion.span
              key="star"
              className="board-star-icon"
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
              transition={iconSpring}
            >
              <StarIcon width={16} height={16} />
            </motion.span>
          )}
        </AnimatePresence>
        {row.best && <span className="visually-hidden">Best offer. </span>}
      </span>
      <span className="board-who">
        <span className="board-name">{name}</span>
        <span className="board-channel">
          {row.channel === "phone" && <PhoneIcon width={14} height={14} aria-hidden="true" />}
          {CHANNEL[row.channel]}
          {row.live && <span className="board-live">Live now</span>}
          {!row.live && row.call && <span className={row.call.state === "ended" ? undefined : "board-live"}>{callLabel(row.call)}</span>}
        </span>
      </span>
      <span className={`pill pill-${status.tone}`}>
        {status.tone === "live" && <span className="pill-dot" aria-hidden="true" />}
        {row.status === "closed_elsewhere" && winner ? `Closed: went to ${winner}` : status.label}
      </span>
      <span className="board-offer">
        {row.offer?.amount ? (
          <>
            <span className="board-amount tabular">{row.offer.amount}</span>
            {row.offer.accepted && <span className="board-meta">Accepted your terms</span>}
            {row.offer.changes.length > 0 && <span className="board-meta">{row.offer.changes.join(" · ")}</span>}
          </>
        ) : (
          <span className="board-meta">No offer yet</span>
        )}
        {row.flag && (
          <span className={`board-flag${row.flag === "outside_limits" ? " board-flag-out" : ""}`}>
            <AlertIcon width={14} height={14} aria-hidden="true" />
            {row.flag === "outside_limits" ? "Outside your limits" : "Terms unclear"}
          </span>
        )}
        {row.contact === "kept" && <span className="board-meta">Number kept for later</span>}
        {row.contact === "declined" && <span className="board-meta">Declined to be contacted</span>}
      </span>
      <span className={`board-gap tabular${row.gapValue !== null && row.gapValue < 0 ? " board-gap-short" : ""}`}>{row.gap ?? ""}</span>
    </button>
  );
}

/** The counterparty list lives on the mandate; the board shows who is on it and links there. */
function CounterpartySummary({ list, onManage }: { list: CounterpartyListView | null; onManage: () => void }) {
  const entries = list?.entries ?? [];
  return (
    <section className="panel board-people" aria-labelledby="people-title">
      <div className="panel-header">
        <div>
          <h2 id="people-title" className="panel-title">On the list</h2>
          <p className="panel-subtitle">{list ? `${entries.length} of ${list.max} counterparties. Add, call or remove them on the mandate.` : "Loading…"}</p>
        </div>
      </div>
      {entries.length > 0 && (
        <ul className="people-list">
          {entries.map((e) => (
            <li key={e.id} className="people-row">
              <span className="people-who">
                <span className="board-name">{e.name}</span>
                <span className="board-meta">{e.phone ? `Phone ···${e.phone.replace(/\D/g, "").slice(-4)}` : "No number"}{e.open ? " · negotiating" : e.sessionId ? " · finished" : ""}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="people-manage">
        <button type="button" className="button button-secondary button-small" onClick={onManage}>
          Manage counterparties
          <ArrowUpRightIcon width={13} height={13} />
        </button>
      </div>
    </section>
  );
}
