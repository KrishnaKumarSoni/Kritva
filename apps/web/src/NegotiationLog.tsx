/**
 * Every negotiation Kritva has run for the principal, most recent activity first: who it was with,
 * which mandate, how it came in (a test here, a private link, the listing, a phone call in or out),
 * where it stands, and how long the calls ran. Opening a row shows that conversation and its panel.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type NegotiationLogRow } from "./api.ts";
import { BeakerIcon, ChevronIcon, PhoneIcon } from "./icons.tsx";

const POLL_MS = 5000;
const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;

const STATUS: Record<NegotiationLogRow["status"], { label: string; tone: "live" | "wait" | "done" | "stop" }> = {
  active: { label: "Negotiating", tone: "live" },
  awaiting_approval: { label: "Needs you", tone: "wait" },
  paused: { label: "Paused", tone: "wait" },
  agreed: { label: "Agreed", tone: "done" },
  no_agreement: { label: "No agreement", tone: "stop" },
  ended: { label: "Ended", tone: "stop" },
};

type Filter = "all" | "real" | "test";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "real", label: "With counterparties" },
  { id: "test", label: "Tests" },
];

export function whoOf(row: NegotiationLogRow): string {
  if (row.counterparty) return row.counterparty;
  if (row.origin === "test") return "Test negotiation";
  if (row.origin === "phone_in") return "Phone caller";
  if (row.origin === "phone_out") return "Outbound call";
  if (row.origin === "listing") return "From the listing";
  return "Private link";
}

export function howOf(row: NegotiationLogRow): string {
  const voice = row.channels.includes("voice") ? " · voice" : "";
  if (row.origin === "phone_in") return "Phone · inbound";
  if (row.origin === "phone_out") return "Phone · outbound";
  if (row.origin === "test") return `Test here${voice}`;
  if (row.origin === "listing") return `Listing chat${voice}`;
  return `Chat link${voice}`;
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

function when(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

export function NegotiationLog({ onOpen, onRows }: { onOpen: (row: NegotiationLogRow) => void; onRows?: (rows: NegotiationLogRow[]) => void }) {
  const [rows, setRows] = useState<NegotiationLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const reduced = useReducedMotion();

  const load = useCallback(async () => {
    try {
      const r = await api.negotiations();
      setRows(r);
      onRows?.(r);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to load your negotiations.");
    }
  }, [onRows]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const shown = (rows ?? []).filter((r) => filter === "all" || (filter === "test" ? r.origin === "test" : r.origin !== "test"));
  const live = (rows ?? []).filter((r) => r.live).length;
  const needsYou = (rows ?? []).filter((r) => r.status === "awaiting_approval").length;

  return (
    <main className="board-page log-page">
      <header className="board-header">
        <div className="board-heading">
          <h1 className="board-title">Negotiations</h1>
          <p className="board-counters tabular" aria-live="polite">
            {rows ? (
              <>
                <span>{rows.length} {rows.length === 1 ? "negotiation" : "negotiations"}</span>
                {live > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="log-live-count">{live} on a call now</span>
                  </>
                )}
                {needsYou > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{needsYou} {needsYou === 1 ? "needs" : "need"} your approval</span>
                  </>
                )}
              </>
            ) : (
              "Loading…"
            )}
          </p>
        </div>
        <div className="log-filters" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className="filter" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="composer-error" role="alert">{error}</p>}

      <section className="panel log-panel" aria-label="Negotiation log">
        <div className="log-head" aria-hidden="true">
          <span>Who</span>
          <span>How</span>
          <span>Status</span>
          <span>Calls</span>
          <span className="log-head-when">Last activity</span>
        </div>
        {rows && shown.length === 0 ? (
          <p className="board-none">
            {filter === "test" ? "No tests yet. Pick a mandate above and start a test negotiation." : filter === "real" ? "No negotiations with counterparties yet. Make a mandate live, then share it or start negotiations from its counterparty list." : "No negotiations yet. Start a test negotiation, or make a mandate live and share it."}
          </p>
        ) : (
          <ol className="log-list">
            <AnimatePresence initial={false}>
              {shown.map((row) => {
                const status = STATUS[row.status];
                return (
                  <motion.li key={row.sessionId} layout={!reduced} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
                    <button type="button" className="log-row" onClick={() => onOpen(row)}>
                      <span className="log-who">
                        <span className="log-name">
                          {row.origin === "test" && <BeakerIcon width={13} height={13} aria-hidden="true" />}
                          {whoOf(row)}
                        </span>
                        <span className="log-meta">{row.mandate.title}</span>
                      </span>
                      <span className="log-how">
                        {(row.origin === "phone_in" || row.origin === "phone_out") && <PhoneIcon width={13} height={13} aria-hidden="true" />}
                        {howOf(row)}
                        {row.live && <span className="board-live">Live now</span>}
                      </span>
                      <span className={`pill pill-${status.tone}`}>
                        {status.tone === "live" && <span className="pill-dot" aria-hidden="true" />}
                        {status.label}
                      </span>
                      <span className="log-calls tabular">
                        {row.calls.count > 0 ? `${row.calls.count} ${row.calls.count === 1 ? "call" : "calls"} · ${duration(row.calls.seconds)}` : `${row.messages} ${row.messages === 1 ? "message" : "messages"}`}
                      </span>
                      <span className="log-when tabular">
                        <time dateTime={row.lastAt}>{when(row.lastAt)}</time>
                        <ChevronIcon className="log-chevron" width={14} height={14} aria-hidden="true" />
                      </span>
                    </button>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ol>
        )}
      </section>
    </main>
  );
}
