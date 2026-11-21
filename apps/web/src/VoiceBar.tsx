import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type BuyerMessage } from "./api.ts";
import { AlertIcon, MicIcon, MicOffIcon, PhoneOffIcon } from "./icons.tsx";
import { VoiceSession, type VoiceState } from "./voice.ts";

const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;

const STATE_LABEL: Record<VoiceState, string> = {
  idle: "Voice is off",
  connecting: "Connecting",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Kritva is thinking",
  speaking: "Kritva is speaking",
  muted: "Muted",
  interrupted: "Stopped. Go ahead",
  ended: "Call ended",
  error: "Voice stopped",
};

interface Props {
  sessionId: string | null;
  messages: BuyerMessage[];
  /** Start the call as soon as the bar mounts (the listing's Call Seller button). */
  autoStart?: boolean;
  onActiveChange: (active: boolean) => void;
  /** Ask the page to reload the session after a turn. */
  onTurn: () => void;
}

/**
 * The buyer's voice controls (Epic 13). One call per session: Start, Mute, End. Kritva's replies
 * are recorded and checked by the server before they can be played, so this component only plays
 * messages that already exist in the record, in order, once.
 */
export function VoiceBar({ sessionId, messages, autoStart = false, onActiveChange, onTurn }: Props) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ transcript: string; ms: number | null } | null>(null);
  const session = useRef<VoiceSession | null>(null);
  const spoken = useRef(new Set<string>());
  const queue = useRef<Array<{ id: string; text: string }>>([]);
  const playing = useRef(false);
  const startedAt = useRef<number>(0);
  const reduced = useReducedMotion();
  const active = state !== "idle" && state !== "ended" && state !== "error";

  useEffect(() => onActiveChange(active), [active, onActiveChange]);

  const drain = useCallback(async () => {
    if (playing.current || !session.current || !sessionId) return;
    const next = queue.current.shift();
    if (!next) return;
    playing.current = true;
    await session.current.play(next.id, next.text, api.speechUrl(sessionId, next.id));
    playing.current = false;
    drain();
  }, [sessionId]);

  // Every new reply recorded after the call started is spoken once, in order (including a reply that
  // follows the seller's approval while the call is on).
  useEffect(() => {
    if (!active) return;
    for (const m of messages) {
      if (m.from !== "agent" || spoken.current.has(m.id)) continue;
      spoken.current.add(m.id);
      if (new Date(m.at).getTime() < startedAt.current - 2_000) continue;
      queue.current.push({ id: m.id, text: m.text });
    }
    drain();
  }, [messages, active, drain]);

  const start = useCallback(async () => {
    if (!sessionId || session.current) return;
    setError(null);
    // Replies that already exist are history; only new ones are spoken.
    for (const m of messages) if (m.from === "agent") spoken.current.add(m.id);
    startedAt.current = Date.now();
    const v = new VoiceSession({
      onState: setState,
      onError: setError,
      onPlayed: (messageId, audioStartMs) => {
        api.reportVoiceDelivery(sessionId, messageId, "delivered", null, audioStartMs).catch(() => undefined);
        setLast((l) => (l ? { ...l, ms: l.ms ?? audioStartMs } : l));
        onTurn();
      },
      onInterrupted: (messageId, heard) => {
        // Cut off: never counts as delivered, so a half-heard offer or read-back can't be accepted.
        api.reportVoiceDelivery(sessionId, messageId, "interrupted", heard, null).catch(() => undefined);
        queue.current = [];
        onTurn();
      },
      onUtterance: async (wav) => {
        v.setBusy(true);
        try {
          const result = await api.voiceUtterance(sessionId, crypto.randomUUID(), wav);
          setLast({ transcript: result.transcript, ms: null });
          if (result.reply && !spoken.current.has(result.reply.messageId)) {
            spoken.current.add(result.reply.messageId);
            queue.current.push({ id: result.reply.messageId, text: result.reply.text });
          }
          onTurn();
        } catch (e) {
          setError(e instanceof ApiError ? e.message : "That didn't go through. Nothing was sent.");
        } finally {
          v.setBusy(false);
          drain();
        }
      },
    });
    session.current = v;
    if (!(await v.start())) {
      session.current = null;
      return;
    }
    try {
      const greeting = await api.voiceStart(sessionId);
      if (greeting.reply && !spoken.current.has(greeting.reply.messageId)) {
        spoken.current.add(greeting.reply.messageId);
        queue.current.push({ id: greeting.reply.messageId, text: greeting.reply.text });
      }
      onTurn();
      drain();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Voice couldn't connect. You can keep typing.");
      v.end();
      session.current = null;
    }
  }, [sessionId, messages, drain, onTurn]);

  const end = useCallback(() => {
    session.current?.end();
    session.current = null;
    queue.current = [];
    playing.current = false;
  }, []);

  // A new session or leaving the page ends the call.
  useEffect(() => end, [sessionId, end]);

  const started = useRef(false);
  useEffect(() => {
    if (autoStart && sessionId && !started.current) {
      started.current = true;
      start();
    }
  }, [autoStart, sessionId, start]);

  const muted = state === "muted";
  return (
    <div className={`voice-bar${active ? " is-active" : ""}`} role="group" aria-label="Voice call">
      <div className="voice-status" aria-live="polite">
        <span className={`voice-dot voice-dot-${state}`} aria-hidden="true" />
        <span className="voice-label">{STATE_LABEL[state]}</span>
        {last && active && (
          <span className="voice-heard">
            Heard: “{last.transcript}”{last.ms !== null ? ` · reply started after ${(last.ms / 1000).toFixed(1)}s` : ""}
          </span>
        )}
      </div>
      <div className="voice-actions">
        {!active ? (
          <button type="button" className="button button-accent" onClick={start} disabled={!sessionId}>
            <MicIcon />
            {state === "ended" || state === "error" ? "Start voice again" : "Talk by voice"}
          </button>
        ) : (
          <>
            <button type="button" className="button button-secondary" onClick={() => session.current?.setMuted(!muted)} aria-pressed={muted} disabled={state === "connecting"}>
              {muted ? <MicIcon /> : <MicOffIcon />}
              {muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" className="button button-neutral" onClick={end}>
              <PhoneOffIcon />
              End voice
            </button>
          </>
        )}
      </div>
      <AnimatePresence initial={false}>
        {error && (
          <motion.p key={error} className="composer-error voice-error" role="alert" initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
            <AlertIcon />
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
