import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { api, ApiError, type LibraryCorrection, type LibraryDetailView, type LibraryExample, type LibraryInput, type LibrarySummary, type MandateReview, type ReviewItem } from "./api.ts";
import { AlertIcon, CheckIcon, LockIcon } from "./icons.tsx";
import { Select } from "./Select.tsx";

const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;

const MODE_OPTIONS = [
  { value: "autonomous", label: "Kritva may do this" },
  { value: "requires_approval", label: "Ask me first" },
  { value: "prohibited", label: "Not allowed" },
];

const EMPTY: LibraryInput = { title: "", principalRole: "", counterpartyRole: "", publicText: "", privateText: "" };

interface Props {
  /** Selects a saved mandate for the next negotiation (it does not start one). */
  onUse: (mandateOptionId: string) => void;
}

/**
 * Epic 11: the principal's mandate library. Plain-language input, a generic review of what Kritva
 * understood, direct corrections, and an explicit confirmation of the exact draft shown.
 */
export function MandatesPage({ onUse }: Props) {
  const [list, setList] = useState<LibrarySummary[]>([]);
  const [examples, setExamples] = useState<LibraryExample[]>([]);
  const [selected, setSelected] = useState<string | "new">("new");
  const [detail, setDetail] = useState<LibraryDetailView | null>(null);
  const [form, setForm] = useState<LibraryInput>(EMPTY);
  const [busy, setBusy] = useState<"map" | "confirm" | "discard" | "correct" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reduced = useReducedMotion();

  const loadList = useCallback(async () => {
    try {
      setList(await api.library.list());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to load saved mandates.");
    }
  }, []);

  useEffect(() => {
    loadList();
    api.library.examples().then(setExamples).catch(() => undefined);
  }, [loadList]);

  const open = async (id: string | "new") => {
    setSelected(id);
    setError(null);
    setNotice(null);
    if (id === "new") {
      setDetail(null);
      setForm(EMPTY);
      return;
    }
    try {
      const d = await api.library.get(id);
      setDetail(d);
      setForm(d.input);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to open that mandate.");
    }
  };

  const show = (d: LibraryDetailView, message: string | null = null) => {
    setDetail(d);
    setSelected(d.mandateId);
    setForm(d.input);
    setNotice(message);
    loadList();
  };

  const map = async () => {
    setBusy("map");
    setError(null);
    setNotice(null);
    try {
      show(detail ? await api.library.remap(detail.mandateId, form) : await api.library.create(form), detail ? "Your edited text is a new draft. The confirmed mandate is unchanged until you confirm." : null);
    } catch (e) {
      // The text stays in the form so it can be corrected.
      setError(e instanceof ApiError ? e.message : "The instructions could not be turned into a draft. Your text is unchanged.");
    } finally {
      setBusy(null);
    }
  };

  const correct = async (corrections: LibraryCorrection[]) => {
    if (!detail?.latest) return false;
    setBusy("correct");
    setError(null);
    try {
      show(await api.library.correct(detail.mandateId, detail.latest.versionId, corrections), "Your correction is a new draft version. Review it, then confirm.");
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The correction could not be saved. The draft is unchanged.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (acknowledged: string[]) => {
    if (!detail?.latest) return;
    setBusy("confirm");
    setError(null);
    try {
      const d = await api.library.confirm(detail.mandateId, detail.latest.versionId, detail.latest.draftHash, acknowledged);
      const applied = d.appliedToSessions?.length ?? 0;
      show(d, `Revision ${d.active!.revision} confirmed and saved.${applied ? ` Applied to ${applied} open negotiation${applied === 1 ? "" : "s"}; their pending offers were checked again.` : ""}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The confirmation could not be saved. The mandate is still unconfirmed.");
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    if (!detail?.latest) return;
    setBusy("discard");
    setError(null);
    try {
      show(await api.library.discard(detail.mandateId, detail.latest.versionId), "Draft discarded.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to discard the draft.");
    } finally {
      setBusy(null);
    }
  };

  const latest = detail?.latest ?? null;
  const reviewing = latest && latest.status === "draft" ? latest : null;
  const changed = detail ? JSON.stringify(form) !== JSON.stringify(detail.input) : true;
  const canMap = form.title.trim() && form.principalRole.trim() && form.counterpartyRole.trim() && form.publicText.trim() && (changed || !detail);

  return (
    <main className="library">
      <h1 className="visually-hidden">Mandates</h1>
      <nav className="panel library-list" aria-labelledby="library-list-title">
        <header className="panel-header">
          <div>
            <h2 className="panel-title" id="library-list-title">
              Mandates
            </h2>
            <p className="panel-subtitle">What Kritva may do for you, saved before any negotiation starts.</p>
          </div>
        </header>
        <ul className="library-items">
          <li>
            <button type="button" className="library-item" aria-current={selected === "new" ? "page" : undefined} onClick={() => open("new")}>
              <span className="library-item-title">New mandate</span>
              <span className="library-item-meta">Describe a negotiation in your own words</span>
            </button>
          </li>
          {list.map((m) => (
            <li key={m.mandateId}>
              <button type="button" className="library-item" aria-current={selected === m.mandateId ? "page" : undefined} onClick={() => open(m.mandateId)}>
                <span className="library-item-title">{m.title}</span>
                <span className="library-item-meta">
                  {m.activeRevision ? (
                    <span className="status status-fits">
                      <CheckIcon width={12} height={12} />
                      Revision {m.activeRevision}
                    </span>
                  ) : (
                    <span className="status status-unclear">Not confirmed</span>
                  )}
                  {m.hasOpenDraft && m.activeRevision ? <span className="status status-unclear">Draft open</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="panel library-main" aria-labelledby="library-main-title">
        <header className="panel-header">
          <div>
            <h2 className="panel-title" id="library-main-title">
              {detail?.title ?? "New mandate"}
            </h2>
            <p className="panel-subtitle">
              {detail?.active ? `In force: revision ${detail.active.revision}, confirmed ${new Date(detail.active.confirmedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.` : detail ? "Not confirmed. It cannot be used in a negotiation yet." : "Kritva maps your words into terms, limits and permissions for you to check."}
            </p>
          </div>
          {detail?.active && (
            <button type="button" className="button button-neutral" onClick={() => onUse(`library:${detail.mandateId}`)}>
              Use for the next negotiation
            </button>
          )}
        </header>

        <div className="library-body">
          <AnimatePresence initial={false}>
            {(notice || error) && (
              <motion.p
                key={error ? `e-${error}` : `n-${notice}`}
                className={error ? "composer-error" : "library-notice"}
                role={error ? "alert" : "status"}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={spring}
              >
                {error ? <AlertIcon /> : <CheckIcon />}
                {error ?? notice}
              </motion.p>
            )}
          </AnimatePresence>

          <InputForm form={form} setForm={setForm} examples={detail ? [] : examples} busy={busy} onMap={map} canMap={Boolean(canMap)} existing={Boolean(detail)} />

          {latest && (
            <Review
              key={latest.versionId}
              title={reviewing ? "Review the draft" : "Confirmed mandate"}
              subtitle={reviewing ? `Draft version ${detail!.versions.at(-1)!.seq}, not in force. Check each item; correct anything Kritva misread.` : `Revision ${detail!.active?.revision}. Correcting a value starts a new draft; this revision stays in force until you confirm the new one.`}
              review={latest.review}
              accept={latest.accept}
              blockers={reviewing ? latest.blockers : []}
              busy={busy}
              editable={latest.status === "draft" || latest.status === "confirmed"}
              onCorrect={correct}
              onConfirm={reviewing ? confirm : null}
              onDiscard={reviewing ? discard : null}
            />
          )}

          {detail && detail.versions.length > 0 && (
            <details className="library-versions">
              <summary>History ({detail.versions.length} version{detail.versions.length === 1 ? "" : "s"})</summary>
              <ol>
                {[...detail.versions].reverse().map((v) => (
                  <li key={v.versionId}>
                    Version {v.seq} · {v.origin === "correction" ? "your correction" : "mapped from your text"} · {v.status === "confirmed" ? `confirmed as revision ${v.revision}` : v.status} · {new Date(v.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      </section>
    </main>
  );
}

function InputForm({ form, setForm, examples, busy, onMap, canMap, existing }: { form: LibraryInput; setForm: (f: LibraryInput) => void; examples: LibraryExample[]; busy: string | null; onMap: () => void; canMap: boolean; existing: boolean }) {
  const id = useId();
  const set = (key: keyof LibraryInput) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <section className="ds-section" aria-labelledby={`${id}-title`}>
      <div className="ds-term-head">
        <h3 id={`${id}-title`} className="ds-heading">
          {existing ? "Your words" : "Describe the negotiation"}
        </h3>
        {examples.length > 0 && (
          <Select
            label="Start from an example"
            placeholder="Load an example"
            value={null}
            options={examples.map((e) => ({ value: e.id, label: e.title, description: `You are the ${e.principalRole}` }))}
            onChange={(value) => {
              const e = examples.find((x) => x.id === value);
              if (e) setForm({ title: e.title, principalRole: e.principalRole, counterpartyRole: e.counterpartyRole, publicText: e.publicText, privateText: e.privateText });
            }}
          />
        )}
      </div>
      <div className="library-form">
        <div className="field field-wide">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} className="text-input" value={form.title} onChange={set("title")} maxLength={120} placeholder="For example: Selling my bed" autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor={`${id}-you`}>You are the</label>
          <input id={`${id}-you`} className="text-input" value={form.principalRole} onChange={set("principalRole")} maxLength={60} placeholder="seller" autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor={`${id}-other`}>Negotiating with the</label>
          <input id={`${id}-other`} className="text-input" value={form.counterpartyRole} onChange={set("counterpartyRole")} maxLength={60} placeholder="buyer" autoComplete="off" />
        </div>
        <div className="field field-wide">
          <label htmlFor={`${id}-public`}>What the other side can see</label>
          <p className="field-hint" id={`${id}-public-hint`}>
            The listing or brief: facts and your asking terms.
          </p>
          <textarea id={`${id}-public`} className="mandate-text" value={form.publicText} onChange={set("publicText")} maxLength={10_000} rows={5} aria-describedby={`${id}-public-hint`} />
        </div>
        <div className="field field-wide">
          <label htmlFor={`${id}-private`}>
            Private instructions for Kritva <LockIcon width={12} height={12} aria-hidden="true" />
          </label>
          <p className="field-hint" id={`${id}-private-hint`}>
            Limits, what Kritva may do on its own, and when to ask you. Never shown to the other side.
          </p>
          <textarea id={`${id}-private`} className="mandate-text" value={form.privateText} onChange={set("privateText")} maxLength={10_000} rows={5} aria-describedby={`${id}-private-hint`} />
        </div>
      </div>
      <div className="approval-actions">
        <button type="button" className="button button-accent" onClick={onMap} disabled={!canMap || busy !== null}>
          {busy === "map" && <span className="spinner" aria-hidden="true" />}
          {busy === "map" ? "Reading your instructions" : existing ? "Map changes to a new draft" : "Map to a draft"}
        </button>
        <span className="ds-note">A draft has no authority. Nothing is used until you confirm it.</span>
      </div>
    </section>
  );
}

interface ReviewProps {
  title: string;
  subtitle: string;
  review: MandateReview;
  accept: string;
  blockers: string[];
  busy: string | null;
  editable: boolean;
  onCorrect: (c: LibraryCorrection[]) => Promise<boolean>;
  onConfirm: ((acknowledged: string[]) => void) | null;
  onDiscard: (() => void) | null;
}

function Review({ title, subtitle, review, accept, blockers, busy, editable, onCorrect, onConfirm, onDiscard }: ReviewProps) {
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const id = useId();
  const open = review.issues.filter((i) => !i.blocking);
  const ready = blockers.length === 0 && open.every((i) => acknowledged.has(i.id));
  const privateCount = useMemo(() => review.sections.reduce((n, s) => n + s.items.filter((i) => i.private).length, 0), [review]);

  return (
    <section className="ds-section" aria-labelledby={`${id}-title`}>
      <div>
        <h3 id={`${id}-title`} className="ds-heading">
          {title}
        </h3>
        <p className="ds-note">{subtitle}</p>
      </div>
      <dl className="terms">
        <dt>You are the</dt>
        <dd>{review.parties.you}</dd>
        <dt>Negotiating with the</dt>
        <dd>{review.parties.other}</dd>
        <dt>Accepting an agreement</dt>
        <dd>{accept}</dd>
        <dt>Private items</dt>
        <dd>{privateCount}, never shown to the other side</dd>
      </dl>

      {review.sections.map((s) => (
        <div key={s.id} className="ds-subgroup">
          <h4 className="ds-subheading">{s.title}</h4>
          {s.items.length === 0 ? (
            <p className="ds-empty">{s.empty}</p>
          ) : (
            <ul className="ds-list">
              {s.items.map((item) => (
                <ReviewRow key={item.recordId} item={item} editable={editable} busy={busy} onCorrect={onCorrect} />
              ))}
            </ul>
          )}
        </div>
      ))}

      {(blockers.length > 0 || review.issues.length > 0) && (
        <div className="ds-subgroup">
          <h4 className="ds-subheading">Open questions</h4>
          {blockers.map((b) => (
            <p key={b} className="ds-warning">
              <AlertIcon width={14} height={14} />
              {b}
            </p>
          ))}
          {open.length > 0 && (
            <fieldset className="ack">
              <legend className="ds-note">Mark each as reviewed to confirm. Unknown values stay unknown; Kritva will not fill them in.</legend>
              {open.map((i) => (
                <label key={i.id} className="ack-row">
                  <input
                    type="checkbox"
                    checked={acknowledged.has(i.id)}
                    onChange={(e) => {
                      const next = new Set(acknowledged);
                      if (e.target.checked) next.add(i.id);
                      else next.delete(i.id);
                      setAcknowledged(next);
                    }}
                  />
                  <span>
                    <strong className="ack-kind">{i.kind}</strong> {i.message}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </div>
      )}

      {onConfirm && (
        <div className="library-confirm">
          <div className="approval-actions">
            <button type="button" className="button button-accent" onClick={() => onConfirm([...acknowledged])} disabled={!ready || busy !== null}>
              {busy === "confirm" && <span className="spinner" aria-hidden="true" />}
              Confirm mandate
            </button>
            {onDiscard && (
              <button type="button" className="button button-secondary" onClick={onDiscard} disabled={busy !== null}>
                Discard draft
              </button>
            )}
          </div>
          <p className="ds-note">{ready ? "You are confirming exactly the draft shown above. It applies to new negotiations and to open ones using this mandate." : blockers.length > 0 ? "Resolve the items above first: correct a value, remove one of the conflicting items, or edit your words." : "Mark each open question as reviewed to confirm."}</p>
        </div>
      )}
    </section>
  );
}

function ReviewRow({ item, editable, busy, onCorrect }: { item: ReviewItem; editable: boolean; busy: string | null; onCorrect: (c: LibraryCorrection[]) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.currentValue ?? "");
  const inputId = useId();
  const save = async () => {
    if (await onCorrect([{ recordId: item.recordId, value }])) setEditing(false);
  };
  return (
    <li className="ds-term review-row">
      <div className="ds-term-head">
        <p className="ds-term-name">
          {item.label}
          {item.private && (
            <span className="private-mark" title="Private">
              <LockIcon width={12} height={12} />
              <span className="visually-hidden">(private)</span>
            </span>
          )}
        </p>
        {editable && (
          <div className="review-actions">
            {item.edit === "value" && !editing && (
              <button type="button" className="link-button" onClick={() => setEditing(true)} disabled={busy !== null}>
                Correct
              </button>
            )}
            {item.removable && !editing && (
              <button type="button" className="link-button" onClick={() => onCorrect([{ recordId: item.recordId, remove: true }])} disabled={busy !== null} aria-label={`Remove ${item.label}`}>
                Remove
              </button>
            )}
          </div>
        )}
      </div>
      {item.edit === "mode" && editable ? (
        <Select label={`${item.label}: who decides`} value={item.currentMode} options={MODE_OPTIONS} onChange={(mode) => mode !== item.currentMode && onCorrect([{ recordId: item.recordId, mode }])} disabled={busy !== null} />
      ) : editing ? (
        <div className="review-edit">
          <label htmlFor={inputId} className="visually-hidden">
            Corrected value for {item.label}
          </label>
          <input id={inputId} className="text-input" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && value.trim()) save();
            }} onFocus={(e) => e.currentTarget.select()} autoFocus />
          <button type="button" className="button button-neutral" onClick={save} disabled={busy !== null || value.trim() === ""}>
            {busy === "correct" && <span className="spinner" aria-hidden="true" />}
            Save correction
          </button>
          <button type="button" className="button button-secondary" onClick={() => setEditing(false)} disabled={busy !== null}>
            Cancel
          </button>
        </div>
      ) : (
        <p className="ds-term-value">{item.text}</p>
      )}
      <p className="review-source">
        {item.source ? `From ${item.source}` : "No source"}
        {item.inferred ? " · inferred, check it" : ""}
      </p>
    </li>
  );
}
