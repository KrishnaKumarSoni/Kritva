/**
 * The admin page (/admin): who can use Kritva, how they use it, and who is asking for access.
 * Only admins see it (KRITVA_ADMIN_EMAILS, signed in with an emailed link; apps/server/src/admin.ts).
 *
 * One orange action per view: "Give access" in the page header. Rows carry quieter actions.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { adminApi, ApiError, type AdminOverview, type AdminPerson, type AdminRequest } from "./api.ts";
import { CheckIcon, PlusIcon } from "./icons.tsx";

const REFRESH_MS = 30_000;
const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;

type Metric = "signIns" | "visits" | "negotiations";
const METRICS: Array<{ id: Metric; label: string; unit: [string, string] }> = [
  { id: "signIns", label: "Sign-ins", unit: ["sign-in", "sign-ins"] },
  { id: "visits", label: "Landing visits", unit: ["visit", "visits"] },
  { id: "negotiations", label: "Negotiations", unit: ["negotiation", "negotiations"] },
];

const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const plural = (n: number, [one, many]: [string, string]) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

/** "Just now", "12 min ago", "3 h ago", "Yesterday", or a date. */
function ago(ms: number | null): string {
  if (!ms) return "Never";
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86_400) return "Yesterday";
  return new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function AdminPage({ onSignInAgain }: { onSignInAgain: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [failure, setFailure] = useState<{ code: string | null; message: string } | null>(null);
  const [giving, setGiving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi.overview().then(
      (o) => {
        setData(o);
        setFailure(null);
      },
      (e: unknown) => setFailure(e instanceof ApiError ? { code: e.code, message: e.message } : { code: null, message: "Unable to load the admin page. Try again." }),
    );
  }, []);

  useEffect(() => {
    load();
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  // A status message stays a few seconds, then clears; the region itself stays for screen readers.
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const afterGive = (r: { email: string; already: boolean; invited: boolean }) => {
    setNotice(r.already ? `${r.email} already had access.` : r.invited ? `Access given to ${r.email}. Kritva emailed them where to sign in.` : `Access given to ${r.email}.`);
    load();
  };

  if (failure && !data) {
    return (
      <main className="admin-page">
        <section className="panel admin-blocked" aria-labelledby="admin-blocked-title">
          <h1 id="admin-blocked-title" className="panel-title">
            {failure.code === "admin_needs_link" ? "Sign in again to use admin" : failure.code === "not_admin" ? "Only an admin can open this page" : "Unable to load the admin page"}
          </h1>
          <p className="panel-subtitle">{failure.code === "admin_needs_link" ? "Admin needs a sign-in with an emailed link, not the shared passkey. Sign out, then sign in with your email." : failure.message}</p>
          {failure.code === "admin_needs_link" ? (
            <button type="button" className="button button-neutral" onClick={onSignInAgain}>
              Sign out and sign in again
            </button>
          ) : failure.code !== "not_admin" ? (
            <button type="button" className="button button-secondary" onClick={load}>
              Try again
            </button>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div className="board-heading">
          <h1 className="board-title">Admin</h1>
          <p className="board-counters">Who can use Kritva, how they use it, and who is asking for access.</p>
        </div>
        {!giving && (
          <div className="board-actions">
            <button type="button" className="button button-accent" onClick={() => setGiving(true)}>
              <PlusIcon width={14} height={14} /> Give access
            </button>
          </div>
        )}
      </header>

      <p className="admin-notice" role="status" aria-live="polite">
        {notice && (
          <span className="admin-notice-text">
            <CheckIcon width={14} height={14} /> {notice}
          </span>
        )}
      </p>

      <AnimatePresence initial={false}>
        {giving && <GiveAccess key="give" onDone={(r) => { setGiving(false); afterGive(r); }} onCancel={() => setGiving(false)} />}
      </AnimatePresence>

      {!data ? (
        <section className="panel admin-loading" aria-busy="true">
          <span className="spinner" aria-hidden="true" /> Loading usage…
        </section>
      ) : (
        <>
          <Stats data={data} />
          <UsageChart days={data.days} />
          <div className="admin-grid">
            <Requests requests={data.requests} onGiven={afterGive} onChanged={load} />
            <People people={data.people} me={data.me} onChanged={(message) => { setNotice(message); load(); }} />
          </div>
        </>
      )}
    </main>
  );
}

/* ---------- Give access ---------- */

function GiveAccess({ onDone, onCancel }: { onDone: (r: { email: string; already: boolean; invited: boolean }) => void; onCancel: () => void }) {
  const reduced = useReducedMotion();
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim()) {
      setError("Enter the email address of the person to let in.");
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await adminApi.give(email.trim(), invite));
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError ? e.message : "Unable to give access. Try again.");
      inputRef.current?.focus();
    }
  };

  return (
    <motion.form
      className="panel admin-give"
      onSubmit={submit}
      noValidate
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reduced ? 0 : -4 }}
      transition={spring}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="admin-give-fields">
        <label className="admin-field" htmlFor="give-email">
          <span>Email</span>
          <input
            ref={inputRef}
            id="give-email"
            className="admin-input"
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            placeholder="name@company.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "give-error" : undefined}
            disabled={busy}
          />
        </label>
        <label className="admin-check">
          <input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} disabled={busy} />
          Email them where to sign in
        </label>
      </div>
      {error && (
        <p id="give-error" className="composer-error" role="alert">
          {error}
        </p>
      )}
      <div className="admin-give-actions">
        <button type="submit" className="button button-accent" disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? "Giving access" : "Give access"}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </motion.form>
  );
}

