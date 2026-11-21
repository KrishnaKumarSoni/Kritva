import type { CounterpartyView } from "./api.ts";

const KIND_LABEL: Record<string, string> = {
  need: "Need",
  constraint: "Constraint",
  preference: "Preference",
  reason: "Reason",
  authority: "Decision authority",
  claim: "Claim",
  alternative: "Their alternative",
  budget: "Stated budget",
  final_position: "Stated as final",
};

const STATUS_LABEL: Record<string, string> = {
  open: "Prepared",
  asked: "Asked",
  answered: "Answered",
  partial: "Partly answered",
  refused: "Declined to answer",
};

/** What the buyer has said, within this session. Statements stay the buyer's claims. */
export function BuyerPanel({ view }: { view: CounterpartyView }) {
  const context = view.items.filter((i) => !["claim", "alternative"].includes(i.kind));
  const claims = view.items.filter((i) => ["claim", "alternative"].includes(i.kind));
  return (
    <div className="dealspace">
      <section className="ds-section" aria-labelledby="bp-needs">
        <h3 id="bp-needs" className="ds-heading">
          Needs and constraints
        </h3>
        {context.length === 0 ? <p className="ds-empty">Nothing beyond offers yet.</p> : <ItemList items={context} />}
        {view.failedMessages > 0 && <p className="ds-note">{view.failedMessages} message(s) could not be read. Earlier context is unchanged.</p>}
      </section>

      <section className="ds-section" aria-labelledby="bp-claims">
        <h3 id="bp-claims" className="ds-heading">
          Claims (not verified)
        </h3>
        {claims.length === 0 ? <p className="ds-empty">No claims recorded.</p> : <ItemList items={claims} />}
      </section>

      <section className="ds-section" aria-labelledby="bp-limits">
        <h3 id="bp-limits" className="ds-heading">
          Offers and limit estimates
        </h3>
        {view.estimates.length === 0 ? (
          <p className="ds-empty">No offers yet. The buyer's maximum is unknown.</p>
        ) : (
          <ul className="ds-list">
            {view.estimates.map((e, i) => (
              <li key={i} className="ds-term">
                <p className="ds-term-name">Package: {e.package}</p>
                <p className="ds-term-value tabular">
                  Highest offer: {e.highestOffer ?? "none"}
                  {e.statedBudget ? ` · Stated budget: ${e.statedBudget}` : ""}
                </p>
                {e.finalStatements.length > 0 && <p className="ds-term-value">Said “final”: a stated position, not a proven maximum.</p>}
                <p className="ds-term-value">{e.maximum.text}</p>
              </li>
            ))}
          </ul>
        )}
        {view.contradictions.length > 0 && (
          <ul className="ds-findings">
            {view.contradictions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="ds-section" aria-labelledby="bp-questions">
        <h3 id="bp-questions" className="ds-heading">
          Questions
        </h3>
        {view.questions.length === 0 ? (
          <p className="ds-empty">No open unknowns that a question would resolve.</p>
        ) : (
          <ul className="ds-list">
            {view.questions.map((q) => (
              <li key={q.id} className="ds-term">
                <div className="ds-term-head">
                  <span className="ds-term-name">{q.text}</span>
                  <span className="chip">{STATUS_LABEL[q.status] ?? q.status}</span>
                </div>
                <p className="ds-term-value">Purpose: {q.purpose}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ItemList({ items }: { items: CounterpartyView["items"] }) {
  return (
    <ul className="ds-list">
      {items.map((i) => (
        <li key={i.id} className="ds-term">
          <div className="ds-term-head">
            <span className="ds-term-name">{KIND_LABEL[i.kind] ?? i.kind}</span>
            <span className="chip">{i.basis === "inferred" ? "Inferred" : "Stated"}</span>
          </div>
          <blockquote className="quote">“{i.quote}”</blockquote>
          <p className="ds-term-value">
            {i.summary}
            {i.condition ? ` Condition: ${i.condition}.` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}
