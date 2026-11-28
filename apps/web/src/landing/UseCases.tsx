/**
 * Who Kritva is for: B2B first, then individuals. Tabs follow the ARIA APG pattern
 * (roving tabindex, arrow keys, Home and End); the selected pill springs between tabs.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef, useState, type KeyboardEvent } from "react";
import { CheckIcon, LockIcon, MicIcon, PhoneIcon, StarIcon } from "../icons.tsx";
import { ChatIcon } from "./marks.tsx";

type Side = "buy" | "sell";
type Channel = "Phone" | "Chat" | "Browser call";
interface Case {
  id: string;
  tab: string;
  side: string;
  title: string;
  body: string;
  facts: string[];
  board: { title: string; side: Side; unit: string; limit: number; rows: Array<[name: string, channel: Channel, offer: number]> };
}

const CASES: Case[] = [
  {
    id: "procurement",
    tab: "Procurement",
    side: "Buy",
    title: "Negotiate with the suppliers your team never reaches.",
    body: "A buying team negotiates with its top suppliers only. The rest stay on standard terms. Kritva asks each supplier for better terms, inside the limits you set.",
    facts: ["Walmart left about 20% of its 100,000+ suppliers on standard terms (HBR).", "1 mandate covers 1 deal. Kritva talks to up to 5 suppliers at once.", "You approve before Kritva commits."],
    board: { title: "Packaging film, 12-month contract", side: "buy", unit: "a kg", limit: 142, rows: [["Shree Polymers", "Phone", 138], ["Apex Films", "Chat", 145], ["Kaveri Pack", "Phone", 149]] },
  },
  {
    id: "sales",
    tab: "Sales desks",
    side: "Sell",
    title: "Answer every quote request the same day.",
    body: "3 people get 40 quote requests a day, so most buyers wait. Kritva answers each buyer at once. Each discount stays inside the band you set, and each buyer gets the same rules.",
    facts: ["Sales reps sell for only 28% of their week (Salesforce).", "Kritva trades terms, such as volume for price.", "Kritva never invents a price or a deadline."],
    board: { title: "500 steel storage racks", side: "sell", unit: "a rack", limit: 4_200, rows: [["Metro Retail", "Chat", 4_350], ["Nova Stores", "Phone", 4_100], ["GreenMart", "Browser call", 4_250]] },
  },
  {
    id: "freight",
    tab: "Freight brokers",
    side: "Buy + sell",
    title: "Call every transporter on your list at the same time.",
    body: "A broker runs 10 loads a day, with 2 negotiations for each load. Kritva calls the transporters at once and holds your margin on each trip.",
    facts: ["A freight broker takes 8 to 15% of the trip cost (TruckGuru).", "Competing bids cut one firm's freight cost by 4.9% (SuperProcure).", "Kritva speaks Hindi and English on the phone."],
    board: { title: "Bengaluru to Pune, 1 truck, 20 tonnes", side: "buy", unit: "a trip", limit: 38_000, rows: [["Raj Roadlines", "Phone", 36_500], ["Deccan Carriers", "Phone", 39_000], ["KSR Logistics", "Chat", 37_800]] },
  },
  {
    id: "platforms",
    tab: "Platforms",
    side: "Host Kritva",
    title: "Add negotiation to your app with a mandate, not new code.",
    body: "Classifieds, rental sites, B2B marketplaces and call assistants give Kritva the case and the user's authority. Kritva sends back progress, approvals and the outcome.",
    facts: ["The core has no rules for a specific case. Each use case is data.", "The same checks run for each host and each side.", "Text chat, browser voice and phone, in and out."],
    board: { title: "Used scooter, 2021 model", side: "sell", unit: "", limit: 52_000, rows: [["Arjun", "Chat", 54_000], ["Meera", "Phone", 51_500], ["Vikram", "Chat", 50_000]] },
  },
  {
    id: "individuals",
    tab: "Individuals",
    side: "Sell or buy",
    title: "Sell to every caller at once, not one by one.",
    body: "Put 1 code in your ad. Buyers call Kritva's number or open a chat link. Kritva talks to all of them at once and asks you before it agrees.",
    facts: ["1 life event can mean 4 to 15 negotiations.", "Kritva says it is an AI when asked. It never claims to be human.", "The other buyers get a polite close."],
    board: { title: "King-size bed, 1 year old, Koramangala", side: "sell", unit: "", limit: 16_000, rows: [["Priya", "Phone", 17_500], ["Rahul", "Chat", 15_000], ["Ananya", "Phone", 16_800]] },
  },
];

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export function UseCases() {
  const reduced = useReducedMotion();
  const [selected, setSelected] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = CASES[selected]!;

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = CASES.length - 1;
    const next = event.key === "ArrowRight" ? (selected === last ? 0 : selected + 1) : event.key === "ArrowLeft" ? (selected === 0 ? last : selected - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (next === null) return;
    event.preventDefault();
    setSelected(next);
    tabs.current[next]?.focus();
  };

  return (
    <div>
      <div className="lp-tablist" role="tablist" aria-label="Use cases" onKeyDown={onKey}>
        {CASES.map((c, i) => {
          const on = i === selected;
          return (
            <button
              key={c.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`case-tab-${c.id}`}
              aria-selected={on}
              aria-controls={`case-panel-${c.id}`}
              tabIndex={on ? 0 : -1}
              className="lp-tab"
              onClick={() => setSelected(i)}
            >
              {on && <motion.span layoutId="lp-tab-pill" className="lp-tab-pill" transition={reduced ? { duration: 0 } : { type: "spring", duration: 0.35, bounce: 0 }} aria-hidden="true" />}
              <span className="lp-tab-label">{c.tab}</span>
              <span className="lp-tab-side">{c.side}</span>
            </button>
          );
        })}
      </div>
      <p className="lp-tabs-b2c">The first 4 are for businesses. Individuals use the same core.</p>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={current.id}
          role="tabpanel"
          id={`case-panel-${current.id}`}
          aria-labelledby={`case-tab-${current.id}`}
          tabIndex={0}
          className="lp-case"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
        >
          <div className="lp-case-copy">
            <h3 className="lp-h3">{current.title}</h3>
            <p>{current.body}</p>
            <ul className="lp-facts">
              {current.facts.map((f) => (
                <li key={f} className="lp-fact">
                  <CheckIcon width={16} height={16} />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
          <MiniBoard board={current.board} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function MiniBoard({ board }: { board: Case["board"] }) {
  const inside = (offer: number) => (board.side === "buy" ? offer <= board.limit : offer >= board.limit);
  const candidates = board.rows.filter(([, , o]) => inside(o)).map(([, , o]) => o);
  const bestOffer = candidates.length ? (board.side === "buy" ? Math.min(...candidates) : Math.max(...candidates)) : null;
  const per = board.unit ? ` ${board.unit}` : "";
  return (
    <figure className="lp-mini" aria-label={`Example deal board: ${board.title}`}>
      <div className="lp-mini-inner">
        <div className="lp-mini-head">
          <p className="lp-mini-title">{board.title}</p>
          <span className="lp-pill">{board.side === "buy" ? "Buying" : "Selling"}</span>
        </div>
        <ol className="lp-rows lp-rows-flush">
          {board.rows.map(([name, channel, offer]) => {
            const best = offer === bestOffer;
            const gap = board.side === "buy" ? offer - board.limit : board.limit - offer;
            return (
              <li key={name} className={`lp-row${best ? " lp-row-best" : ""}`}>
                <span className="lp-row-star">
                  {best && <StarIcon width={14} height={14} />}
                  {best && <span className="visually-hidden">Best offer.</span>}
                </span>
                <span className="lp-row-who">
                  <span className="lp-row-name">{name}</span>
                  <span className="lp-row-channel">
                    {channel === "Phone" ? <PhoneIcon width={12} height={12} /> : channel === "Chat" ? <ChatIcon width={12} height={12} /> : <MicIcon width={12} height={12} />}
                    {channel}
                  </span>
                </span>
                <span className={`lp-pill ${best ? "lp-pill-wait" : "lp-pill-live"}`}>
                  {!best && <span className="lp-pill-dot" aria-hidden="true" />}
                  {best ? "Waiting for you" : "Negotiating"}
                </span>
                <span className="lp-row-offer">
                  <span className="lp-row-amount">
                    {rupees(offer)}
                    <span className="lp-row-unit">{per}</span>
                  </span>
                  <span className={`lp-row-gap${gap <= 0 ? " lp-row-gap-in" : ""}`}>{gap > 0 ? `${rupees(gap)} ${board.side === "buy" ? "above your maximum" : "below your minimum"}` : "Inside your limit"}</span>
                </span>
              </li>
            );
          })}
        </ol>
        <div className="lp-mini-limit">
          <span className="lp-mini-limit-label">
            <LockIcon width={13} height={13} />
            {board.side === "buy" ? "Your maximum" : "Your minimum"}, only you see this
          </span>
          <b>
            {rupees(board.limit)}
            {per && <span className="lp-row-unit">{per}</span>}
          </b>
        </div>
      </div>
    </figure>
  );
}
