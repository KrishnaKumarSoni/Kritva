/**
 * The stage: a jet-black curtain the console sits behind.
 *
 * - "hold": the curtain is down with the wordmark on it, while Kritva checks who is signed in.
 * - "signin": the curtain stays down and carries the sign-in form (an emailed link, no password).
 * - "lift": the curtain rises and the console is revealed. It plays on every load of the console and
 *   right after signing in. Any key or click lifts it at once; with reduced motion it fades.
 *
 * The curtain never lifts before the wordmark has had its moment, so a fast load still feels deliberate.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "./api.ts";
import { ArrowRightIcon } from "./icons.tsx";

export type StageMode = "hold" | "signin" | "lift";

/** How long the wordmark holds before the curtain may rise. */
const HOLD_MS = 1_100;
/** The curtain's rise: slow to start, quick through the middle, settling at the top. */
const LIFT = { duration: 0.8, ease: [0.76, 0, 0.24, 1] as const };

export function Stage({ mode, linkError, dropIn = false, onLifted }: { mode: StageMode; linkError: string | null; /** Signing out: the curtain comes down from the top. */ dropIn?: boolean; onLifted: () => void }) {
  const reduced = useReducedMotion();
  const [held, setHeld] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    const wait = Math.max(0, (reduced ? 400 : HOLD_MS) - (Date.now() - shownAt.current));
    const t = window.setTimeout(() => setHeld(true), wait);
    return () => window.clearTimeout(t);
  }, [reduced]);

  // Rehearsed or not, the presenter can raise the curtain with any key or click.
  useEffect(() => {
    if (mode !== "lift") return;
    const skip = () => setSkipped(true);
    window.addEventListener("keydown", skip);
    window.addEventListener("pointerdown", skip);
    return () => {
      window.removeEventListener("keydown", skip);
      window.removeEventListener("pointerdown", skip);
    };
  }, [mode]);

  const lifting = mode === "lift" && (held || skipped);
  return (
    <motion.div
      className="stage"
      role={mode === "signin" ? "main" : undefined}
      aria-hidden={mode === "signin" ? undefined : true}
      initial={dropIn ? (reduced ? { opacity: 0 } : { y: "-100%" }) : false}
      animate={lifting ? (reduced ? { opacity: 0 } : { y: "-100%" }) : { y: 0, opacity: 1 }}
      transition={reduced ? { duration: 0.3 } : LIFT}
      onAnimationComplete={() => {
        if (lifting) onLifted();
      }}
    >
      <motion.div className={`stage-inner${mode === "signin" ? " is-signin" : ""}`} layout={!reduced} transition={{ type: "spring", duration: 0.6, bounce: 0 }}>
        <motion.h1 className="stage-wordmark" layout={!reduced} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ duration: 0.6, ease: [0.2, 0, 0, 1] }}>
          Kritva
          <motion.span className="stage-dot" aria-hidden="true" initial={{ scale: 0 }} animate={reduced ? { scale: 1 } : { scale: [0, 1.6, 1] }} transition={{ delay: reduced ? 0 : 0.45, duration: 0.55, ease: [0.2, 0, 0, 1] }} />
        </motion.h1>
        <AnimatePresence>{mode === "signin" && <SignInForm key="signin" linkError={linkError} />}</AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

type FormState = { kind: "idle" } | { kind: "sending" } | { kind: "sent"; email: string; inLog: boolean } | { kind: "error"; message: string };

/** Email in, a one-time sign-in link out. */
function SignInForm({ linkError }: { linkError: string | null }) {
  const reduced = useReducedMotion();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<FormState>(linkError ? { kind: "error", message: linkError } : { kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!value) return;
    setState({ kind: "sending" });
    // Signing in is the moment to ask once whether Kritva may say when an approval is waiting.
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission().catch(() => undefined);
    try {
      const sent = await api.auth.requestLink(value);
      setState({ kind: "sent", email: value, inLog: sent.via === "console" });
    } catch (e) {
      setState({ kind: "error", message: e instanceof ApiError ? e.message : "Something went wrong. Try again." });
    }
  };

  const enter = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4 } };
  return (
    <motion.div className="stage-signin" {...enter} transition={{ duration: 0.4, ease: [0.2, 0, 0, 1], delay: reduced ? 0 : 0.15 }}>
      <AnimatePresence mode="wait" initial={false}>
        {state.kind === "sent" ? (
          <motion.div key="sent" className="stage-sent" {...enter} transition={{ duration: 0.25 }} role="status">
            <p className="stage-title">Check your email.</p>
            <p className="stage-text">
              {state.inLog ? (
                <>The sign-in link for {state.email} is in the server's log. It works once, for 15 minutes.</>
              ) : (
                <>If {state.email} can sign in, a link is on its way. It works once, for 15 minutes.</>
              )}
            </p>
            <button type="button" className="stage-link" onClick={() => setState({ kind: "idle" })}>
              Use a different email
            </button>
          </motion.div>
        ) : (
          <motion.form key="form" className="stage-form" onSubmit={submit} {...enter} transition={{ duration: 0.25 }} noValidate>
            <label className="stage-text" htmlFor="signin-email">
              Sign in with your email. We'll send you a link.
            </label>
            <div className="stage-field">
              <input
                ref={inputRef}
                id="signin-email"
                className="stage-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                placeholder="you@company.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (state.kind === "error") setState({ kind: "idle" });
                }}
                aria-invalid={state.kind === "error" || undefined}
                aria-describedby={state.kind === "error" ? "signin-error" : undefined}
                disabled={state.kind === "sending"}
              />
              <button type="submit" className="button button-accent stage-submit" disabled={state.kind === "sending" || !email.trim()}>
                {state.kind === "sending" ? <span className="spinner" aria-hidden="true" /> : null}
                {state.kind === "sending" ? "Sending" : "Email me a link"}
                {state.kind !== "sending" && <ArrowRightIcon width={14} height={14} aria-hidden="true" />}
              </button>
            </div>
            {state.kind === "error" && (
              <p id="signin-error" className="stage-error" role="alert">
                {state.message}
              </p>
            )}
          </motion.form>
        )}
      </AnimatePresence>
      {state.kind !== "sent" && <PasskeyForm />}
    </motion.div>
  );
}

/** Below the email form: a shared passkey signs in at once (KRITVA_PASSKEY on the server). */
function PasskeyForm() {
  const [passkey, setPasskey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = passkey.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.passkey(value);
      // "/" is the landing page now: from /signin go to the console; anywhere else, reload the page in place.
      if (window.location.pathname === "/signin") window.location.assign("/negotiations");
      else window.location.reload();
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
    }
  };
  return (
    <form className="stage-form stage-passkey" onSubmit={submit} noValidate>
      <label className="stage-text" htmlFor="signin-passkey">
        Or sign in with a passkey.
      </label>
      <div className="stage-field">
        <input
          id="signin-passkey"
          className="stage-input"
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          placeholder="Passkey"
          value={passkey}
          onChange={(e) => {
            setPasskey(e.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "passkey-error" : undefined}
          disabled={busy}
        />
        <button type="submit" className="button stage-submit" disabled={busy || !passkey.trim()}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? "Signing in" : "Sign in"}
          {!busy && <ArrowRightIcon width={14} height={14} aria-hidden="true" />}
        </button>
      </div>
      {error && (
        <p id="passkey-error" className="stage-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
