/**
 * The hero's live demo: Kritva's deal board, buying 40 office chairs from 4 vendors at once.
 * The phone transcript follows a real Kritva call (Hindi, with English below each line). The visitor
 * gives the one approval, as the principal does in the console. It plays only while on screen, and
 * it can be paused (WCAG 2.2.2).
 */
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, LockIcon, MicIcon, PauseIcon, PhoneIcon, PlayIcon, RefreshIcon, StarIcon } from "../icons.tsx";
import { ChatIcon } from "./marks.tsx";

const MAX = 7_500;
const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;
const iconSpring = { type: "spring", duration: 0.3, bounce: 0 } as const;

type Status = "calling" | "sent" | "talking" | "noanswer" | "waiting" | "held" | "agreed" | "closed";
const STATUS: Record<Status, { label: string; tone: "plain" | "live" | "wait" | "done" | "stop" }> = {
  calling: { label: "Calling…", tone: "plain" },
  sent: { label: "Link sent", tone: "plain" },
  talking: { label: "Negotiating", tone: "live" },
  noanswer: { label: "No answer", tone: "stop" },
  waiting: { label: "Waiting for you", tone: "wait" },
  held: { label: "Held for them", tone: "wait" },
  agreed: { label: "Agreed", tone: "done" },
  closed: { label: "Closed: went elsewhere", tone: "stop" },
};

type Channel = "phone" | "chat" | "voice";
interface Row {
  id: string;
  name: string;
  channel: Channel;
  detail: string;
  status: Status;
  offer: number | null;
}
interface Line {
  id: string;
  who: "kritva" | "them";
  hi: string;
  en: string;
}
type Phase = "running" | "approval" | "approved" | "declined";
interface DemoState {
  step: number;
  rows: Row[];
  lines: Line[];
  table: number | null;
  note: string;
  phase: Phase;
  shownAt: number | null;
  yourTime: number;
}

const ROWS: Row[] = [
  { id: "sharma", name: "Sharma Furniture", channel: "phone", detail: "Phone · Hindi", status: "calling", offer: null },
  { id: "hub", name: "Office Hub", channel: "chat", detail: "Chat", status: "sent", offer: null },
  { id: "sitwell", name: "SitWell Seating", channel: "voice", detail: "Browser call", status: "calling", offer: null },
  { id: "patel", name: "Patel Traders", channel: "phone", detail: "Phone", status: "calling", offer: null },
];

const L = (id: string, who: Line["who"], hi: string, en: string): Line => ({ id, who, hi, en });
const CALL: Line[] = [
  L("l1", "kritva", "नमस्ते, मैं Kritva हूँ। HSR Layout के एक buyer की तरफ से call कर रही हूँ।", "Hello, I am Kritva. I call for a buyer in HSR Layout."),
  L("l2", "them", "हाँ जी, बताइए।", "Yes, go ahead."),
  L("l3", "kritva", "हमें 40 ergonomic chairs चाहिए: mesh back, lumbar support, 3 साल warranty। Delivery 15 December तक।", "We need 40 ergonomic chairs: mesh back, lumbar support, 3-year warranty. Delivery by 15 December."),
  L("l4", "them", "हम आठ हज़ार में कर देंगे।", "We can do ₹8,000."),
  L("l5", "kritva", "₹8,000 हमारे लिए ज़्यादा है। मैं ₹6,750 दे सकती हूँ।", "₹8,000 is too high for us. I can offer ₹6,750."),
  L("l6", "them", "लास्ट 7,500।", "₹7,500 is my last price."),
  L("l7", "kritva", "एक बार clear कर दूँ: ₹7,500 a chair, 40 chairs, 30% advance, balance on delivery। ठीक है?", "I read it back: ₹7,500 a chair, 40 chairs, 30% advance, balance on delivery. Is that OK?"),
  L("l8", "them", "हाँ, ठीक है।", "Yes, OK."),
];
const CALLBACK = L("l9", "kritva", "Buyer ने approve कर दिया है। ₹7,500 पर confirm करें?", "The buyer approved. Do you confirm at ₹7,500?");
const CONFIRM = L("l10", "them", "हाँ, confirm।", "Yes, I confirm.");

