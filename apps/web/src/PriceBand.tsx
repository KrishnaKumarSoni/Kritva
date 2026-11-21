import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type { Insights, Roles } from "./api.ts";
import { LockIcon } from "./icons.tsx";

const spring = { type: "spring", duration: 0.4, bounce: 0 } as const;

/** Formats a raw value on the negotiable term: currency when it has one, otherwise number and unit. */
export function formatAmount(insights: Insights, value: number): string {
  const { currency, unit } = insights.term;
  if (currency) return new Intl.NumberFormat(insights.locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  return `${new Intl.NumberFormat(insights.locale).format(value)}${unit ? ` ${unit}` : ""}`;
}

interface Mark {
  id: string;
  label: string;
  value: number;
  side: "principal" | "counterparty";
  shape: "solid" | "ring" | "tick" | "dash";
  private?: boolean;
  note?: string;
}

/** Everything known about the negotiable term on one line: your limits, the offer on the table, theirs, and where they overlap. */
export function PriceBand({ insights, roles }: { insights: Insights; roles: Roles }) {
  const reduced = useReducedMotion();
  const [focus, setFocus] = useState<string | null>(null);
  const up = insights.term.direction === "up";
  const them = insights.counterparty;
  const candidates: Array<Mark | false> = [
    insights.limit !== null && { id: "limit", label: up ? "Your minimum" : "Your maximum", value: insights.limit, side: "principal", shape: "tick", private: true },
    insights.target !== null && { id: "target", label: "Your target", value: insights.target, side: "principal", shape: "dash", private: true },
    { id: "opening", label: "Opening", value: insights.opening, side: "principal", shape: "ring" },
    insights.currentAsk !== null && insights.currentAsk !== insights.opening && { id: "ask", label: "On the table", value: insights.currentAsk, side: "principal", shape: "solid" },
    them.bestOffer !== null && { id: "best", label: "Their best offer", value: them.bestOffer, side: "counterparty", shape: "solid" },
    them.statedCeiling !== null && { id: "ceiling", label: up ? "Their stated budget" : "Their stated floor", value: them.statedCeiling, side: "counterparty", shape: "ring", note: "Their claim, not verified" },
  ];
  const marks = candidates.filter((m): m is Mark => m !== false);
  // The current ask equals the opening until the first concession: show it once, as the offer on the table.
  const askIsOpening = insights.currentAsk === insights.opening;
  if (askIsOpening) marks.find((m) => m.id === "opening")!.label = "On the table";

  const values = [...marks.map((m) => m.value), insights.zone.from, insights.zone.to].filter((v): v is number => v !== null);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.12;
  const min = lo - pad;
  const max = hi + pad;
  const pos = (v: number) => ((v - min) / (max - min)) * 100;
  const transition = reduced ? { duration: 0 } : spring;
  const zone = insights.zone;

  return (
    <div className="band">
      <div className="band-track-wrap" aria-hidden="true">
        <div className="band-track">
          {zone.status === "overlap" && zone.from !== null && zone.to !== null && (
            <motion.div className="band-zone" initial={false} animate={{ left: `${pos(zone.from)}%`, width: `${Math.max(pos(zone.to) - pos(zone.from), 0.8)}%` }} transition={transition} />
          )}
          {marks.map((m) => (
            <motion.span
              key={m.id}
              className={`band-mark band-mark-${m.shape} band-mark-${m.side}${focus === m.id ? " is-focus" : ""}${focus && focus !== m.id ? " is-dim" : ""}`}
              initial={false}
              animate={{ left: `${pos(m.value)}%` }}
              transition={transition}
            />
          ))}
        </div>
        <div className="band-scale">
          <span>{formatAmount(insights, Math.round(min))}</span>
          <span>{formatAmount(insights, Math.round(max))}</span>
        </div>
      </div>

      <div className="band-legend">
        {(["principal", "counterparty"] as const).map((side) => (
          <dl key={side} className="band-side" aria-label={side === "principal" ? `Your side (${roles.principal})` : `Their side (${roles.counterparty})`}>
            <p className="band-side-title">{side === "principal" ? `You, ${roles.principal}` : `Them, ${roles.counterparty}`}</p>
            {marks.filter((m) => m.side === side).map((m) => (
              <div key={m.id} className="band-row" onPointerEnter={() => setFocus(m.id)} onPointerLeave={() => setFocus(null)}>
                <dt>
                  <span className={`band-key band-mark-${m.shape} band-mark-${m.side}`} aria-hidden="true" />
                  {m.label}
                  {m.private && (
                    <>
                      <LockIcon className="band-lock" width={12} height={12} />
                      <span className="visually-hidden">(private)</span>
                    </>
                  )}
                </dt>
                <dd className="tabular">{formatAmount(insights, m.value)}</dd>
              </div>
            ))}
            {side === "counterparty" && them.bestOffer === null && them.statedCeiling === null && <p className="band-empty">No offer or budget yet.</p>}
          </dl>
        ))}
      </div>
    </div>
  );
}

/** One sentence on the zone of possible agreement, with the evidence behind it. */
export function zoneSentence(insights: Insights, roles: Roles): { tone: "good" | "bad" | "open"; text: string } {
  const z = insights.zone;
  const f = (v: number) => formatAmount(insights, v);
  if (z.status === "overlap" && z.from !== null && z.to !== null) {
    return { tone: "good", text: z.from === z.to ? `Agreement is possible at ${f(z.from)}.` : `Agreement looks possible between ${f(z.from)} and ${f(z.to)}.` };
  }
  if (z.status === "no_overlap") {
    const their = insights.counterparty.estimate.atMost ?? insights.counterparty.statedCeiling;
    return { tone: "bad", text: `No overlap yet: the ${roles.counterparty}'s stated limit${their !== null ? ` of ${f(their)}` : ""} is outside yours.` };
  }
  if (insights.counterparty.estimate.status === "contradicted") return { tone: "open", text: `The ${roles.counterparty}'s statements contradict each other, so their limit is unclear.` };
  return { tone: "open", text: `Unknown until the ${roles.counterparty} states a budget or makes an offer inside your limit.` };
}
