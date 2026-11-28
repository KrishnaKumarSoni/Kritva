/**
 * One negotiation turn, step by step: the model reads and writes, code does the other 5 steps.
 * The example is the reply check's private_amount rule: a draft that says the principal's maximum is
 * blocked at Gate 2 and the checked wording goes out instead (packages/core/src/negotiation/reply-check.ts).
 */
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { CheckIcon, PauseIcon, PlayIcon, RefreshIcon, ShieldIcon } from "../icons.tsx";
import { BlockIcon } from "./marks.tsx";

const STEPS = [
  { name: "Read", by: "Model", out: "They ask for your budget. They make no new offer." },
  { name: "Ground", by: "Code", out: "Matches each fact to their words. Their last offer: ₹8,000." },
  { name: "Check", by: "Code", out: "₹8,000 is above your maximum." },
  { name: "Decide", by: "Code", out: "Counter at ₹6,750. This is 1 of 9 moves." },
  { name: "Gate 1: terms", by: "Code", out: "₹6,750 is inside your limits. Allowed." },
  { name: "Write", by: "Model", out: "Drafts the reply from permitted facts." },
  { name: "Gate 2: words", by: "Code + model", out: "Blocked: the draft says your maximum." },
] as const;

const STEP_MS = 1_100;
const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;

export function TurnDemo() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  // 0 = not started; 1..7 = step reached; 8 = the checked reply is sent.
  const [at, setAt] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!inView || paused || at > STEPS.length) return;
    const t = window.setTimeout(() => setAt((n) => n + 1), at === 0 ? 400 : STEP_MS);
    return () => window.clearTimeout(t);
  }, [inView, paused, at]);

  const drafted = at >= 6;
  const blocked = at >= 7;
  const sent = at >= 8;
  const finished = at > STEPS.length;
  const enter = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 } } : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } };

  return (
    <div ref={ref} className="lp-turn">
      <div className="lp-turn-msg">
        <span className="lp-turn-who">Counterparty says</span>
        <span className="lp-turn-bubble">“What is your budget? Tell me and I will match it.”</span>
      </div>

      <ol className="lp-turn-steps" aria-label="The 7 steps of a turn">
        {STEPS.map((s, i) => {
          const n = i + 1;
          const state = n === 7 && blocked ? "blocked" : at > n || (n === 7 && sent) ? "done" : at === n ? "now" : "todo";
          const isModel = s.by === "Model";
          const isGate = s.name.startsWith("Gate");
          return (
            <li key={s.name} className={`lp-tstep${isModel ? " lp-tstep-model" : ""}`} data-state={state} aria-current={state === "now" ? "step" : undefined}>
              <span className="lp-tstep-top">
                <span className="lp-tstep-n">{n}</span>
                {isGate && <ShieldIcon width={16} height={16} />}
              </span>
              <span className="lp-tstep-name">{s.name}</span>
              <span className={`lp-by${isModel ? " lp-by-model" : ""}`}>{s.by}</span>
              <span className="lp-tstep-out">{at >= n ? s.out : ""}</span>
            </li>
          );
        })}
      </ol>

      <div className="lp-turn-result" aria-live="polite">
        <div className={`lp-draft${blocked ? " lp-draft-blocked" : ""}`}>
          <span className="lp-draft-label">
            {blocked ? <BlockIcon width={14} height={14} /> : null}
            {blocked ? "Draft blocked by Gate 2" : "Model draft"}
          </span>
          <AnimatePresence initial={false}>
            {drafted ? (
              <motion.p key="draft" {...enter} transition={spring}>
                “Our maximum is ₹7,500 a chair. Can you match it?”
              </motion.p>
            ) : (
              <p key="wait" className="lp-draft-wait">The model writes after code decides the move.</p>
            )}
          </AnimatePresence>
        </div>
        <div className={`lp-draft${sent ? " lp-draft-sent" : ""}`}>
          <span className="lp-draft-label">
            {sent ? <CheckIcon width={14} height={14} /> : null}
            {sent ? "Sent: checked wording" : "What the counterparty hears"}
          </span>
          <AnimatePresence initial={false}>
            {sent ? (
              <motion.p key="sent" {...enter} transition={spring}>
                “I can’t share our budget. At ₹8,000 we are too far apart. I can offer ₹6,750 a chair for all 40.”
              </motion.p>
            ) : (
              <p key="wait" className="lp-draft-wait">Nothing leaves until both gates pass.</p>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="lp-turn-foot">
        <p className="lp-legend">
          <span>
            <span className="lp-by lp-by-model">Model</span> reads and writes words
          </span>
          <span>
            <span className="lp-by">Code</span> decides, checks and records
          </span>
        </p>
        {finished ? (
          <button type="button" className="lp-btn lp-btn-white lp-btn-sm" onClick={() => setAt(0)}>
            <RefreshIcon width={14} height={14} /> Run the turn again
          </button>
        ) : (
          <button type="button" className="lp-btn lp-btn-white lp-btn-sm" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? <PlayIcon width={14} height={14} /> : <PauseIcon width={14} height={14} />}
            {paused ? "Play" : "Pause"}
          </button>
        )}
      </div>
    </div>
  );
}