const set = (rows: Row[], id: string, patch: Partial<Row>) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r));

/** Each step waits, then changes the board. The last one hands the approval to the visitor. */
const STEPS: Array<{ wait: number; run: (s: DemoState) => DemoState }> = [
  { wait: 700, run: (s) => ({ ...s, rows: set(s.rows, "sharma", { status: "talking" }), lines: CALL.slice(0, 1), note: "Kritva calls, chats and talks to all 4 vendors at once." }) },
  { wait: 1300, run: (s) => ({ ...s, rows: set(s.rows, "hub", { status: "talking" }), lines: CALL.slice(0, 2) }) },
  { wait: 1300, run: (s) => ({ ...s, rows: set(s.rows, "sitwell", { status: "talking" }), lines: CALL.slice(0, 3) }) },
  { wait: 1700, run: (s) => ({ ...s, rows: set(set(s.rows, "sitwell", { offer: 8_200 }), "patel", { status: "noanswer" }) }) },
  { wait: 1100, run: (s) => ({ ...s, rows: set(set(s.rows, "sharma", { offer: 8_000 }), "hub", { offer: 7_900 }), lines: CALL.slice(0, 4) }) },
  { wait: 1500, run: (s) => ({ ...s, table: 6_750, lines: CALL.slice(0, 5), note: "Every offer is checked against your limit before it is sent." }) },
  { wait: 1500, run: (s) => ({ ...s, rows: set(s.rows, "sitwell", { offer: 7_800 }) }) },
  { wait: 1100, run: (s) => ({ ...s, rows: set(set(s.rows, "sharma", { offer: 7_500 }), "hub", { offer: 7_700 }), lines: CALL.slice(0, 6), note: "Best offer inside your limit. Kritva stops conceding in the other talks." }) },
  { wait: 1700, run: (s) => ({ ...s, lines: CALL.slice(0, 7) }) },
  { wait: 1700, run: (s) => ({ ...s, rows: set(s.rows, "sharma", { status: "waiting" }), lines: CALL.slice(0, 8), phase: "approval", shownAt: Date.now(), note: "Kritva asks you before it commits. Your turn." }) },
];

const initial = (): DemoState => ({ step: 0, rows: ROWS, lines: [], table: null, note: "Kritva starts 4 negotiations for 1 mandate.", phase: "running", shownAt: null, yourTime: 0 });

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** The best offer: the lowest one inside the maximum, from a vendor still talking. */
function bestOf(rows: Row[]): string | null {
  let best: Row | null = null;
  for (const r of rows) {
    if (r.offer === null || r.offer > MAX || r.status === "closed" || r.status === "noanswer") continue;
    if (!best || r.offer < (best.offer ?? Infinity)) best = r;
  }
  return best?.id ?? null;
}

