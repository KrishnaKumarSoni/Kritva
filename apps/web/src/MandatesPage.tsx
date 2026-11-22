/**
 * The principal's mandates. On the left, every saved mandate by state (live, drafts, paused,
 * closed) with pause, resume, close, reopen and delete. On the right, the intake chat that creates or
 * changes one: the principal talks, Kritva's setup agent fills the mandate, and the principal makes
 * it live from the chat. Only that action gives a mandate authority.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type IntakeDraftSummary, type IntakeView, type LibraryExample, type LibrarySummary, type LifecycleStep, type MandateState, type PrincipalSide } from "./api.ts";
import { ArchiveIcon, PauseIcon, PlayIcon, PlusIcon, RefreshIcon, TrashIcon } from "./icons.tsx";
import { IntakeChat, SideChip, StateChip } from "./IntakeChat.tsx";
import { CounterpartiesPanel } from "./CounterpartiesPanel.tsx";
import { Menu, type MenuItem } from "./Menu.tsx";

const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;

interface Props {
  /** Selects a saved mandate for the next negotiation (it does not start one). */
  onUse: (mandateOptionId: string) => void;
  /** Open this saved mandate first (for example from the console's "Change instructions"). */
  initialId?: string | null;
  /** Opens one negotiation in the Negotiation tab. */
  onOpenNegotiation: (sessionId: string) => void;
}

type Selection = { kind: "mandate"; id: string } | { kind: "intake"; id: string };
type Row = { key: string; selection: Selection; title: string; state: MandateState; updatedAt: string; meta: string; side: PrincipalSide | null };
type Deleting = { selection: Selection; title: string };

const GROUPS: Array<{ state: MandateState; title: string }> = [
  { state: "live", title: "Live" },
  { state: "draft", title: "Drafts" },
  { state: "paused", title: "Paused" },
  { state: "closed", title: "Closed" },
];

const DONE: Record<LifecycleStep, string> = {
  pause: "Paused. Any negotiation using it is paused too.",
  resume: "Live again. Its negotiations have resumed.",
  close: "Closed. Any negotiation using it is paused.",
  reopen: "Reopened and live.",
};

