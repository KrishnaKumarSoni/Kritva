/**
 * The go-live moment: when a mandate first goes live, the curtain comes down once more and says so.
 * Kritva is live; this is the number to call and the listing code to give. The room can call it now.
 *
 * Escape, the scrim-free "Done" button or "Copy for your ad" (then Done) return to the console.
 * Focus starts on Done and stays inside; reduced motion turns the choreography into a fade.
 */
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { PhoneLine } from "./api.ts";
import { CheckIcon, CopyIcon } from "./icons.tsx";
import { adLine, lineNumberFor } from "./listing-line.ts";

const EASE = [0.2, 0, 0, 1] as const;

export function GoLive({ title, code, line, onClose }: { title: string; code: string | null; line: PhoneLine | null; onClose: () => void }) {
  const reduced = useReducedMotion();
  const [copied, setCopied] = useState(false);
  const doneRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const number = code ? lineNumberFor(line) : null;

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    doneRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      returnTo.current?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(adLine(code, line));
      setCopied(true);
    } catch {
      /* the clipboard is unavailable; the code stays on screen */
    }
  };

  /** Each part arrives in turn, the way a reveal is read: the news, then the number, then the code. */
  const step = (i: number) => (reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2 } } : { initial: { opacity: 0, y: 14, filter: "blur(6px)" }, animate: { opacity: 1, y: 0, filter: "blur(0px)" }, transition: { duration: 0.6, ease: EASE, delay: 0.25 + i * 0.18 } });

  return (
    <motion.div
      className="golive"
      role="dialog"
      aria-modal="true"
      aria-labelledby="golive-title"
      aria-describedby="golive-what"
      initial={reduced ? { opacity: 0 } : { y: "-100%" }}
      animate={reduced ? { opacity: 1 } : { y: 0 }}
      exit={reduced ? { opacity: 0 } : { y: "-100%" }}
      transition={reduced ? { duration: 0.25 } : { duration: 0.7, ease: [0.76, 0, 0.24, 1] }}
      onKeyDown={(e) => {
        // Keep focus inside the moment.
        if (e.key !== "Tab") return;
        const buttons = [...e.currentTarget.querySelectorAll("button")];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        buttons[(i + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
      }}
    >
      <div className="golive-inner">
        <motion.p className="golive-kicker" {...step(0)}>
          <span className="golive-pulse" aria-hidden="true" />
          Live now
        </motion.p>
        <motion.h2 id="golive-title" className="golive-title" {...step(1)}>
          Kritva is live.
        </motion.h2>
        <motion.p id="golive-what" className="golive-what" {...step(2)}>
          {title}
        </motion.p>
        {code && (
          <motion.div className="golive-line" {...step(3)}>
            {number && (
              <p className="golive-number">
                Call <span className="tabular">{number}</span>
              </p>
            )}
            <p className="golive-code" aria-label={`Listing code ${[...code].join(" ")}`}>
              {[...code].map((digit, i) => (
                <motion.span
                  key={i}
                  className="golive-digit"
                  aria-hidden="true"
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={reduced ? { duration: 0.2 } : { type: "spring", duration: 0.5, bounce: 0.15, delay: 0.95 + i * 0.09 }}
                >
                  {digit}
                </motion.span>
              ))}
            </p>
            <p className="golive-hint">{number ? "The listing code. Callers give it, and Kritva answers for this listing." : "The listing code callers give on Kritva's phone line."}</p>
          </motion.div>
        )}
        <motion.div className="golive-actions" {...step(code ? 5 : 3)}>
          {code && (
            <button type="button" className="button button-accent" onClick={() => void copy()} aria-live="polite">
              {copied ? <CheckIcon width={14} height={14} /> : <CopyIcon width={14} height={14} />}
              {copied ? "Copied" : "Copy for your ad"}
            </button>
          )}
          <button ref={doneRef} type="button" className="button golive-done" onClick={onClose}>
            Done
          </button>
        </motion.div>
      </div>
    </motion.div>
  );
}
