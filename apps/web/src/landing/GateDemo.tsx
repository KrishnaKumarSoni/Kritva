/**
 * One reply, checked before it is sent: the counterparty asks for the budget, the model's draft says the
 * maximum, Gate 2 blocks it (the reply check's private_amount rule) and the checked wording goes out.
 * It plays once on screen and can be replayed. Under reduced motion, it only cross-fades.
 */
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { CheckIcon, RefreshIcon } from "../icons.tsx";
import { BlockIcon } from "./marks.tsx";

const CHECKS = ["Read", "Ground", "Check", "Decide", "Terms gate", "Write", "Words gate"];
/** Beats: 0 nothing, 1 their message, 2 to 6 checks 1 to 5 pass, 7 the draft (Write), 8 blocked, 9 the checked reply. */
const BEAT_MS = [500, 900, 420, 420, 420, 420, 500, 1000, 1200];
const LAST = BEAT_MS.length;
const spring = { type: "spring", duration: 0.4, bounce: 0 } as const;

export function GateDemo() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    if (!inView || beat >= LAST) return;
    const t = window.setTimeout(() => setBeat((b) => b + 1), BEAT_MS[beat]);
    return () => window.clearTimeout(t);
  }, [inView, beat]);

  // Checks 1 to 5 pass before the draft; 6 (Write) makes it; 7 (Words gate) blocks it.
  const checksDone = beat <= 1 ? 0 : Math.min(beat - 1, 6);
  const enter = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 } } : { initial: { opacity: 0, y: 10, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 } };

  return (
    <div ref={ref} className="lp-gate">
      <div className="lp-gate-head">
        <span className="lp-gate-who">Sharma Furniture</span>
        <span className="lp-gate-meta">Phone · Kritva for the buyer</span>
      </div>

      <div className="lp-gate-thread" aria-live="polite">
        <AnimatePresence initial={false}>
          {beat >= 1 && (
            <motion.div key="them" className="lp-gate-line lp-gate-them" {...enter} transition={spring}>
              <span className="lp-gate-bubble">What is your budget? Tell me and I will match it.</span>
            </motion.div>
          )}
          {beat >= 7 && (
            <motion.div key="draft" className={`lp-gate-line lp-gate-kritva${beat >= 8 ? " is-blocked" : ""}`} {...enter} transition={spring}>
              <span className="lp-gate-label">{beat >= 8 ? <><BlockIcon width={12} height={12} /> Blocked by the words gate: it says your maximum</> : "Model draft"}</span>
              <span className="lp-gate-bubble">Our maximum is ₹7,500 a chair. Can you match it?</span>
            </motion.div>
          )}
          {beat >= 9 && (
            <motion.div key="sent" className="lp-gate-line lp-gate-kritva is-sent" {...enter} transition={spring}>
              <span className="lp-gate-label">
                <CheckIcon width={12} height={12} /> Checked and sent
              </span>
              <span className="lp-gate-bubble">I can’t share our budget. At ₹8,000 we are too far apart. I can offer ₹6,750 a chair for all 40.</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="lp-gate-foot">
        <ol className="lp-checks" aria-label="Checks on this reply">
          {CHECKS.map((name, i) => {
            const state = i === 6 && beat >= 8 ? "blocked" : i < checksDone ? "done" : "todo";
            return (
              <li key={name} className="lp-check" data-state={state}>
                <span className="lp-check-dot" aria-hidden="true" />
                <span className="lp-check-name">{name}</span>
                <span className="visually-hidden">{state === "blocked" ? ": blocked" : state === "done" ? ": passed" : ": waiting"}</span>
              </li>
            );
          })}
        </ol>
        {beat >= LAST && (
          <button type="button" className="lp-btn lp-btn-white lp-btn-sm" onClick={() => setBeat(0)}>
            <RefreshIcon width={14} height={14} /> Replay
          </button>
        )}
      </div>
    </div>
  );
}
