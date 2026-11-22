/**
 * Signing in to the principal's console with an emailed sign-in link (docs/Kritva_Sign_In.md).
 *
 *   POST /api/auth/link    {email}  → a one-time link, valid 15 minutes, sent by email
 *   POST /api/auth/verify  {token}  → the link's token is used up; a session cookie is set (30 days)
 *   GET  /api/auth/me               → who is signed in (401 when nobody is)
 *   POST /api/auth/signout          → the session ends and the cookie is cleared
 *
 * The link opens the web app at /signin#token=..., and the page posts the token. The token never
 * reaches a server log or a Referer header (it is in the fragment), and an email scanner that opens
 * the link does not use it up (it runs no script). Only hashes of tokens and session IDs are stored.
 *
 * Delivery:
 * - "console" (the default): the link is printed in the server's log. Anyone who can read that log
 *   already controls the server, so any email may ask for a link.
 * - "ses": Amazon SES sends the email. Then only the emails in KRITVA_SIGNIN_EMAILS may sign in.
 *
 * The link always points at KRITVA_WEB_URL, never at the address a request claims to come from, so a
 * stranger cannot make Kritva email the principal a real link that leads to the stranger's site.
 * Without KRITVA_WEB_URL, only a local address (localhost) is accepted.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export const SESSION_COOKIE = "kritva_session";
const LINK_MS = 15 * 60_000;
const SESSION_MS = 30 * 24 * 3_600_000;
/** Links one email may ask for in a window, so a typo or a script cannot flood an inbox. */
const LINKS_PER_WINDOW = 5;
const LINK_WINDOW_MS = 15 * 60_000;

// ---------- Email ----------

export interface SignInEmail {
  to: string;
  link: string;
  minutes: number;
}

export interface EmailSender {
  readonly kind: "console" | "ses";
  sendSignIn(email: SignInEmail): Promise<void>;
}

/** Prints the link in the server's log. For local use and for a demo laptop. */
export class ConsoleEmailSender implements EmailSender {
  readonly kind = "console" as const;
  readonly #print: (line: string) => void;
  constructor(print: (line: string) => void = console.log) {
    this.#print = print;
  }
  async sendSignIn(email: SignInEmail): Promise<void> {
    this.#print(`[sign-in] Link for ${email.to} (one use, ${email.minutes} minutes): ${email.link}`);
  }
}

/** The email itself, in plain text and simple HTML. */
export function signInMessage(email: SignInEmail): { subject: string; text: string; html: string } {
  const subject = "Your Kritva sign-in link";
  const text = `Sign in to Kritva:\n${email.link}\n\nThe link works once, for the next ${email.minutes} minutes. If you didn't ask for it, you can ignore this email.`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `<!doctype html><html><body style="margin:0;padding:32px;background:#ffffff;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0a0a0a">
<p style="margin:0 0 24px;font-family:Georgia,serif;font-size:28px">Kritva<span style="color:#cc5500">.</span></p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.5">Here is your link to sign in.</p>
<p style="margin:0 0 24px"><a href="${esc(email.link)}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#cc5500;color:#ffffff;text-decoration:none;font-weight:600">Sign in to Kritva</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#57534e">The link works once, for the next ${email.minutes} minutes. If you didn't ask for it, you can ignore this email.</p>
</body></html>`;
  return { subject, text, html };
}

/**
 * Amazon SES (v2 API). Credentials and, unless KRITVA_SES_REGION names one, the region come from the
 * usual AWS settings (environment, profile or the instance's role). Any SES region works: where the
 * email is sent from does not change how fast the console is.
 */
