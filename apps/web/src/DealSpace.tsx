import type { DealSpaceView } from "./api.ts";
import { AlertIcon, CheckIcon, HelpIcon, LockIcon } from "./icons.tsx";

const RESULT = {
  fits: { label: "Fits known constraints", icon: CheckIcon, className: "status status-fits" },
  conflicts: { label: "Conflicts", icon: AlertIcon, className: "status status-conflict" },
  needs_clarification: { label: "Needs clarification", icon: HelpIcon, className: "status status-unclear" },
} as const;

/** Operator-only view of the deal space. Never rendered for the buyer. */
export function DealSpace({ view }: { view: DealSpaceView }) {
  const check = view.lastBuyerCheck;
  return (
    <div className="dealspace">
      <section aria-labelledby="ds-check" className="ds-section">
        <h3 id="ds-check" className="ds-heading">
          Latest buyer proposal
        </h3>
        {check ? (
          <div className="ds-card">
            <ResultBadge result={check.result} />
            <p className="ds-terms tabular">{check.terms.join(" · ")}</p>
            {check.findings.length > 0 && (
              <ul className="ds-findings">
                {check.findings.map((f, i) => (
                  <li key={i}>
                    <span className="ds-finding-term">{f.term}</span> {f.detail}
                  </li>
                ))}
              </ul>
            )}
            <p className="ds-note">A passing check is not permission or agreement.</p>
          </div>
        ) : (
          <p className="ds-empty">No buyer proposal checked yet.</p>
        )}
      </section>

      <section aria-labelledby="ds-terms" className="ds-section">
        <h3 id="ds-terms" className="ds-heading">
          Terms
        </h3>
        <ul className="ds-list">
          {view.terms.map((t) => (
            <li key={t.termId} className="ds-term">
              <div className="ds-term-head">
                <span className="ds-term-name">{t.name}</span>
                <span className="chip">{t.kindLabel}</span>
              </div>
              {t.value && (
                <p className="ds-term-value tabular">
                  Seller's value: {t.value}
                  {t.valueIsPrivate && <PrivateMark />}
                </p>
              )}
              {t.rules.length > 0 && (
                <ul className="ds-rules">
                  {t.rules.map((r) => (
                    <li key={r.id} className="tabular">
                      {r.text}
                      {r.private && <PrivateMark />}
                    </li>
                  ))}
                </ul>
              )}
              {t.inconsistent && (
                <p className="ds-warning">
                  <AlertIcon width={14} height={14} />
                  The seller's stated value breaks one of the seller's own rules. Review the mandate.
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      {view.requested.length > 0 && (
        <section aria-labelledby="ds-requested" className="ds-section">
          <h3 id="ds-requested" className="ds-heading">
            Requested by the buyer
          </h3>
          <ul className="ds-list">
            {view.requested.map((r) => (
              <li key={r.id} className="ds-term">
                <div className="ds-term-head">
                  <span className="ds-term-name">{r.name}</span>
                  <span className="chip">Unresolved</span>
                </div>
                <p className="ds-term-value">Not in your mandate. Kritva has not promised or priced it.</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="ds-facts" className="ds-section">
        <h3 id="ds-facts" className="ds-heading">
          Facts (not negotiable)
        </h3>
        <ul className="ds-facts">
          {view.facts.map((f) => (
            <li key={f.id}>
              {f.statement}
              {f.private && <PrivateMark />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function ResultBadge({ result }: { result: keyof typeof RESULT }) {
  const r = RESULT[result];
  const Icon = r.icon;
  return (
    <span className={r.className}>
      <Icon width={14} height={14} />
      {r.label}
    </span>
  );
}

function PrivateMark() {
  return (
    <span className="private-mark">
      <LockIcon width={12} height={12} />
      <span className="visually-hidden">(private)</span>
    </span>
  );
}
