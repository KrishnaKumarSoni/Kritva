import type { PrincipalView } from "./api.ts";
import { AlertIcon, LockIcon } from "./icons.tsx";

interface Props {
  principal: PrincipalView;
  /** Pauses the negotiation and opens the saved mandate in the mandate library (Epic 11). */
  onChangeInstructions: (() => void) | null;
}

/**
 * The principal's mandate in force for this session. Changes are made in one place only, the
 * mandate library (Epic 11), which pauses the negotiation and applies a confirmed revision here.
 */
export function MandatePanel({ principal, onChangeInstructions }: Props) {
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
        {onChangeInstructions ? (
          <div>
            <p className="ds-note">Changes go through your saved mandate. Kritva pauses this negotiation while you edit, and nothing changes until you confirm the new revision. Pending offers are then checked again.</p>
            <button type="button" className="button button-secondary" onClick={onChangeInstructions} style={{ marginBlockStart: 8 }}>
              Open in Mandates
            </button>
          </div>
        ) : (
          <p className="ds-note">This session uses a prepared mandate file, which can't be edited here. Start a session from a saved mandate to change instructions while negotiating.</p>
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
