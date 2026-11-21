import { useEffect, useState } from "react";
import { api, ApiError, type DraftSummary, type PrincipalView } from "./api.ts";
import { AlertIcon, LockIcon } from "./icons.tsx";

interface Props {
  sessionId: string;
  principal: PrincipalView;
  drafts: DraftSummary[];
  onChanged: () => void;
}

/**
 * The principal's mandate: what is in force, and the only place it changes. Edited instructions
 * become a draft (mapped by the same mapper), which has no authority until confirmed here.
 */
export function MandatePanel({ sessionId, principal, drafts, onChanged }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"draft" | "confirm" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = drafts.find((d) => d.status === "open") ?? null;
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());

  useEffect(() => setAcknowledged(new Set()), [open?.draftId]);

  const startEditing = async () => {
    setError(null);
    try {
      setText((await api.instructions(sessionId)).instructions);
      setEditing(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to load your instructions.");
    }
  };
  const prepare = async () => {
    setBusy("draft");
    setError(null);
    try {
      await api.proposeDraft(sessionId, text);
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to prepare a draft. Your mandate is unchanged.");
    } finally {
      setBusy(null);
    }
  };
  const decide = async (kind: "confirm" | "reject") => {
    if (!open) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "confirm") await api.confirmDraft(sessionId, open.draftId, [...acknowledged]);
      else await api.rejectDraft(sessionId, open.draftId);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to record your decision. Your mandate is unchanged.");
    } finally {
      setBusy(null);
    }
  };
  const allAcknowledged = open ? open.issues.every((i) => acknowledged.has(i.id)) : false;

  return (
    <div className="dealspace">
      <section className="ds-section" aria-labelledby="mp-active">
        <h3 id="mp-active" className="ds-heading">
          In force: revision {principal.revision}
        </h3>
        <Group title="Goals and needs" items={principal.goals.map((g) => ({ id: g.id, text: `${g.kind === "need" ? "Need" : g.kind === "reason" ? "Reason" : "Goal"}: ${g.text}${g.priority ? ` (priority ${g.priority})` : ""}`, private: g.private }))} empty="No goals or needs stated." />
        <Group title="Targets" items={principal.targets} empty="No target stated." />
        <Group title="Preferences" items={principal.preferences} empty="No preferences stated." />
        <Group title="If there is no deal" items={principal.alternatives.map((a) => ({ id: a.id, text: a.text, private: a.private }))} empty="No alternative stated. It stays unknown." />
        <Group title="Limits" items={principal.limits.map((l) => ({ id: l.id, text: `${l.text}${l.conditional ? " (conditional)" : ""}. ${l.exception}.`, private: true }))} empty="No limits stated." />
        <div className="ds-subgroup">
          <h4 className="ds-subheading">Authority</h4>
          <dl className="terms">
            {principal.permissions.map((p) => (
              <div key={p.action} style={{ display: "contents" }}>
                <dt>{p.action}</dt>
                <dd>{p.mode}</dd>
              </div>
            ))}
          </dl>
        </div>
        {principal.unresolved.length > 0 && (
          <p className="ds-warning">
            <AlertIcon width={14} height={14} />
            {principal.unresolved.map((u) => `${u.term}: ${u.reason}`).join(" ")} Kritva will not change or accept these terms until you clarify.
          </p>
        )}
      </section>

      <section className="ds-section" aria-labelledby="mp-change">
        <h3 id="mp-change" className="ds-heading">
          Change instructions
        </h3>
        {!editing && !open && (
          <div>
            <p className="ds-note">Edits become a draft. Nothing changes until you confirm it.</p>
            <button type="button" className="button button-secondary" onClick={startEditing} style={{ marginBlockStart: 8 }}>
              Edit instructions
            </button>
          </div>
        )}
        {editing && (
          <div className="ds-card">
            <label className="composer-label" htmlFor="mandate-instructions">
              Your instructions to Kritva
            </label>
            <textarea id="mandate-instructions" className="mandate-text" value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={5000} />
            <div className="approval-actions">
              <button type="button" className="button button-accent" onClick={prepare} disabled={busy !== null || text.trim().length === 0}>
                {busy === "draft" && <span className="spinner" aria-hidden="true" />}
                {busy === "draft" ? "Preparing draft" : "Prepare draft"}
              </button>
              <button type="button" className="button button-secondary" onClick={() => setEditing(false)} disabled={busy !== null}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {open && (
          <div className="ds-card" aria-label="Draft for review">
            <p className="ds-term-name">Draft based on revision {open.basedOnRevision}. Not in force.</p>
            <ul className="ds-rules">
              {open.rules.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <p className="ds-note">Accepting an agreement: {open.readiness.accept.replace("_", " ")}.</p>
            {open.readiness.unresolved.length > 0 && (
              <p className="ds-warning">
                <AlertIcon width={14} height={14} />
                Unresolved until you clarify: {open.readiness.unresolved.map((u) => u.name).join(", ")}.
              </p>
            )}
            {open.issues.length > 0 && (
              <fieldset className="ack">
                <legend className="ds-subheading">Acknowledge open issues to confirm</legend>
                {open.issues.map((i) => (
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
            <div className="approval-actions">
              <button type="button" className="button button-accent" onClick={() => decide("confirm")} disabled={busy !== null || !allAcknowledged}>
                {busy === "confirm" && <span className="spinner" aria-hidden="true" />}
                Confirm revision
              </button>
              <button type="button" className="button button-secondary" onClick={() => decide("reject")} disabled={busy !== null}>
                Discard draft
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="composer-error" role="alert">
            <AlertIcon />
            {error}
          </p>
        )}
        {drafts.filter((d) => d.status !== "open").length > 0 && (
          <ul className="ds-facts">
            {drafts
              .filter((d) => d.status !== "open")
              .map((d) => (
                <li key={d.draftId}>
                  Draft from revision {d.basedOnRevision}: {d.status}
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Group({ title, items, empty }: { title: string; items: Array<{ id: string; text: string; private: boolean }>; empty: string }) {
  return (
    <div className="ds-subgroup">
      <h4 className="ds-subheading">{title}</h4>
      {items.length === 0 ? (
        <p className="ds-empty">{empty}</p>
      ) : (
        <ul className="ds-rules">
          {items.map((i) => (
            <li key={i.id}>
              {i.text}
              {i.private && (
                <span className="private-mark">
                  <LockIcon width={12} height={12} />
                  <span className="visually-hidden">(private)</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
