import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { api, ApiError, type BuyerView, type Decision, type MandateOption, type NegotiationLogRow, type OperatorView, type TermValue } from "./api.ts";
import { NegotiationLog, howOf, whoOf } from "./NegotiationLog.tsx";
import { Chat } from "./Chat.tsx";
import { InsightsPanel } from "./InsightsPanel.tsx";
import { MandatesPage } from "./MandatesPage.tsx";
import { BoardPage } from "./BoardPage.tsx";

const POLL_MS = 2500;

function sessionFromHash(): string | null {
  const match = /(?:^|[#&])session=([\w-]+)/.exec(window.location.hash);
  return match?.[1] ?? null;
}

type View = "deals" | "negotiation" | "instructions";
const NAV: Array<{ view: View; label: string; path: string }> = [
  { view: "deals", label: "Deals", path: "/deals" },
  { view: "negotiation", label: "Negotiations", path: "/negotiations" },
  { view: "instructions", label: "Mandates", path: "/mandates" },
];

/** Each console page has its own address: /deals, /negotiations (and /negotiations/<id>), /mandates (and /mandates/<id>). */
function routeFromLocation(): { view: View; sessionId: string | null; mandateId: string | null } {
  const [first, second] = window.location.pathname.split("/").filter(Boolean);
  if (first === "deals") return { view: "deals", sessionId: null, mandateId: null };
  if (first === "mandates") return { view: "instructions", sessionId: null, mandateId: second ?? null };
  // Older links name the negotiation in the hash (#session=...).
  return { view: "negotiation", sessionId: (first === "negotiations" ? second : undefined) ?? sessionFromHash(), mandateId: null };
}

export function App() {
  // ?view=buyer is the counterparty's own page: the conversation only, nothing private.
  const counterpartyOnly = new URLSearchParams(window.location.search).get("view") === "buyer";
  const [initialRoute] = useState(() => (counterpartyOnly ? { view: "negotiation" as View, sessionId: sessionFromHash(), mandateId: null } : routeFromLocation()));
  const [sessionId, setSessionId] = useState<string | null>(initialRoute.sessionId);
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
  const [view, setView] = useState<View>(initialRoute.view);
  const reducedMotion = useReducedMotion();
  // The Negotiations page shows the log of every negotiation, or one negotiation opened from it.
  const [negMode, setNegMode] = useState<"log" | "session">(initialRoute.sessionId ? "session" : "log");
  // What the log knows about the open negotiation: who it is with, and whether it is a test.
  const [openRow, setOpenRow] = useState<NegotiationLogRow | null>(null);
  const [openMandate, setOpenMandate] = useState<string | null>(initialRoute.mandateId);

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

  // The address follows the page. The counterparty's own page keeps its link (?view=buyer#session=...).
  const firstSync = useRef(true);
  useEffect(() => {
    if (counterpartyOnly) {
      window.history.replaceState(null, "", sessionId ? `${window.location.search}#session=${sessionId}` : window.location.search || window.location.pathname);
      return;
    }
    const path = view === "deals" ? "/deals" : view === "instructions" ? (openMandate ? `/mandates/${openMandate}` : "/mandates") : negMode === "session" && sessionId ? `/negotiations/${sessionId}` : "/negotiations";
    const replace = firstSync.current;
    firstSync.current = false;
    if (window.location.pathname === path && !window.location.hash) return;
    if (replace) window.history.replaceState(null, "", `${path}${window.location.search}`);
    else window.history.pushState(null, "", `${path}${window.location.search}`);
  }, [counterpartyOnly, view, negMode, sessionId, openMandate]);
  // Back and forward move between pages.
  useEffect(() => {
    if (counterpartyOnly) return;
    const onPop = () => {
      const r = routeFromLocation();
      setView(r.view);
      setOpenMandate(r.mandateId);
      setOpenRow(null);
      setChat(null);
      setOperator(null);
      setSessionId(r.sessionId);
      setNegMode(r.sessionId ? "session" : "log");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [counterpartyOnly]);

  // An opened negotiation the log has not described yet (opened from a board, a mandate or the address): look it up.
  useEffect(() => {
    if (!access || !sessionId || negMode !== "session" || openRow?.sessionId === sessionId) return;
    let cancelled = false;
    api.negotiations().then((rows) => {
      if (!cancelled) setOpenRow(rows.find((r) => r.sessionId === sessionId) ?? null);
    }, () => undefined);
    return () => { cancelled = true; };
  }, [access, sessionId, negMode, openRow?.sessionId]);

  /** Opens one negotiation in the Negotiation tab. */
  const openNegotiation = useCallback((id: string, row: NegotiationLogRow | null = null) => {
    reported.current.clear();
    setChat(null);
    setOperator(null);
    setError(null);
    setOpenRow(row);
    setSessionId(id);
    setNegMode("session");
    setView("negotiation");
  }, []);

  const backToLog = useCallback(() => {
    setSessionId(null);
    setChat(null);
    setOperator(null);
    setOpenRow(null);
    setNegMode("log");
  }, []);

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

  /** A test: the principal plays the other side, by chat or voice, against the chosen mandate. */
  const newNegotiation = async (chosen: string | null = mandateId) => {
    if (!chosen) return;
    setStarting(true);
    try {
      const { session } = await api.startSession(chosen, null);
      const title = mandates.find((m) => m.id === chosen)?.title ?? "Test";
      const now = new Date().toISOString();
      openNegotiation(session.id, { sessionId: session.id, startedAt: now, lastAt: now, mandate: { id: chosen, title }, counterparty: null, origin: "test", channels: [], calls: { count: 0, seconds: 0 }, messages: 0, status: "active", live: false });
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
          <nav className="topnav" aria-label="Pages">
            {NAV.map((item) => (
              <a
                key={item.view}
                href={item.path}
                className="topnav-item"
                aria-current={view === item.view ? "page" : undefined}
                onClick={(event) => {
                  // A modified click opens the page in a new tab, as any link does.
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                  event.preventDefault();
                  // Negotiations again, from an open negotiation: back to the log.
                  if (item.view === "negotiation" && view === "negotiation" && negMode === "session") backToLog();
                  setView(item.view);
                  if (item.view === "negotiation" || item.view === "deals") loadMandates();
                  if (item.view !== "negotiation") setOpenMandate(null);
                }}
              >
                {item.label}
                {/* One underline springs to the current page. */}
                {view === item.view && <motion.span layoutId="topnav-underline" className="topnav-underline" transition={reducedMotion ? { duration: 0 } : { type: "spring", duration: 0.35, bounce: 0 }} aria-hidden="true" />}
              </a>
            ))}
          </nav>
        )}
        {/* The top bar is navigation only. Each page carries its own actions, next to what they change. */}
        <div className="topbar-actions">
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
          onOpen={(id) => openNegotiation(id)}
          onManage={(id) => {
            setOpenMandate(id);
            setView("instructions");
          }}
        />
      )}
      {access && view === "instructions" && (
        <MandatesPage
          initialId={openMandate}
          onUse={(id) => {
            // "Test it" on a mandate: start a test negotiation with it straight away.
            setMandateId(id);
            void newNegotiation(id);
          }}
          onOpenNegotiation={(id) => openNegotiation(id)}
        />
      )}
      {access && view === "negotiation" && negMode === "log" && (
        <NegotiationLog
          onOpen={(row) => openNegotiation(row.sessionId, row)}
          test={{ mandates: mandates.map((m) => ({ value: m.id, label: m.title, description: m.description })), mandateId, onChoose: setMandateId, onStart: () => void newNegotiation(), starting }}
        />
      )}
      <main className={access ? "layout" : "layout layout-single"} hidden={access && (view !== "negotiation" || negMode !== "session")}>
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
          heading={access ? conversationHeading(openRow, chat, backToLog) : null}
          // A real negotiation is watched, never joined: only a test lets the principal play the other side.
          readOnly={access && (openRow ? openRow.origin !== "test" : true)}
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

/** The conversation panel's title and line in the console: who it is with and how it came in, or a test. */
function conversationHeading(row: NegotiationLogRow | null, chat: BuyerView | null, onBack: () => void): { title: string; subtitle: string; onBack: () => void } {
  const roles = chat?.roles ?? { principal: "principal", counterparty: "other party" };
  if (!row) return { title: "Conversation", subtitle: "Loading…", onBack };
  if (row.origin === "test") return { title: "Test negotiation", subtitle: `You play the ${roles.counterparty}. Kritva replies for you. ${row.mandate.title}.`, onBack };
  return { title: whoOf(row), subtitle: `${howOf(row)} · ${row.mandate.title}`, onBack };
}

