import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type BuyerView, type MandateOption, type OperatorView } from "./api.ts";
import { Chat } from "./Chat.tsx";
import { RefreshIcon } from "./icons.tsx";
import { MandatesPage } from "./MandatesPage.tsx";
import { RecordPanel } from "./RecordPanel.tsx";
import { Select } from "./Select.tsx";

const POLL_MS = 2500;

function sessionFromHash(): string | null {
  const match = /(?:^|[#&])session=([\w-]+)/.exec(window.location.hash);
  return match?.[1] ?? null;
}

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(sessionFromHash());
  const [buyer, setBuyer] = useState<BuyerView | null>(null);
  const [operator, setOperator] = useState<OperatorView | null>(null);
  const [pending, setPending] = useState<{ text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [responding, setResponding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const reported = useRef(new Set<string>());
  const [mandates, setMandates] = useState<MandateOption[]>([]);
  const [mandateId, setMandateId] = useState<string | null>(null);
  const [view, setView] = useState<"negotiation" | "mandates">("negotiation");

  const loadMandates = useCallback(() => {
    api
      .listMandates()
      .then((list) => {
        setMandates(list);
        setMandateId((current) => (current && list.some((m) => m.id === current) ? current : (list[0]?.id ?? null)));
      })
      .catch(() => setConsoleError("Unable to load mandates."));
  }, []);
  useEffect(loadMandates, [loadMandates]);

  // Recover the last session after a refresh; otherwise start one.
  useEffect(() => {
    if (sessionId) return;
    (async () => {
      try {
        const sessions = await api.listSessions();
        const latest = sessions.at(-1);
        const id = latest ? latest.id : (await api.startSession("bed-sale/demo", null)).session.id;
        setSessionId(id);
      } catch (e) {
        setConsoleError(e instanceof ApiError ? e.message : "Unable to load sessions.");
      }
    })();
  }, [sessionId]);

  useEffect(() => {
    if (sessionId) window.history.replaceState(null, "", `#session=${sessionId}`);
  }, [sessionId]);

  const refresh = useCallback(async (id: string) => {
    try {
      const [b, o] = await Promise.all([api.buyerView(id), api.operatorView(id)]);
      setBuyer(b);
      setOperator(o);
      setConsoleError(null);
    } catch (e) {
      setConsoleError(e instanceof ApiError ? e.message : "Unable to load the session.");
    }
  }, []);

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
    setPending({ text });
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

  const respond = async (requestId: string, decision: "approved" | "rejected") => {
    if (!sessionId) return;
    setResponding(true);
    try {
      await api.respond(sessionId, requestId, decision);
      await refresh(sessionId);
    } catch (e) {
      setConsoleError(e instanceof ApiError ? e.message : "Unable to record your decision. Try again.");
    } finally {
      setResponding(false);
    }
  };

  const newSession = async () => {
    setStarting(true);
    try {
      const { session } = await api.startSession(mandateId ?? "bed-sale/demo", sessionId);
      reported.current.clear();
      setBuyer(null);
      setOperator(null);
      setError(null);
      setSessionId(session.id);
    } catch (e) {
      setConsoleError(e instanceof ApiError ? e.message : "Unable to start a new session.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="wordmark" aria-label="Kritva">
            Kritva<span className="wordmark-dot" aria-hidden="true" />
          </span>
          <span className="brand-context" hidden={view !== "negotiation"}>
            Negotiation slice · {mandates.find((m) => m.id === operator?.mandateId)?.title ?? "Confirmed seller mandate"}
          </span>
        </div>
        <nav className="view-switch" aria-label="Views">
          {(["negotiation", "mandates"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className="view-switch-item"
              aria-current={view === v ? "page" : undefined}
              onClick={() => {
                setView(v);
                if (v === "negotiation") loadMandates();
              }}
            >
              {v === "negotiation" ? "Negotiation" : "Mandates"}
            </button>
          ))}
        </nav>
        <div className="topbar-actions" hidden={view !== "negotiation"}>
          {sessionId && (
            <span className="mono session-id" title={`Session ${sessionId}${operator?.mandateId ? `, mandate ${operator.mandateId}` : ""}`}>
              {sessionId.slice(0, 12)}
            </span>
          )}
          <Select
            label="Mandate for new sessions"
            value={mandateId}
            options={mandates.map((m) => ({ value: m.id, label: m.title, description: m.description }))}
            onChange={setMandateId}
          />
          <button type="button" className="button button-secondary" onClick={newSession} disabled={starting}>
            {starting ? <span className="spinner" aria-hidden="true" /> : <RefreshIcon />}
            New session
          </button>
        </div>
      </header>
      {view === "mandates" ? (
        <MandatesPage
          onUse={(id) => {
            setMandateId(id);
            setView("negotiation");
            loadMandates();
          }}
        />
      ) : (
      <main className="layout">
        <h1 className="visually-hidden">Kritva negotiation slice</h1>
        <Chat view={buyer} pending={pending} sending={sending} error={error} onSend={(text) => send(text)} onRetry={retry} onDisplayed={onDisplayed} />
        <div className="panel-stack" style={{ display: "grid", gap: "var(--space-4)", minHeight: 0 }}>
          {consoleError && (
            <p className="composer-error" role="alert" style={{ margin: 0 }}>
              {consoleError}
            </p>
          )}
          <RecordPanel
            view={operator}
            responding={responding}
            onRespond={respond}
            onPause={async (paused) => {
              if (!sessionId) return;
              try {
                await api.setPaused(sessionId, paused);
              } catch (e) {
                setConsoleError(e instanceof ApiError ? e.message : "Unable to change the pause state.");
              }
              await refresh(sessionId);
            }}
            onChanged={() => sessionId && refresh(sessionId)}
          />
        </div>
      </main>
      )}
    </div>
  );
}