export function MandatesPage({ onUse, initialId = null, onOpenNegotiation }: Props) {
  const [mandates, setMandates] = useState<LibrarySummary[]>([]);
  const [drafts, setDrafts] = useState<IntakeDraftSummary[]>([]);
  const [examples, setExamples] = useState<LibraryExample[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [view, setView] = useState<IntakeView | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const reduced = useReducedMotion();

  const loadList = useCallback(async () => {
    try {
      const [m, d] = await Promise.all([api.library.list(), api.intake.drafts()]);
      setMandates(m);
      setDrafts(d);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to load your mandates.");
    }
  }, []);

  const openSelection = useCallback(async (next: Selection | "new") => {
    setError(null);
    setOpening(true);
    try {
      const v = next === "new" ? await api.intake.start() : next.kind === "mandate" ? await api.intake.forMandate(next.id) : await api.intake.get(next.id);
      setView(v);
      setSelection(next === "new" ? { kind: "intake", id: v.id } : next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to open that mandate.");
    } finally {
      setOpening(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
    api.library.examples().then(setExamples).catch(() => undefined);
  }, [loadList]);

  useEffect(() => {
    void openSelection(initialId ? { kind: "mandate", id: initialId } : "new");
  }, [initialId, openSelection]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const startNew = () => {
    // An untouched new conversation is reused rather than starting another.
    if (view && !view.mandateId && !view.messages.some((m) => m.role === "user")) return;
    void openSelection("new");
  };

  const onChange = (v: IntakeView) => {
    setView(v);
    // Once mapped, the conversation belongs to its mandate.
    if (v.mandateId) setSelection({ kind: "mandate", id: v.mandateId });
    else setSelection({ kind: "intake", id: v.id });
    void loadList();
  };

  const lifecycle = async (id: string, step: LifecycleStep) => {
    setError(null);
    try {
      await api.library.lifecycle(id, step);
      setToast(DONE[step]);
      await loadList();
      if (selection?.kind === "mandate" && selection.id === id) setView(await api.intake.forMandate(id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work. Try again.");
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const target = deleting.selection;
    setDeleting(null);
    setError(null);
    try {
      if (target.kind === "mandate") await api.library.remove(target.id);
      else await api.intake.discard(target.id);
      setToast(target.kind === "mandate" ? "Deleted. Negotiations that used it keep their history." : "Draft deleted.");
      await loadList();
      if (selection && selection.kind === target.kind && selection.id === target.id) await openSelection("new");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to delete it. Try again.");
    }
  };

  const rows: Row[] = [
    ...mandates.map((m): Row => ({ key: m.mandateId, selection: { kind: "mandate", id: m.mandateId }, title: m.title, state: m.state, updatedAt: m.updatedAt, meta: metaFor(m), side: m.principalSide ?? null })),
    ...drafts.map((d): Row => ({ key: d.id, selection: { kind: "intake", id: d.id }, title: d.title, state: "draft", updatedAt: d.updatedAt, meta: `Setting up · ${Math.round(d.progress * 100)}%`, side: null })),
  ];
  const isSelected = (s: Selection) => selection?.kind === s.kind && selection.id === s.id;
  const newSelected = Boolean(view && !view.mandateId && !view.messages.some((m) => m.role === "user"));

  const itemsFor = (row: Row): MenuItem[] => {
    const id = row.selection.id;
    const remove: MenuItem = { id: "delete", label: "Delete", icon: <TrashIcon />, destructive: true, onSelect: () => setDeleting({ selection: row.selection, title: row.title }) };
    if (row.selection.kind === "intake") return [remove];
    const steps: Record<MandateState, MenuItem[]> = {
      live: [
        { id: "pause", label: "Pause", icon: <PauseIcon />, onSelect: () => void lifecycle(id, "pause") },
        { id: "close", label: "Close", icon: <ArchiveIcon />, onSelect: () => void lifecycle(id, "close") },
      ],
      paused: [
        { id: "resume", label: "Resume", icon: <PlayIcon />, onSelect: () => void lifecycle(id, "resume") },
        { id: "close", label: "Close", icon: <ArchiveIcon />, onSelect: () => void lifecycle(id, "close") },
      ],
      closed: [{ id: "reopen", label: "Reopen", icon: <RefreshIcon />, onSelect: () => void lifecycle(id, "reopen") }],
      draft: [],
    };
    return [...steps[row.state], remove];
  };

  return (
    <main className="library">
      <h1 className="visually-hidden">Mandates</h1>
      <nav className="panel library-list" aria-labelledby="library-list-title">
        <header className="panel-header">
          <div>
            <h2 className="panel-title" id="library-list-title">
              Mandates
            </h2>
            <p className="panel-subtitle">What Kritva may do for you.</p>
          </div>
          <button type="button" className="button button-accent button-small" onClick={startNew} aria-current={newSelected ? "page" : undefined}>
            <PlusIcon />
            New
          </button>
        </header>
        <div className="library-groups">
          {rows.length === 0 && <p className="library-empty">Nothing here yet. Tell Kritva what you'd like it to negotiate, and it shows up here.</p>}
          {GROUPS.map((g) => {
            const items = rows.filter((r) => r.state === g.state).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            if (items.length === 0) return null;
            return (
              <section key={g.state} className="library-group" aria-label={g.title}>
                <h3 className="library-group-title">
                  {g.title} <span className="tabular">{items.length}</span>
                </h3>
                <ul className="library-items">
                  <AnimatePresence initial={false}>
                    {items.map((row) => (
                      <motion.li
                        key={row.key}
                        layout={!reduced}
                        className="library-row"
                        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
                        transition={spring}
                      >
                        <button type="button" className="library-item" aria-current={isSelected(row.selection) ? "page" : undefined} onClick={() => void openSelection(row.selection)}>
                          <span className="library-item-title">{row.title}</span>
                          <span className="library-item-meta">
                            <StateChip state={row.state} />
                            <SideChip side={row.side} />
                            <span>{row.meta}</span>
                          </span>
                        </button>
                        <Menu label={`Actions for ${row.title}`} items={itemsFor(row)} />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </section>
            );
          })}
        </div>
      </nav>

      <div className="library-main-column">
        {error && (
          <p className="composer-error" role="alert">
            {error}
          </p>
        )}
        <div className="mandate-workspace">
          {view ? (
            <IntakeChat key={view.id} view={view} examples={view.mandateId ? [] : examples} onChange={onChange} onSaved={() => void loadList()} onUse={onUse} />
          ) : (
            <section className="panel intake intake-loading" aria-busy={opening}>
              <span className="spinner" aria-hidden="true" />
              <span>Opening</span>
            </section>
          )}
          {view && <CounterpartiesPanel mandateId={view.mandateId} state={view.state} pending={view.counterparties ?? []} onOpen={onOpenNegotiation} />}
        </div>
      </div>

      <AnimatePresence>
        {toast && (
          <motion.p
            key={toast}
            className="toast"
            role="status"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, x: "-50%" }}
            animate={{ opacity: 1, y: 0, x: "-50%" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 4, x: "-50%" }}
            transition={spring}
          >
            {toast}
          </motion.p>
        )}
      </AnimatePresence>

      <ConfirmDelete target={deleting} onCancel={() => setDeleting(null)} onConfirm={() => void confirmDelete()} />
    </main>
  );
}

function metaFor(m: LibrarySummary): string {
  const when = relative(m.updatedAt);
  if (m.state === "draft") return `Not live yet · ${when}`;
  return `Revision ${m.activeRevision}${m.hasOpenDraft ? " · changes pending" : ""} · ${when}`;
}

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

/** A modal confirmation for the one destructive action. Escape or the scrim cancels; focus starts on Cancel. */
function ConfirmDelete({ target, onCancel, onConfirm }: { target: Deleting | null; onCancel: () => void; onConfirm: () => void }) {
  const reduced = useReducedMotion();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!target) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      returnTo.current?.focus?.();
    };
  }, [target, onCancel]);

  const mandate = target?.selection.kind === "mandate";
  return (
    <AnimatePresence>
      {target && (
        <motion.div key="scrim" className="dialog-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
          <motion.div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            aria-describedby="delete-body"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0 }}
            onKeyDown={(e) => {
              // Keep focus inside the dialog.
              if (e.key !== "Tab") return;
              const buttons = [...e.currentTarget.querySelectorAll("button")];
              const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
              e.preventDefault();
              buttons[(i + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
            }}
          >
            <h2 id="delete-title" className="dialog-title">
              Delete “{target.title}”?
            </h2>
            <p id="delete-body" className="dialog-body">
              {mandate ? "It leaves your list and can't start new negotiations. Any negotiation using it is paused, and its history is kept." : "This conversation is removed. Nothing was saved from it yet."}
            </p>
            <div className="dialog-actions">
              <button ref={cancelRef} type="button" className="button button-secondary" onClick={onCancel}>
                Cancel
              </button>
              <button type="button" className="button button-neutral" onClick={onConfirm}>
                <TrashIcon />
                Delete
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