export class SesEmailSender implements EmailSender {
  readonly kind = "ses" as const;
  #client: Promise<{ send(command: unknown): Promise<unknown> }> | null = null;
  #command: Promise<new (input: unknown) => unknown> | null = null;
  readonly #options: { from: string; region: string | null };
  constructor(options: { from: string; region: string | null }) {
    this.#options = options;
  }
  async sendSignIn(email: SignInEmail): Promise<void> {
    // Loaded only when SES is used, so local runs never need the AWS SDK.
    this.#client ??= import("@aws-sdk/client-sesv2").then((m) => new m.SESv2Client(this.#options.region ? { region: this.#options.region } : {}));
    this.#command ??= import("@aws-sdk/client-sesv2").then((m) => m.SendEmailCommand as unknown as new (input: unknown) => unknown);
    const [client, SendEmail] = await Promise.all([this.#client, this.#command]);
    const message = signInMessage(email);
    await client.send(
      new SendEmail({
        FromEmailAddress: this.#options.from,
        Destination: { ToAddresses: [email.to] },
        Content: { Simple: { Subject: { Data: message.subject, Charset: "UTF-8" }, Body: { Text: { Data: message.text, Charset: "UTF-8" }, Html: { Data: message.html, Charset: "UTF-8" } } } },
      }),
    );
  }
}

// ---------- Settings ----------

export interface AuthSettings {
  /** Where the web app runs; sign-in links point here. Null: only a local address may be used. */
  webUrl: string | null;
  /** Who may sign in (lowercase). Empty: anyone, which is allowed only with console delivery. */
  allowed: string[];
  sender: EmailSender;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function normalizeEmail(raw: unknown): string | null {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return email.length <= 320 && EMAIL.test(email) ? email : null;
}

/** Sign-in settings from the environment, with what the operator should know about them. */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): { settings: AuthSettings; notes: string[] } {
  const notes: string[] = [];
  const allowed = (env.KRITVA_SIGNIN_EMAILS ?? "").split(",").map(normalizeEmail).filter((e): e is string => e !== null);
  const rawUrl = env.KRITVA_WEB_URL?.trim().replace(/\/+$/, "") || null;
  let webUrl: string | null = null;
  if (rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol === "https:" || isLocal(url)) webUrl = url.origin;
      else notes.push("KRITVA_WEB_URL must be https (or a local address); sign-in links use the local address instead.");
    } catch {
      notes.push("KRITVA_WEB_URL is not a URL; sign-in links use the local address instead.");
    }
  }
  const from = env.KRITVA_EMAIL_FROM?.trim() || null;
  const useSes = (env.KRITVA_EMAIL_PROVIDER ?? (from ? "ses" : "console")) === "ses";
  let sender: EmailSender = new ConsoleEmailSender();
  if (useSes && !from) notes.push("KRITVA_EMAIL_PROVIDER=ses needs KRITVA_EMAIL_FROM; sign-in links go to the server log instead.");
  else if (useSes && !allowed.length) notes.push("Emailed sign-in needs KRITVA_SIGNIN_EMAILS (who may sign in); sign-in links go to the server log instead.");
  const region = env.KRITVA_SES_REGION?.trim() || null;
  if (useSes && from && allowed.length) sender = new SesEmailSender({ from, region });
  notes.unshift(sender.kind === "ses" ? `Sign-in: links are emailed through Amazon SES (${region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "the AWS profile's region"}) from ${from}, to ${allowed.length} allowed address(es).` : "Sign-in: links are printed in this log (set KRITVA_EMAIL_FROM and KRITVA_SIGNIN_EMAILS to email them).");
  if (sender.kind === "ses" && !webUrl) notes.push("Set KRITVA_WEB_URL (https) so emailed links open the console from anywhere.");
  return { settings: { webUrl, allowed, sender }, notes };
}