export function HeroBoard() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const [state, setState] = useState<DemoState>(initial);
  const [paused, setPaused] = useState(false);
  const confirmTimer = useRef<number | undefined>(undefined);

  // Advance through the script while the board is on screen and not paused.
  useEffect(() => {
    if (!inView || paused || state.phase !== "running" || state.step >= STEPS.length) return;
    const step = STEPS[state.step]!;
    const t = window.setTimeout(() => setState((s) => ({ ...step.run(s), step: s.step + 1 })), reduced ? Math.min(step.wait, 900) : step.wait);
    return () => window.clearTimeout(t);
  }, [inView, paused, state.phase, state.step, reduced]);

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  const approve = useCallback(() => {
    setState((s) => ({
      ...s,
      phase: "approved",
      yourTime: s.shownAt ? Math.max(1, Math.round((Date.now() - s.shownAt) / 1000)) : 1,
      rows: set(s.rows, "sharma", { status: "held" }),
      lines: [...s.lines, CALLBACK],
      note: "Approved. Kritva calls Sharma Furniture back to confirm.",
    }));
    confirmTimer.current = window.setTimeout(() => {
      setState((s) => ({
        ...s,
        rows: set(set(set(s.rows, "sharma", { status: "agreed" }), "hub", { status: "closed" }), "sitwell", { status: "closed" }),
        lines: [...s.lines, CONFIRM],
        note: "Deal locked. A second approval would fail. Kritva closed the other talks politely.",
      }));
    }, 1600);
  }, []);

  const decline = useCallback(() => {
    setState((s) => ({
      ...s,
      phase: "declined",
      yourTime: s.shownAt ? Math.max(1, Math.round((Date.now() - s.shownAt) / 1000)) : 1,
      rows: set(s.rows, "sharma", { status: "talking" }),
      note: "Declined. Kritva goes back to the table and stays inside your limit.",
    }));
  }, []);

  const replay = () => {
    window.clearTimeout(confirmTimer.current);
    setPaused(false);
    setState(initial());
  };

  const best = bestOf(state.rows);
  const sharma = state.rows[0]!;
  const done = state.phase === "approved" || state.phase === "declined";
  const enter = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 } } : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 } };

  return (
    <div ref={ref} className="lp-board" role="group" aria-label="Demo: Kritva buys 40 office chairs from 4 vendors at once">
      <div className="lp-board-window">
        <div className="lp-board-chrome" aria-hidden="true">
          <span className="lp-wordmark">
            Kritva<span className="lp-wordmark-dot" />
          </span>
          <span className="lp-board-tabs">
            <span className="lp-board-tab-on">Deals</span>
            <span>Negotiations</span>
            <span>Mandates</span>
          </span>
          <span className="lp-board-avatar">K</span>
        </div>

        <div className="lp-board-body">
          <div className="lp-board-head">
            <p className="lp-board-title">
              40 office chairs for the new office
              <span className="lp-pill lp-pill-live">
                <span className="lp-pill-dot" aria-hidden="true" />
                Live
              </span>
              <span className="lp-pill">Buying</span>
            </p>
            <p className="lp-board-counters lp-tabular">
              <span>
                <b>4</b> negotiations
              </span>
              <span>
                <b>0</b> outside your limits
              </span>
              <span>
                Your time <b>{state.yourTime} s</b>
              </span>
            </p>
          </div>

          <div className="lp-board-grid">
            <section className="lp-panel" aria-label="Counterparties">
              <p className="lp-panel-title">Counterparties</p>
              <p className="lp-panel-sub">The best offer inside your limit has a star.</p>
              <ol className="lp-rows">
                {state.rows.map((row) => (
                  <BoardRow key={row.id} row={row} best={row.id === best} reduced={!!reduced} />
                ))}
              </ol>
              <div className="lp-limit">
                <div className="lp-limit-item">
                  <span className="lp-limit-label">
                    <LockIcon width={11} height={11} /> Your maximum
                  </span>
                  <span className="lp-limit-value lp-limit-private">{rupees(MAX)}</span>
                </div>
                <div className="lp-limit-item">
                  <span className="lp-limit-label">On the table</span>
                  <span className="lp-limit-value">{state.table ? rupees(state.table) : "–"}</span>
                </div>
                <div className="lp-limit-item">
                  <span className="lp-limit-label">Best offer</span>
                  <span className="lp-limit-value">{best ? rupees(state.rows.find((r) => r.id === best)!.offer!) : "–"}</span>
                </div>
              </div>
              <p className="lp-board-note" role="status">
                {state.note}
              </p>
            </section>

            <section className="lp-panel lp-convo" aria-label="Conversation with Sharma Furniture">
              <div className="lp-convo-head">
                <div>
                  <p className="lp-panel-title">Sharma Furniture</p>
                  <p className="lp-panel-sub">Phone · outbound · Kritva speaks Hindi</p>
                </div>
                <span className={`lp-pill lp-pill-${STATUS[sharma.status].tone}`}>
                  {STATUS[sharma.status].tone === "live" && <span className="lp-pill-dot" aria-hidden="true" />}
                  {STATUS[sharma.status].label}
                </span>
              </div>

              <div className="lp-lines">
                <AnimatePresence initial={false}>
                  {state.lines.map((line) => (
                    <motion.div key={line.id} layout={reduced ? false : "position"} className={`lp-line lp-line-${line.who}`} {...enter} transition={spring}>
                      <span className="lp-bubble" lang="hi">
                        {line.hi}
                      </span>
                      <span className="lp-line-en">{line.en}</span>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              <AnimatePresence mode="wait" initial={false}>
                {state.phase === "approval" && (
                  <motion.div key="approval" className="lp-approval" {...enter} exit={{ opacity: 0, y: reduced ? 0 : -4 }} transition={spring}>
                    <p className="lp-eyebrow">Waiting for you</p>
                    <p className="lp-approval-title">Approve the deal with Sharma Furniture?</p>
                    <dl className="lp-kv">
                      <div>
                        <dt>Price per chair</dt>
                        <dd>₹7,500</dd>
                      </div>
                      <div>
                        <dt>Chairs</dt>
                        <dd>40</dd>
                      </div>
                      <div>
                        <dt>Payment</dt>
                        <dd>30% advance, balance on delivery</dd>
                      </div>
                    </dl>
                    <div className="lp-approval-actions">
                      <button type="button" className="lp-btn lp-btn-accent lp-btn-sm" onClick={approve}>
                        <CheckIcon width={14} height={14} /> Approve
                      </button>
                      <button type="button" className="lp-btn lp-btn-white lp-btn-sm" onClick={decline}>
                        Decline
                      </button>
                    </div>
                  </motion.div>
                )}
                {state.phase === "approved" && (
                  <motion.p key="approved" className="lp-outcome" {...enter} transition={spring}>
                    <CheckIcon width={16} height={16} />
                    <span>
                      {sharma.status === "agreed"
                        ? `Deal agreed: ₹7,500 a chair for 40 chairs, inside your limit. Your time: ${state.yourTime} s.`
                        : `You approved in ${state.yourTime} s. The deal is final only when Sharma Furniture says yes again.`}
                    </span>
                  </motion.p>
                )}
              </AnimatePresence>
            </section>
          </div>
        </div>
      </div>

      <div className="lp-demo-controls">
        <span className="lp-demo-hint">
          {state.phase === "approval" ? "Your turn: approve or decline the deal." : done ? "That was 1 approval from you. Kritva did the rest." : "A demo with a real call script. Prices in rupees."}
        </span>
        {done ? (
          <button type="button" className="lp-btn lp-btn-white lp-btn-sm" onClick={replay}>
            <RefreshIcon width={14} height={14} /> Replay the demo
          </button>
        ) : state.phase === "running" ? (
          <button type="button" className="lp-btn lp-btn-white lp-btn-sm" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? <PlayIcon width={14} height={14} /> : <PauseIcon width={14} height={14} />}
            {paused ? "Play" : "Pause"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ChannelIcon({ channel }: { channel: Channel }) {
  if (channel === "phone") return <PhoneIcon width={12} height={12} />;
  if (channel === "voice") return <MicIcon width={12} height={12} />;
  return <ChatIcon width={12} height={12} />;
}

function BoardRow({ row, best, reduced }: { row: Row; best: boolean; reduced: boolean }) {
  const status = STATUS[row.status];
  const over = row.offer !== null ? row.offer - MAX : null;
  return (
    <li className={`lp-row${best ? " lp-row-best" : ""}`}>
      <span className="lp-row-star">
        <AnimatePresence initial={false}>
          {best && (
            <motion.span
              key="star"
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
              transition={iconSpring}
            >
              <StarIcon width={14} height={14} />
            </motion.span>
          )}
        </AnimatePresence>
        {best && <span className="visually-hidden">Best offer.</span>}
      </span>
      <span className="lp-row-who">
        <span className="lp-row-name">{row.name}</span>
        <span className="lp-row-channel">
          <ChannelIcon channel={row.channel} />
          {row.detail}
        </span>
      </span>
      <span className={`lp-pill lp-pill-${status.tone}`}>
        {status.tone === "live" && <span className="lp-pill-dot" aria-hidden="true" />}
        {status.label}
      </span>
      <span className="lp-row-offer">
        {row.offer === null ? (
          <span className="lp-row-gap">No offer yet</span>
        ) : (
          <>
            <motion.span key={row.offer} className="lp-row-amount" initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
              {rupees(row.offer)}
            </motion.span>
            <span className={`lp-row-gap${over !== null && over <= 0 ? " lp-row-gap-in" : ""}`}>{over !== null && over > 0 ? `${rupees(over)} above your maximum` : "Inside your limit"}</span>
          </>
        )}
      </span>
    </li>
  );
}