/* ---------- Totals ---------- */

function Stats({ data }: { data: AdminOverview }) {
  const t = data.totals;
  const tiles = [
    { label: "People with access", value: t.people, note: `${t.active7} active in the last 7 days` },
    { label: "Sign-ins, last 30 days", value: t.signIns30, note: t.passkeySignIns30 ? `${t.passkeySignIns30} more with the shared passkey` : "With an emailed link" },
    { label: "Waiting for access", value: t.waiting, note: "Requests from the sign-in page", wait: t.waiting > 0 },
    { label: "Negotiations, last 30 days", value: t.negotiations30, note: "Tests and real ones" },
    { label: "Landing visits, last 30 days", value: t.visits30, note: "Counted without cookies" },
  ];
  return (
    <ul className="admin-stats" aria-label="Totals">
      {tiles.map((s) => (
        <li key={s.label} className={`admin-stat${s.wait ? " admin-stat-wait" : ""}`}>
          <span className="admin-stat-label">{s.label}</span>
          <span className="admin-stat-value tabular">{s.value.toLocaleString("en-IN")}</span>
          <span className="admin-stat-note">{s.note}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- Usage chart: one series at a time, a column per day ---------- */

function UsageChart({ days }: { days: AdminOverview["days"] }) {
  const [metric, setMetric] = useState<Metric>("signIns");
  const [active, setActive] = useState<number | null>(null);
  const groupId = useId();
  const m = METRICS.find((x) => x.id === metric)!;
  const values = days.map((d) => d[metric]);
  const total = values.reduce((a, b) => a + b, 0);
  // Clean ticks: the top is a round, even number at or above the highest day, so the middle tick is whole too.
  const top = useMemo(() => {
    const max = Math.max(1, ...values);
    const step = max <= 10 ? 2 : max <= 50 ? 10 : max <= 100 ? 20 : 2 * 10 ** Math.floor(Math.log10(max));
    return Math.ceil(max / step) * step;
  }, [values]);
  const shown = active ?? null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = days.length - 1;
    const at = active ?? last;
    const next = e.key === "ArrowRight" ? Math.min(last, at + 1) : e.key === "ArrowLeft" ? Math.max(0, at - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };

  return (
    <section className="panel admin-chart" aria-labelledby={`${groupId}-title`}>
      <div className="panel-header">
        <div>
          <h2 id={`${groupId}-title`} className="panel-title">
            {m.label}, last 30 days
          </h2>
          <p className="panel-subtitle tabular">{plural(total, m.unit)} in all. Days in India time.</p>
        </div>
        <div className="admin-segment" role="radiogroup" aria-label="Show">
          {METRICS.map((x) => (
            <label key={x.id} className="admin-segment-item">
              <input type="radio" name={`${groupId}-metric`} value={x.id} checked={metric === x.id} onChange={() => { setMetric(x.id); setActive(null); }} />
              <span>{x.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="admin-plot">
        <div className="admin-yaxis" aria-hidden="true">
          <span>{top.toLocaleString("en-IN")}</span>
          <span>{(top / 2).toLocaleString("en-IN")}</span>
          <span>0</span>
        </div>
        <div
          className="admin-bars"
          tabIndex={0}
          role="group"
          aria-label={`${m.label} per day. Use the arrow keys to read each day.`}
          onKeyDown={onKey}
          onPointerLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
        >
          {days.map((d, i) => (
            <div key={d.day} className={`admin-col${shown === i ? " is-active" : ""}`} onPointerEnter={() => setActive(i)}>
              <span className="admin-bar" style={{ height: `${(values[i]! / top) * 100}%` }} />
            </div>
          ))}
          {shown !== null && (
            <div className="admin-tip" style={{ insetInlineStart: `${((shown + 0.5) / days.length) * 100}%` }} aria-live="polite">
              <b>{dayLabel(days[shown]!.day)}</b> {plural(values[shown]!, m.unit)}
            </div>
          )}
        </div>
        <div className="admin-xaxis" aria-hidden="true">
          <span>{dayLabel(days[0]!.day)}</span>
          <span>{dayLabel(days[Math.floor(days.length / 2)]!.day)}</span>
          <span>{dayLabel(days[days.length - 1]!.day)}</span>
        </div>
      </div>
      <table className="visually-hidden">
        <caption>
          {m.label} per day, last 30 days
        </caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">{m.label}</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d, i) => (
            <tr key={d.day}>
              <th scope="row">{dayLabel(d.day)}</th>
              <td>{values[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ---------- Access requests ---------- */

function Requests({ requests, onGiven, onChanged }: { requests: AdminRequest[]; onGiven: (r: { email: string; already: boolean; invited: boolean }) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waiting = requests.filter((r) => r.status === "pending");
  const handled = requests.filter((r) => r.status !== "pending").slice(0, 5);

  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to do that. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel admin-requests" aria-labelledby="admin-requests-title">
      <div className="panel-header">
        <div>
          <h2 id="admin-requests-title" className="panel-title">
            Access requests
          </h2>
          <p className="panel-subtitle">From the sign-in page. Give access, or set a request aside.</p>
        </div>
      </div>
      {error && (
        <p className="composer-error admin-inline-error" role="alert">
          {error}
        </p>
      )}
      {waiting.length === 0 ? (
        <p className="admin-empty">No one is waiting. A request shows here when someone without access asks on the sign-in page.</p>
      ) : (
        <ul className="admin-list">
          {waiting.map((r) => (
            <li key={r.id} className="admin-request">
              <div className="admin-request-who">
                <span className="admin-request-name">{r.name ?? r.email}</span>
                <span className="admin-meta">
                  {r.name ? `${r.email} · ` : ""}
                  {r.company ? `${r.company} · ` : ""}
                  {ago(r.createdAt)}
                </span>
                {r.note && <span className="admin-request-note">“{r.note}”</span>}
              </div>
              <div className="admin-row-actions">
                <button type="button" className="button button-neutral button-small" disabled={busy !== null} onClick={() => act(`give-${r.id}`, async () => onGiven(await adminApi.give(r.email, true)))}>
                  {busy === `give-${r.id}` && <span className="spinner" aria-hidden="true" />}
                  Give access
                </button>
                <button type="button" className="button button-ghost button-small" disabled={busy !== null} onClick={() => act(`dismiss-${r.id}`, async () => { await adminApi.dismiss(r.id); onChanged(); })}>
                  Set aside
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {handled.length > 0 && (
        <div className="admin-handled">
          <h3 className="admin-subhead">Handled</h3>
          <ul className="admin-list">
            {handled.map((r) => (
              <li key={r.id} className="admin-request admin-request-done">
                <div className="admin-request-who">
                  <span className="admin-request-name">{r.name ?? r.email}</span>
                  <span className="admin-meta">
                    {r.name ? `${r.email} · ` : ""}
                    {ago(r.createdAt)}
                  </span>
                </div>
                <span className={`pill ${r.status === "granted" ? "pill-done" : "pill-stop"}`}>{r.status === "granted" ? "Access given" : "Set aside"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/* ---------- People with access ---------- */

function People({ people, me, onChanged }: { people: AdminPerson[]; me: string | null; onChanged: (message: string) => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async (email: string) => {
    setBusy(true);
    setError(null);
    try {
      await adminApi.revoke(email);
      setConfirming(null);
      onChanged(`Access removed for ${email}. They are signed out.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to remove access. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel admin-people" aria-labelledby="admin-people-title">
      <div className="panel-header">
        <div>
          <h2 id="admin-people-title" className="panel-title">
            People with access
          </h2>
          <p className="panel-subtitle">Sign-ins count emailed links only. The shared passkey is counted apart.</p>
        </div>
      </div>
      {error && (
        <p className="composer-error admin-inline-error" role="alert">
          {error}
        </p>
      )}
      <ul className="admin-list">
        {people.map((p) => (
          <li key={p.email} className="admin-person">
            <div className="admin-person-who">
              <span className="admin-request-name">
                {p.email}
                {p.email === me && <span className="pill">You</span>}
                {p.admin && <span className="pill pill-wait">Admin</span>}
              </span>
              <span className="admin-meta">{p.source === "settings" ? "From settings (KRITVA_SIGNIN_EMAILS)" : `Given by ${p.grantedBy ?? "an admin"}, ${ago(p.grantedAt)}`}</span>
            </div>
            <dl className="admin-person-usage">
              <div>
                <dt>Sign-ins</dt>
                <dd className="tabular">{p.signIns}</dd>
              </div>
              <div>
                <dt>Last sign-in</dt>
                <dd>{ago(p.lastSignIn)}</dd>
              </div>
              <div>
                <dt>Last active</dt>
                <dd>{ago(p.lastSeen)}</dd>
              </div>
            </dl>
            {p.source === "admin" && p.email !== me && (
              <div className="admin-row-actions">
                {confirming === p.email ? (
                  <div className="admin-confirm" role="group" aria-label={`Remove access for ${p.email}`}>
                    <span>Remove access? They are signed out at once.</span>
                    <button type="button" className="button button-danger button-small" disabled={busy} onClick={() => remove(p.email)}>
                      {busy && <span className="spinner" aria-hidden="true" />}
                      Remove access
                    </button>
                    <button type="button" className="button button-ghost button-small" disabled={busy} onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </div>
                ) : (
                  <button type="button" className="button button-ghost button-small" onClick={() => setConfirming(p.email)}>
                    Remove access
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