function isLocal(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

// ---------- Storage ----------

const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");

export class AuthStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS auth_links (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE INDEX IF NOT EXISTS auth_links_email ON auth_links (email, created_at);
CREATE TABLE IF NOT EXISTS auth_sessions (id_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended_at INTEGER);`);
  }

  /** Links asked for this email since `since` (for the rate limit). */
  linksSince(email: string, since: number): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM auth_links WHERE email = ? AND created_at >= ?").get(email, since) as { n: number }).n);
  }

  /** A new one-time link token for this email. Only its hash is kept. */
  createLink(email: string, now: number): string {
    const t = token();
    this.#db.prepare("INSERT INTO auth_links (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hashOf(t), email, now, now + LINK_MS);
    return t;
  }

  /** Uses up a link token: its email, or null when it is unknown, expired or already used. */
  useLink(t: string, now: number): string | null {
    const row = this.#db.prepare("SELECT email, expires_at, used_at FROM auth_links WHERE token_hash = ?").get(hashOf(t)) as { email: string; expires_at: number; used_at: number | null } | undefined;
    if (!row || row.used_at !== null || row.expires_at < now) return null;
    // Only one request can use it, even two at once.
    const used = this.#db.prepare("UPDATE auth_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").run(now, hashOf(t));
    return Number(used.changes) === 1 ? row.email : null;
  }

  createSession(email: string, now: number): { id: string; expiresAt: number } {
    const id = token();
    this.#db.prepare("INSERT INTO auth_sessions (id_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hashOf(id), email, now, now + SESSION_MS);
    return { id, expiresAt: now + SESSION_MS };
  }

  /** The signed-in email for a session ID, or null. */
  session(id: string, now: number): string | null {
    const row = this.#db.prepare("SELECT email, expires_at, ended_at FROM auth_sessions WHERE id_hash = ?").get(hashOf(id)) as { email: string; expires_at: number; ended_at: number | null } | undefined;
    return row && row.ended_at === null && row.expires_at > now ? row.email : null;
  }

  endSession(id: string, now: number): void {
    this.#db.prepare("UPDATE auth_sessions SET ended_at = ? WHERE id_hash = ? AND ended_at IS NULL").run(now, hashOf(id));
  }
}

// ---------- Routes ----------

export interface AuthDeps {
  store: AuthStore;
  settings: AuthSettings;
  /** The access key scripts and tools use (Authorization: Bearer ...). Still accepted for /api/operator. */
  operatorKey?: string;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

/** Whether the request comes over https (directly, or through a proxy that says so). */
const secure = (c: Context) => c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";

/** Who a request is signed in as: the session cookie's email, "key" for the access key, or null. */
export function signedIn(c: Context, deps: { store?: AuthStore | null; operatorKey?: string; now?: () => number }): string | null {
  const id = deps.store ? getCookie(c, SESSION_COOKIE) : undefined;
  if (id && deps.store) {
    const email = deps.store.session(id, (deps.now ?? Date.now)());
    if (email) return email;
  }
  if (deps.operatorKey) {
    const hash = (value: string) => createHash("sha256").update(value).digest();
    if (timingSafeEqual(hash(c.req.header("Authorization") ?? ""), hash(`Bearer ${deps.operatorKey}`))) return "key";
  }
  return null;
}

export function registerAuthRoutes(app: Hono, deps: AuthDeps): void {
  const now = () => (deps.now ?? Date.now)();
  const log = (entry: Record<string, unknown>) => deps.log?.(entry);

  /** Where the link points: the configured web app, or (without one) the local page that asked. */
  const webUrlFor = (c: Context): string | null => {
    if (deps.settings.webUrl) return deps.settings.webUrl;
    const origin = c.req.header("origin");
    try {
      const url = origin ? new URL(origin) : null;
      return url && isLocal(url) ? url.origin : null;
    } catch {
      return null;
    }
  };

  app.post("/api/auth/link", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
    const email = normalizeEmail(body.email);
    if (!email) return c.json({ error: "invalid_email", message: "Enter your email address." }, 400);
    const sent = { ok: true, message: "If this email can sign in, a link is on its way. It works once, for 15 minutes." };
    if (deps.settings.allowed.length && !deps.settings.allowed.includes(email)) {
      log({ kind: "signin_not_allowed" });
      return c.json(sent, 202);
    }
    if (deps.store.linksSince(email, now() - LINK_WINDOW_MS) >= LINKS_PER_WINDOW) return c.json({ error: "too_many", message: "That's a lot of links. Use the latest one, or try again in a few minutes." }, 429);
    const base = webUrlFor(c);
    if (!base) return c.json({ error: "no_web_url", message: "This server doesn't know its own address yet, so it can't make a link. Set KRITVA_WEB_URL." }, 503);
    const link = `${base}/signin#token=${deps.store.createLink(email, now())}`;
    try {
      await deps.settings.sender.sendSignIn({ to: email, link, minutes: LINK_MS / 60_000 });
    } catch (error) {
      log({ kind: "signin_email_failed", error: String(error) });
      return c.json({ error: "email_failed", message: "The email couldn't be sent. Try again in a moment." }, 502);
    }
    log({ kind: "signin_link_sent", via: deps.settings.sender.kind });
    return c.json({ ...sent, via: deps.settings.sender.kind }, 202);
  });

  app.post("/api/auth/verify", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as { token?: unknown });
    const t = typeof body.token === "string" && /^[\w-]{20,100}$/.test(body.token) ? body.token : null;
    const email = t ? deps.store.useLink(t, now()) : null;
    if (!email) return c.json({ error: "link_expired", message: "This sign-in link has expired or was already used. Ask for a new one." }, 400);
    const session = deps.store.createSession(email, now());
    setCookie(c, SESSION_COOKIE, session.id, { httpOnly: true, secure: secure(c), sameSite: "Strict", path: "/", maxAge: Math.floor(SESSION_MS / 1000) });
    log({ kind: "signin_verified" });
    return c.json({ ok: true, email });
  });

  app.get("/api/auth/me", (c) => {
    c.header("Cache-Control", "no-store");
    const who = signedIn(c, deps);
    return who ? c.json({ email: who === "key" ? null : who }) : c.json({ error: "signed_out", message: "Sign in to open the console." }, 401);
  });

  app.post("/api/auth/signout", (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) deps.store.endSession(id, now());
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secure(c), sameSite: "Strict", httpOnly: true });
    return c.json({ ok: true });
  });
}
