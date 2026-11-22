/**
 * The intake chat: the principal tells Kritva's setup agent what to negotiate, in words or with
 * pictures, and makes the result live from the chat. The progress bar on top follows what the agent
 * has gathered; the card that ends the intake shows exactly what will go live.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { api, ApiError, type IntakeMessageView, type IntakeView, type LibraryExample, type MandateReview, type PrincipalSide } from "./api.ts";
import { AlertIcon, CheckIcon, ImageIcon, LockIcon, SendIcon, SparkIcon, XIcon } from "./icons.tsx";

const spring = { type: "spring", duration: 0.35, bounce: 0 } as const;
const MAX_IMAGES = 4;
const MAX_EDGE = 1600;

interface Props {
  view: IntakeView;
  examples: LibraryExample[];
  onChange: (view: IntakeView) => void;
  /** After a mandate is created or goes live, so the list can refresh. */
  onSaved: () => void;
  onUse: (mandateOptionId: string) => void;
}

type Phase = "idle" | "sending" | "preparing" | "going-live";
interface Attachment {
  id: string;
  url: string;
}

export function IntakeChat({ view, examples, onChange, onSaved, onUse }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pending, setPending] = useState<{ text: string; images: string[] } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<{ message: string; retry: (() => void) | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reduced = useReducedMotion();
  const busy = phase !== "idle";
  const hasUserMessage = view.messages.some((m) => m.role === "user");

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [view.messages.length, pending, phase, reduced]);

  // A finished agent turn that said "ready" goes straight to mapping, so the person never has to ask.
  const prepareRef = useRef<string | null>(null);
  useEffect(() => {
    if (view.next !== "prepare" || phase !== "idle" || prepareRef.current === view.id + view.messages.length) return;
    prepareRef.current = view.id + view.messages.length;
    void prepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.next, view.id, view.messages.length, phase]);

  const prepare = async () => {
    setPhase("preparing");
    setError(null);
    try {
      const next = await api.intake.prepare(view.id);
      onChange(next);
      onSaved();
    } catch (e) {
      setError({ message: e instanceof ApiError ? e.message : "I couldn't put it together just now. Try again.", retry: () => void prepare() });
    } finally {
      setPhase("idle");
    }
  };

  const send = async (body: string, images: string[]) => {
    if (busy || (!body.trim() && images.length === 0)) return;
    setError(null);
    setPending({ text: body.trim(), images });
    setText("");
    setAttachments([]);
    setPhase("sending");
    try {
      onChange(await api.intake.send(view.id, body, images));
    } catch (e) {
      // Nothing was saved: put the message back so it can be sent again.
      setText(body);
      setAttachments(images.map((url) => ({ id: crypto.randomUUID(), url })));
      setError({ message: e instanceof ApiError ? e.message : "That didn't go through. Try again.", retry: null });
    } finally {
      setPending(null);
      setPhase("idle");
      inputRef.current?.focus();
    }
  };

  const goLive = async (versionId: string, draftHash: string) => {
    setPhase("going-live");
    setError(null);
    try {
      onChange(await api.intake.goLive(view.id, versionId, draftHash));
      onSaved();
    } catch (e) {
      setError({ message: e instanceof ApiError ? e.message : "It couldn't go live just now. Nothing changed; try again.", retry: null });
    } finally {
      setPhase("idle");
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    const room = MAX_IMAGES - attachments.length;
    if (room <= 0) {
      setError({ message: `You can add up to ${MAX_IMAGES} pictures at a time.`, retry: null });
      return;
    }
    try {
      const urls = await Promise.all(images.slice(0, room).map(downscale));
      setAttachments((a) => [...a, ...urls.map((url) => ({ id: crypto.randomUUID(), url }))]);
      setError(images.length > room ? { message: `Added ${room}. You can add up to ${MAX_IMAGES} pictures at a time.`, retry: null } : null);
    } catch {
      setError({ message: "That picture couldn't be read. Try a PNG or JPEG.", retry: null });
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(text, attachments.map((a) => a.url));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(text, attachments.map((a) => a.url));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  };

  const enter = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 } } : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } };
  const lastCard = [...view.messages].reverse().find((m) => m.card)?.card ?? null;
  // Settled: the chat matches a confirmed revision, with nothing waiting to go live.
  const settled = (view.state === "live" || view.state === "paused" || view.state === "closed") && view.progress === 1 && lastCard?.kind !== "ready";

  return (
    <section
      className="panel intake"
      aria-labelledby="intake-title"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="panel-header intake-header">
        <div className="intake-heading">
          <h2 className="panel-title" id="intake-title" title={view.title}>
            {view.title}
          </h2>
          <StateChip state={view.state === "new" && hasUserMessage ? "draft" : view.state} />
        </div>
        {view.state === "live" && view.mandateId && (
          <button type="button" className="button button-neutral" onClick={() => onUse(`library:${view.mandateId}`)}>
            Use for the next negotiation
          </button>
        )}
      </header>

      <Progress view={view} settled={settled} />

      <div className="chat-log intake-log" ref={logRef} role="log" aria-label="Setup conversation" aria-live="polite">
        <AnimatePresence initial={false}>
          {view.messages.map((m) => (
            <motion.div key={m.id} className={`bubble-row ${m.role === "user" ? "from-buyer" : "from-agent"}`} {...enter} transition={spring}>
              <MessageBody message={m} />
              {m.card?.kind === "ready" && <ReadyCard card={m.card} view={view} busy={busy} going={phase === "going-live"} onGoLive={goLive} />}
              {m.card?.kind === "live" && (
                <span className="live-pill">
                  <span className="live-dot" aria-hidden="true" />
                  Live · revision {m.card.revision}
                </span>
              )}
            </motion.div>
          ))}
          {!hasUserMessage && !pending && examples.length > 0 && (
            <motion.div key="examples" className="intake-examples" {...enter} exit={{ opacity: 0 }} transition={spring}>
              <span className="intake-examples-label">Or try an example</span>
              {examples.map((e) => (
                <button key={e.id} type="button" className="chip-button" disabled={busy} onClick={() => void send(`${e.publicText}\n\n${e.privateText}`.trim(), [])}>
                  {e.title}
                </button>
              ))}
            </motion.div>
          )}
          {pending && (
            <motion.div key="pending" className="bubble-row from-buyer" {...enter} transition={spring}>
              <MessageBody message={{ id: "pending", role: "user", text: pending.text, images: pending.images, at: "", card: null }} pending />
            </motion.div>
          )}
          {(phase === "sending" || phase === "preparing") && (
            <motion.div key={`working-${phase}`} className="typing" {...enter} exit={{ opacity: 0 }} transition={spring}>
              {phase === "preparing" ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Putting it together. This takes about 10 seconds.
                </>
              ) : (
                <>
                  <span className="typing-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  Kritva is thinking
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <form className="intake-composer" onSubmit={onSubmit}>
        <AnimatePresence initial={false}>
          {attachments.length > 0 && (
            <motion.ul key="attachments" className="attachments" aria-label="Pictures to send" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring}>
              {attachments.map((a, i) => (
                <li key={a.id} className="attachment">
                  <img src={a.url} alt={`Picture ${i + 1}`} />
                  <button type="button" className="attachment-remove" aria-label={`Remove picture ${i + 1}`} onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}>
                    <XIcon width={12} height={12} />
                  </button>
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
        <div className={`intake-input${dragging ? " is-dragging" : ""}`}>
          <button type="button" className="icon-button" aria-label="Add a picture or screenshot" onClick={() => fileRef.current?.click()} disabled={busy || attachments.length >= MAX_IMAGES}>
            <ImageIcon />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <label htmlFor="intake-message" className="visually-hidden">
            Message to Kritva
          </label>
          <textarea
            id="intake-message"
            ref={inputRef}
            rows={1}
            value={text}
            placeholder={dragging ? "Drop the picture here" : hasUserMessage ? "Reply to Kritva" : "What would you like Kritva to negotiate?"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            maxLength={8000}
            autoComplete="off"
            aria-describedby="intake-hint"
          />
          <button type="submit" className="send-button" aria-label="Send" disabled={busy || (!text.trim() && attachments.length === 0)}>
            {phase === "sending" ? <span className="spinner" aria-hidden="true" /> : <SendIcon />}
          </button>
        </div>
        {error && (
          <div className="composer-error" role="alert">
            <AlertIcon />
            <span style={{ flex: 1 }}>{error.message}</span>
            {error.retry && (
              <button type="button" className="button button-secondary button-small" onClick={error.retry} disabled={busy}>
                Try again
              </button>
            )}
          </div>
        )}
        <p className="composer-hint" id="intake-hint">
          Enter to send, Shift+Enter for a new line. Paste or drop a picture to share it.
        </p>
      </form>
    </section>
  );
}

function MessageBody({ message, pending = false }: { message: IntakeMessageView; pending?: boolean }) {
  const mine = message.role === "user";
  return (
    <>
      {message.images.length > 0 && (
        <div className={`bubble-images${pending ? " bubble-pending" : ""}`}>
          {message.images.map((src, i) => (
            <img key={i} src={src} alt={mine ? `Picture you shared (${i + 1})` : ""} />
          ))}
        </div>
      )}
      {message.text && <div className={`bubble${pending ? " bubble-pending" : ""}`}>{message.text}</div>}
      {!mine && (
        <span className="bubble-meta">
          <SparkIcon width={12} height={12} style={{ verticalAlign: -2, marginInlineEnd: 4 }} />
          Kritva setup
        </span>
      )}
    </>
  );
}

/** Which side the principal is on, in words, so the meaning never rests on colour. */
export function SideChip({ side }: { side: PrincipalSide | null | undefined }) {
  if (!side) return null;
  return <span className="state-chip side-chip">{side === "pays" ? "Buying" : "Selling"}</span>;
}

export function StateChip({ state }: { state: IntakeView["state"] }) {
  if (state === "new") return <span className="state-chip state-draft">New</span>;
  const label = { live: "Live", paused: "Paused", closed: "Closed", draft: "Draft" }[state];
  return (
    <span className={`state-chip state-${state}`}>
      {state === "live" && <span className="live-dot" aria-hidden="true" />}
      {label}
    </span>
  );
}

function Progress({ view, settled }: { view: IntakeView; settled: boolean }) {
  const reduced = useReducedMotion();
  const required = view.checklist.filter((c) => c.required);
  const done = required.filter((c) => c.status !== "missing").length;
  const next = required.find((c) => c.status === "missing");
  const label = settled
    ? { live: "Live and in use", paused: "Paused. Resume it from the list to use it again.", closed: "Closed. Reopen it from the list to use it again." }[view.state as "live" | "paused" | "closed"]
    : view.progress >= 1
      ? "Ready to go live"
      : next
        ? `Next: ${next.label.toLowerCase()}`
        : "Putting it together";
  return (
    <div className="intake-progress">
      <div className="intake-progress-text">
        <span>{label}</span>
        <span className="tabular">{settled || view.progress >= 1 ? "Done" : `${done} of ${required.length}`}</span>
      </div>
      <div className="progress-track" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.progress * 100)} aria-valuetext={label}>
        <motion.div className="progress-fill" initial={false} animate={{ scaleX: Math.max(0.02, view.progress) }} transition={reduced ? { duration: 0 } : { type: "spring", duration: 0.6, bounce: 0 }} />
      </div>
    </div>
  );
}

function ReadyCard({ card, view, busy, going, onGoLive }: { card: Extract<NonNullable<IntakeMessageView["card"]>, { kind: "ready" }>; view: IntakeView; busy: boolean; going: boolean; onGoLive: (versionId: string, draftHash: string) => void }) {
  const version = view.mandate?.versions.find((v) => v.versionId === card.versionId);
  const update = card.mode === "update";
  return (
    <div className={`ready-card${card.actionable ? "" : " is-settled"}`}>
      <div className="ready-card-head">
        <span className="ready-card-eyebrow">{update ? "Your changes" : "Ready to go live"}</span>
        <h3 className="ready-card-title">{view.title}</h3>
        {card.review && (
          <p className="ready-card-sub">
            You're the {card.review.parties.you}, dealing with the {card.review.parties.other}.
            {card.review.side === "pays" && " Kritva will work to bring the price down for you."}
            {card.review.side === "receives" && " Kritva will work to get you the best price."}
          </p>
        )}
      </div>
      {card.review && <Summary review={card.review} />}
      {card.notes.length > 0 && card.actionable && (
        <div className="ready-card-notes">
          <span className="ready-card-notes-title">Good to know</span>
          <ul>
            {card.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {card.actionable ? (
        <div className="ready-card-actions">
          <button type="button" className="button button-accent" disabled={busy} onClick={() => onGoLive(card.versionId, card.draftHash)}>
            {going && <span className="spinner" aria-hidden="true" />}
            {going ? "Making it live" : update ? "Apply changes" : "Make it live"}
          </button>
          <span className="ready-card-hint">Not right? Just tell me what to change.</span>
        </div>
      ) : (
        <p className="ready-card-settled">
          <CheckIcon width={14} height={14} />
          {version?.status === "confirmed" ? `Went live as revision ${version.revision}` : "Replaced by a newer version"}
        </p>
      )}
    </div>
  );
}

/** The few lines that matter most, with everything else one click away. */
function Summary({ review }: { review: MandateReview }) {
  const section = (id: string) => review.sections.find((s) => s.id === id)?.items ?? [];
  const key = [...section("terms"), ...section("limits"), ...section("permissions")];
  const rest = ["facts", "goals", "conditions"].map((id) => review.sections.find((s) => s.id === id)).filter((s) => s && s.items.length > 0);
  return (
    <>
      <dl className="ready-card-rows">
        {key.map((item) => (
          <div key={item.recordId} className="ready-card-row">
            <dt>
              {item.label}
              {item.private && (
                <span className="private-mark" title="Only Kritva sees this">
                  <LockIcon width={12} height={12} />
                  <span className="visually-hidden">(only Kritva sees this)</span>
                </span>
              )}
            </dt>
            <dd>{item.text}</dd>
          </div>
        ))}
      </dl>
      {rest.length > 0 && (
        <details className="ready-card-more">
          <summary>Everything Kritva will know</summary>
          {rest.map((s) => (
            <div key={s!.id} className="ready-card-more-group">
              <span className="ready-card-more-title">{s!.title}</span>
              <ul>
                {s!.items.map((i) => (
                  <li key={i.recordId}>
                    {i.text}
                    {i.private && <LockIcon width={12} height={12} className="private-inline" aria-label="Only Kritva sees this" />}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
    </>
  );
}

/** Pictures are resized in the browser so a phone photo uploads quickly. */
async function downscale(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}
