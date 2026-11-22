import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type BuyerView, type Decision, type MandateOption, type OperatorView, type TermValue } from "./api.ts";
import { Chat } from "./Chat.tsx";
import { InsightsPanel } from "./InsightsPanel.tsx";
import { MandatesPage } from "./MandatesPage.tsx";
import { BoardPage } from "./BoardPage.tsx";
import { Select } from "./Select.tsx";

const POLL_MS = 2500;

function sessionFromHash(): string | null {
  const match = /(?:^|[#&])session=([\w-]+)/.exec(window.location.hash);
  return match?.[1] ?? null;
}

export function App() {
  // ?view=buyer is the counterparty's own page: the conversation only, nothing private.
  const counterpartyOnly = new URLSearchParams(window.location.search).get("view") === "buyer";
  const [sessionId, setSessionId] = useState<string | null>(sessionFromHash());
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const [access, setAccess] = useState(false);
  const [askKey, setAskKey] = useState(false);
  const [key, setKey] = useState("");
  const [checkingKey, setCheckingKey] = useState(false);
  const [chat, setChat] = useState<BuyerView | null>(null);
  const [operator, setOperator] = useState<OperatorView | null>(null);
  const [pending, setPending] = useState<{ id: string; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [responding, setResponding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const reported = useRef(new Set<string>());
  const [mandates, setMandates] = useState<MandateOption[]>([]);
  const [mandateId, setMandateId] = useState<string | null>(null);
  const [view, setView] = useState<"deals" | "negotiation" | "instructions">("negotiation");
  const [openMandate, setOpenMandate] = useState<string | null>(null);

  const loadMandates = useCallback(() => {
    if (counterpartyOnly) return;
    return api
      .listMandates()
      .then((list) => {
        setAccess(true);
        setAskKey(false);
        setKey("");
        setConsoleError(null);
        setMandates(list);
        setMandateId((current) => (current && list.some((m) => m.id === current) ? current : (list[0]?.id ?? null)));
      })
      .catch((e: unknown) => {
        setAccess(false);
        setOperator(null);
        if (!(e instanceof ApiError && e.status === 401) || api.hasSellerKey()) {
          setConsoleError(e instanceof ApiError ? e.message : "Unable to load your instructions.");
        }
      });
  }, [counterpartyOnly]);
  useEffect(() => { if (api.hasSellerKey()) void loadMandates(); }, [loadMandates]);

  // Reopen the latest negotiation when none is named in the address.
  useEffect(() => {
    if (!access || sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const sessions = await api.listSessions();
        if (!cancelled && !currentSession.current) setSessionId(sessions.at(-1)?.id ?? null);
      } catch (e) {
        setConsoleError(e instanceof ApiError ? e.message : "Unable to load negotiations.");
      }
    })();
    return () => { cancelled = true; };
  }, [access, sessionId]);

  useEffect(() => {
    if (sessionId) window.history.replaceState(null, "", `${window.location.search}#session=${sessionId}`);
  }, [sessionId]);

  const refresh = useCallback(async (id: string) => {
    try {
      const b = await api.buyerView(id);
      if (currentSession.current !== id) return;
      setChat(b);
      if (access) {
        const o = await api.operatorView(id);
        if (currentSession.current === id) setOperator(o);
      }
    } catch (e) {
      if (currentSession.current !== id) return;
      if (e instanceof ApiError && e.status === 401) {
        setAccess(false);
        setOperator(null);
      }
      (access ? setConsoleError : setError)(e instanceof ApiError ? e.message : "Unable to load the negotiation.");
    }
  }, [access]);
  const refreshCurrent = useCallback(() => {
    if (sessionId) void refresh(sessionId);
  }, [sessionId, refresh]);

  useEffect(() => {
    if (!sessionId) return;
    refresh(sessionId);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh(sessionId);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, refresh]);

  const onDisplayed = useCallback(
    (ids: string[]) => {
      if (!sessionId) return;
      for (const id of ids) {
        if (reported.current.has(id)) continue;
        reported.current.add(id);
        api.reportDelivered(sessionId, id).catch(() => reported.current.delete(id));
      }
    },
    [sessionId],
  );

  // A failed send keeps its ID, so retrying resumes the same turn instead of sending a duplicate.
  const [failed, setFailed] = useState<{ text: string; id: string } | null>(null);

  const send = async (text: string, id: string = crypto.randomUUID()) => {
    if (!sessionId) return;
    setError(null);
    setFailed(null);
    setPending({ id: `msg_${id}`, text });
    setSending(true);
    try {
      await api.send(sessionId, text, id);
      await refresh(sessionId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Unable to send. Try again.");
      setFailed({ text, id });
      await refresh(sessionId);
    } finally {
      setPending(null);
      setSending(false);
    }
  };
  const retry = failed ? () => send(failed.text, failed.id) : null;

  // A new approval waiting: say so in the tab title, and with a notification when the tab is in the background.
  const waitingId = access ? (operator?.state.pendingApproval?.requestId ?? null) : null;
  const notified = useRef<string | null>(null);
  useEffect(() => {
    const base = document.title.replace(/^\(1\) /, "");
    document.title = waitingId ? `(1) ${base}` : base;
    if (!waitingId || notified.current === waitingId) return;
    notified.current = waitingId;
    if (document.visibilityState === "visible" || typeof Notification === "undefined") return;
    if (Notification.permission === "granted") new Notification("Kritva: your approval is needed", { body: "An offer is waiting for your decision." });
  }, [waitingId]);

  /** Approve, counter or decline. True when the decision was recorded. */
  const decide = async (requestId: string, decision: Decision, extra: { message?: string; counterTerms?: Array<{ termId: string; value: TermValue }> }): Promise<boolean> => {
    if (!sessionId) return false;
    setResponding(true);
    try {
      const request = operator?.state.pendingApproval;
      if (!request || request.requestId !== requestId) throw new ApiError(409, "That request changed. Review the current one.");
      // The decision names the exact offer version and instruction revision on screen.
      await api.decide(sessionId, requestId, decision, request.offerId, request.mandateRevision, extra);
      setConsoleError(null);
      await refresh(sessionId);
      return true;
    } catch (e) {
      setConsoleError(e instanceof ApiError ? e.message : "Unable to record your decision. Try again.");
      return false;
    } finally {
      setResponding(false);
    }
  };

  const setPaused = async (paused: boolean) => {
    if (!sessionId) return;
    try {
      await api.setPaused(sessionId, paused);
      setConsoleError(null);
    } catch (e) {
      setConsoleError(e instanceof ApiError ? e.message : "Unable to change the pause state.");
    }
    await refresh(sessionId);
  };

  /** Editing instructions pauses the negotiation first, then opens them. */
  const editInstructions = async () => {
    if (!sessionId || !operator?.mandateId?.startsWith("library:")) return;
    try {
      if (!operator.state.paused && !["agreed", "no_agreement", "ended"].includes(operator.state.status)) await api.setPaused(sessionId, true);
    } catch (e) {
      setConsoleError(e instanceof ApiError ? e.message : "Unable to pause before editing instructions.");
      return;
    }
    setOpenMandate(operator.mandateId.slice("library:".length));
    setView("instructions");
  };

  const newNegotiation = async () => {
    if (!mandateId) return;
    setStarting(true);
    try {
      const { session } = await api.startSession(mandateId, sessionId);
      reported.current.clear();
      setChat(null);
      setOperator(null);
      setError(null);
      setSessionId(session.id);
      setView("negotiation");
    } catch (e) {
      setConsoleError(e instanceof ApiError ? e.message : "Unable to start a negotiation.");
    } finally {
      setStarting(false);
    }
  };

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (!askKey) { setAskKey(true); return; }
    setCheckingKey(true);
    // Opening the console is the moment to ask once whether Kritva may say when an approval is waiting.
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission().catch(() => undefined);
    api.rememberSellerKey(key.trim());
    try { await loadMandates(); } finally { setCheckingKey(false); }
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="wordmark" aria-label="Kritva">
          Kritva<span className="wordmark-dot" aria-hidden="true" />
        </span>
        {access && (
          <nav className="view-switch" aria-label="Views">
            {(["deals", "negotiation", "instructions"] as const).map((v) => (
              <button
                key={v}
                type="button"
                className="view-switch-item"
                aria-current={view === v ? "page" : undefined}
                onClick={() => {
                  setView(v);
                  if (v === "negotiation" || v === "deals") loadMandates();
                  if (v !== "negotiation") setOpenMandate(null);
                }}
              >
                {v === "deals" ? "Deals" : v === "negotiation" ? "Negotiation" : "Mandates"}
              </button>
            ))}
          </nav>
        )}
        <div className="topbar-actions">
          {access && view === "negotiation" && (
            <>
              <Select
                label="Mandate for a new negotiation"
                value={mandateId}
                options={mandates.map((m) => ({ value: m.id, label: m.title, description: m.description }))}
                onChange={setMandateId}
              />
              <button type="button" className="button button-neutral" onClick={newNegotiation} disabled={starting || !mandateId}>
                {starting && <span className="spinner" aria-hidden="true" />}
                New negotiation
              </button>
            </>
          )}
          {!access && !counterpartyOnly && (
            <form className="unlock" onSubmit={unlock}>
              {askKey && <input className="seller-key" type="password" aria-label="Access key" placeholder="Access key" autoFocus required value={key} onChange={(e) => setKey(e.target.value)} />}
              <button type="submit" className="button button-secondary" disabled={checkingKey}>{askKey ? "Unlock" : "Open console"}</button>
            </form>
          )}
        </div>
      </header>

      {access && view === "deals" && (
        <BoardPage
          onOpen={(id) => {
            setSessionId(id);
            setView("negotiation");
          }}
        />
      )}
      {access && view === "instructions" && (
        <MandatesPage
          initialId={openMandate}
          onUse={(id) => {
            setMandateId(id);
            setView("negotiation");
            loadMandates();
          }}
        />
      )}
      <main className={access ? "layout" : "layout layout-single"} hidden={access && view !== "negotiation"}>
        <h1 className="visually-hidden">Kritva</h1>
        <Chat
          key={sessionId ?? "none"}
          view={chat}
          pending={pending}
          sending={sending}
          error={error}
          disclose={!access}
          onSend={(text) => send(text)}
          onRetry={retry}
          onDisplayed={onDisplayed}
          voice={{ sessionId, onTurn: refreshCurrent }}
        />
        {!counterpartyOnly && consoleError && !access && <p className="composer-error" role="alert">{consoleError}</p>}
        {access && (
          <div className="side">
            {consoleError && <p className="composer-error" role="alert">{consoleError}</p>}
            <InsightsPanel
              view={operator}
              responding={responding}
              sessionId={sessionId}
              onDecide={decide}
              onPause={setPaused}
              onEditInstructions={operator?.mandateId?.startsWith("library:") ? editInstructions : null}
            />
          </div>
        )}
      </main>
    </div>
  );
}
