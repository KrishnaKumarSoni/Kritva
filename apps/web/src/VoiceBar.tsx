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
  paused: boolean;
  /** Start the call as soon as the bar mounts (the listing's Call Seller button). */
  startRequest?: number;
  onActiveChange: (active: boolean) => void;
  /** Ask the page to reload the session after a turn. */
  onTurn: () => void;
}

/**
 * The buyer's voice controls (Epic 13). One call per session: Start, Mute, End. Kritva's replies
 * are recorded and checked by the server before they can be played, so this component only plays
 * messages that already exist in the record, in order, once.
 */
export function VoiceBar({ sessionId, messages, paused, startRequest = 0, onActiveChange, onTurn }: Props) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ transcript: string; ms: number | null } | null>(null);
  const session = useRef<VoiceSession | null>(null);
  const spoken = useRef(new Set<string>());
  const queue = useRef<Array<{ id: string; text: string }>>([]);
  const playing = useRef<VoiceSession | null>(null);
  const afterSeq = useRef<number | null>(null);
  const delivery = useRef(Promise.resolve());
  const reduced = useReducedMotion();
  const active = state !== "idle" && state !== "ended" && state !== "error";

  useEffect(() => onActiveChange(active), [active, onActiveChange]);

  const drain = useCallback(async () => {
    const call = session.current;
    if (playing.current || !call || !sessionId || afterSeq.current === null) return;
    const next = queue.current.shift();
    if (!next) return;
    playing.current = call;
    await call.play(next.id, next.text, api.speechUrl(sessionId, next.id));
    if (playing.current === call) playing.current = null;
    if (session.current === call) void drain();
  }, [sessionId]);

  // Every new reply recorded after the call started is spoken once, in order (including a reply that
  // follows the seller's approval while the call is on).
  useEffect(() => {
    if (!active || afterSeq.current === null) return;
    for (const m of messages) {
      if (m.from !== "agent" || m.channel !== "voice" || m.seq <= afterSeq.current || spoken.current.has(m.id)) continue;
      spoken.current.add(m.id);
      queue.current.push({ id: m.id, text: m.text });
    }
    drain();
  }, [messages, active, drain]);

  const end = useCallback(() => {
    const call = session.current;
    if (!call) return;
    call.end();
    session.current = null;
    afterSeq.current = null;
    queue.current = [];
    playing.current = null;
  }, []);

  const disconnect = useCallback(() => {
    if (!session.current || !sessionId) return;
    end();
    setError("Voice was interrupted. Start voice again to continue.");
    if (navigator.onLine) void api.voiceInterrupted(sessionId).then(onTurn).catch(() => undefined);
    else window.addEventListener("online", () => { void api.voiceInterrupted(sessionId).then(onTurn).catch(() => undefined); }, { once: true });
  }, [end, onTurn, sessionId]);
  const disconnectRef = useRef(disconnect);
  disconnectRef.current = disconnect;

  useEffect(() => {
    const interrupted = () => disconnectRef.current();
    window.addEventListener("offline", interrupted);
    window.addEventListener("pagehide", interrupted);
    return () => {
      window.removeEventListener("offline", interrupted);
      window.removeEventListener("pagehide", interrupted);
      end();
    };
  }, [end]);

  useEffect(() => {
    if (paused) session.current?.interrupt();
  }, [paused]);

  const start = useCallback(async () => {
    if (!sessionId || session.current) return;
    setError(null);
    setLast(null);
    spoken.current.clear();
    const report = (messageId: string, status: "delivered" | "interrupted" | "failed", heard: string | null, ms: number | null) => {
      // Preserve ordering when the next utterance follows immediately after a reply.
      delivery.current = delivery.current.then(async () => {
        await api.reportVoiceDelivery(sessionId, messageId, status, heard, ms);
        onTurn();
      }).catch(() => {
        setError("The reply's delivery couldn't be saved. Please confirm the terms again.");
      });
    };
    const v = new VoiceSession({
      onState: setState,
      onError: setError,
      onPlayed: (messageId, audioStartMs) => {
        report(messageId, "delivered", null, audioStartMs);
        setLast((l) => (l ? { ...l, ms: l.ms ?? audioStartMs } : l));
      },
      onInterrupted: (messageId, heard, audioStartMs) => {
        // Cut off: never counts as delivered, so a half-heard offer or read-back can't be accepted.
        report(messageId, "interrupted", heard, audioStartMs);
        queue.current = [];
      },
      onPlaybackFailed: (messageId) => report(messageId, "failed", null, null),
      onDisconnected: () => disconnectRef.current(),
      onUtterance: async (wav) => {
        v.setBusy(true);
        try {
          await delivery.current;
          if (session.current !== v) return;
          const result = await api.voiceUtterance(sessionId, crypto.randomUUID(), wav);
          if (session.current !== v) return;
          setLast({ transcript: result.transcript, ms: null });
          if (result.reply && !spoken.current.has(result.reply.messageId)) {
            spoken.current.add(result.reply.messageId);
            queue.current.push({ id: result.reply.messageId, text: result.reply.text });
          }
          onTurn();
        } catch (e) {
          if (session.current === v) {
            if (e instanceof ApiError && e.status === 0) disconnectRef.current();
            else setError(e instanceof ApiError ? e.message : "That didn't go through. Try again.");
          }
        } finally {
          if (session.current === v) {
            v.setBusy(false);
            void drain();
          }
        }
      },
    });
    session.current = v;
    if (!(await v.start())) {
      if (session.current === v) session.current = null;
      return;
    }
    try {
      const greeting = await api.voiceStart(sessionId);
      if (session.current !== v) return;
      afterSeq.current = greeting.afterSeq;
      if (greeting.reply && !spoken.current.has(greeting.reply.messageId)) {
        spoken.current.add(greeting.reply.messageId);
        queue.current.push({ id: greeting.reply.messageId, text: greeting.reply.text });
      }
      v.setBusy(false);
      onTurn();
      void drain();
    } catch (e) {
      if (session.current !== v) return;
      setError(e instanceof ApiError ? e.message : "Voice couldn't connect. You can keep typing.");
      end();
    }
  }, [sessionId, drain, onTurn, end]);

  const started = useRef(0);
  useEffect(() => {
    if (!startRequest || !sessionId || started.current === startRequest) return;
    const timer = window.setTimeout(() => {
      started.current = startRequest;
      void start();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [startRequest, sessionId, start]);

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
