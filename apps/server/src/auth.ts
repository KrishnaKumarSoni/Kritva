/**
 * Signing in to the principal's console with an emailed sign-in link (docs/Kritva_Sign_In.md).
 *
 *   POST /api/auth/link    {email}  → a one-time link, valid 15 minutes, sent by email
 *   POST /api/auth/verify  {token}  → the link's token is used up; a session cookie is set (30 days)
 *   GET  /api/auth/me               → who is signed in (401 when nobody is)
 *   POST /api/auth/signout          → the session ends and the cookie is cleared
 *   POST /api/auth/access   {email, name?, company?, note?} → an access request, kept and sent to the operator
 *
 * Who may sign in: the addresses in KRITVA_SIGNIN_EMAILS, plus the ones an admin gave access in the
 * console (admin.ts, kept in access_grants). Admins are KRITVA_ADMIN_EMAILS (else the first address in
 * KRITVA_SIGNIN_EMAILS), and only when signed in with an emailed link: the shared passkey never is.
 *
 * The link opens the web app at /signin#token=..., and the page posts the token. The token never
 * reaches a server log or a Referer header (it is in the fragment), and an email scanner that opens
 * the link does not use it up (it runs no script). Only hashes of tokens and session IDs are stored.
 *
 * Delivery:
 * - "console" (the default): the link is printed in the server's log. Anyone who can read that log
 *   already controls the server, so any email may ask for a link.
 * - "cloudflare": Cloudflare Email Sending sends the email (the Worker's EMAIL binding, apps/worker).
 *   Then only the emails in KRITVA_SIGNIN_EMAILS may sign in. Any other email is told plainly that it
 *   has no access yet (403 no_access), and the page offers an access request instead.
 *
 * The link always points at KRITVA_WEB_URL, never at the address a request claims to come from, so a
 * stranger cannot make Kritva email the principal a real link that leads to the stranger's site.
 * Without KRITVA_WEB_URL, only a local address (localhost) is accepted.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { openSql, type SqlDatabase, type SqlSource } from "@kritva/core";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export const SESSION_COOKIE = "kritva_session";
const LINK_MS = 15 * 60_000;
const SESSION_MS = 30 * 24 * 3_600_000;
/** How often a session's "last used" time is written (the console polls every few seconds). */
const SEEN_EVERY_MS = 5 * 60_000;
/** Links one email may ask for in a window, so a typo or a script cannot flood an inbox. */
const LINKS_PER_WINDOW = 5;
const LINK_WINDOW_MS = 15 * 60_000;

// ---------- Email ----------

export interface SignInEmail {
  to: string;
  link: string;
  minutes: number;
}

/** A short plain message to the operator, such as an access request. */
export interface Notice {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  readonly kind: "console" | "cloudflare";
  sendSignIn(email: SignInEmail): Promise<void>;
  /** Optional: senders without it only log notices. */
  sendNotice?(notice: Notice): Promise<void>;
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
  async sendNotice(notice: Notice): Promise<void> {
    this.#print(`[notice] To ${notice.to}: ${notice.subject}\n${notice.text}`);
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

/** A Cloudflare Email Sending binding (`send_email` in apps/worker/wrangler.jsonc); only the call Kritva makes. */
export interface EmailBinding {
  send(message: { from: string | { email: string; name: string }; to: string; subject: string; text: string; html: string }): Promise<unknown>;
}

/**
 * Cloudflare Email Sending, through the Worker's binding. The sender must be on a domain onboarded for
 * sending (`wrangler email sending enable <domain>`). KRITVA_EMAIL_FROM may be "Name <address>".
 */
export class CloudflareEmailSender implements EmailSender {
  readonly kind = "cloudflare" as const;
  readonly #binding: EmailBinding;
  readonly #from: string | { email: string; name: string };
  constructor(binding: EmailBinding, from: string) {
    this.#binding = binding;
    const named = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
    this.#from = named?.[1] ? { name: named[1].replace(/^"|"$/g, ""), email: named[2]!.trim() } : (named?.[2] ?? from).trim();
  }
  async sendSignIn(email: SignInEmail): Promise<void> {
    const message = signInMessage(email);
    await this.#binding.send({ from: this.#from, to: email.to, subject: message.subject, text: message.text, html: message.html });
  }
  async sendNotice(notice: Notice): Promise<void> {
    const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `<!doctype html><html><body style="margin:0;padding:32px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0a0a0a"><pre style="margin:0;font:15px/1.6 inherit;white-space:pre-wrap">${esc(notice.text)}</pre></body></html>`;
    await this.#binding.send({ from: this.#from, to: notice.to, subject: notice.subject, text: notice.text, html });
  }
}

// ---------- Settings ----------

export interface AuthSettings {
  /** Where the web app runs; sign-in links point here. Null: only a local address may be used. */
  webUrl: string | null;
  /** Who may sign in (lowercase). Empty: anyone, which is allowed only with console delivery. */
  allowed: string[];
  sender: EmailSender;
  /** A shared passkey that also signs in (KRITVA_PASSKEY, with a demo default). Null: off. */
  passkey?: string | null;
  /** Who a passkey sign-in is signed in as. */
  passkeyEmail?: string;
  /** Who hears about access requests (KRITVA_ACCESS_NOTIFY, else the first address that may sign in). */
  notify?: string[];
  /** Who may open the admin page (KRITVA_ADMIN_EMAILS, else the first address that may sign in). */
  admins?: string[];
}

/** The demo passkey when KRITVA_PASSKEY is not set. Set KRITVA_PASSKEY=off to turn passkey sign-in off. */
export const DEFAULT_PASSKEY = "kritva-jury-2026";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function normalizeEmail(raw: unknown): string | null {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return email.length <= 320 && EMAIL.test(email) ? email : null;
}

/** Sign-in settings from the environment, with what the operator should know about them. */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env, options: { emailBinding?: EmailBinding | null } = {}): { settings: AuthSettings; notes: string[] } {
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
  const binding = options.emailBinding ?? null;
  const useCloudflare = (env.KRITVA_EMAIL_PROVIDER ?? (from && binding ? "cloudflare" : "console")) === "cloudflare";
  let sender: EmailSender = new ConsoleEmailSender();
  if (useCloudflare && !binding) notes.push("KRITVA_EMAIL_PROVIDER=cloudflare needs the Worker's EMAIL binding (it runs only on Cloudflare); sign-in links go to the server log instead.");
  else if (useCloudflare && !from) notes.push("KRITVA_EMAIL_PROVIDER=cloudflare needs KRITVA_EMAIL_FROM; sign-in links go to the server log instead.");
  else if (useCloudflare && !allowed.length) notes.push("Emailed sign-in needs KRITVA_SIGNIN_EMAILS (who may sign in); sign-in links go to the server log instead.");
  if (useCloudflare && binding && from && allowed.length) sender = new CloudflareEmailSender(binding, from);
  notes.unshift(sender.kind === "cloudflare" ? `Sign-in: links are emailed through Cloudflare Email Sending from ${from}, to ${allowed.length} allowed address(es).` : "Sign-in: links are printed in this log (set KRITVA_EMAIL_FROM and KRITVA_SIGNIN_EMAILS on Cloudflare to email them).");
  if (sender.kind === "cloudflare" && !webUrl) notes.push("Set KRITVA_WEB_URL (https) so emailed links open the console from anywhere.");
  const rawPasskey = env.KRITVA_PASSKEY?.trim();
  const passkey = rawPasskey === "off" ? null : rawPasskey || DEFAULT_PASSKEY;
  const passkeyEmail = normalizeEmail(env.KRITVA_PASSKEY_EMAIL) ?? allowed[0] ?? "jury@kritva.app";
  if (passkey) notes.push(`Sign-in: the passkey also signs in (as ${passkeyEmail}).`);
  const listed = (env.KRITVA_ACCESS_NOTIFY ?? "").split(",").map(normalizeEmail).filter((e): e is string => e !== null);
  const notify = listed.length ? listed : allowed.slice(0, 1);
  if (notify.length) notes.push(`Sign-in: access requests are sent to ${notify.length} address(es).`);
  const namedAdmins = (env.KRITVA_ADMIN_EMAILS ?? "").split(",").map(normalizeEmail).filter((e): e is string => e !== null);
  const admins = namedAdmins.length ? namedAdmins : allowed.slice(0, 1);
  if (admins.length) notes.push(`Sign-in: ${admins.length} admin(s) may give access and see usage.`);
  return { settings: { webUrl, allowed, sender, passkey, passkeyEmail, notify, admins }, notes };
}

function isLocal(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

// ---------- Storage ----------

export interface AccessRequest {
  email: string;
  name: string | null;
  company: string | null;
  note: string | null;
}

/** Access requests one email may send in a day, and all emails in an hour (a form cannot flood the operator). */
const ACCESS_WINDOW_MS = 24 * 3_600_000;
const ACCESS_PER_HOUR = 30;

/** A short free-text field: one line, trimmed, capped; null when empty. */
function field(raw: unknown, max: number, multiline = false): string | null {
  if (typeof raw !== "string") return null;
  const value = (multiline ? raw.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n") : raw.replace(/\s+/g, " ")).trim().slice(0, max);
  return value || null;
}

const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");

export class AuthStore {
  readonly #db: SqlDatabase;

  constructor(source: SqlSource) {
    this.#db = openSql(source);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS auth_links (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE INDEX IF NOT EXISTS auth_links_email ON auth_links (email, created_at);
CREATE TABLE IF NOT EXISTS auth_sessions (id_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS access_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, name TEXT, company TEXT, note TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS access_requests_email ON access_requests (email, created_at);
CREATE TABLE IF NOT EXISTS access_grants (email TEXT PRIMARY KEY, granted_by TEXT, granted_at INTEGER NOT NULL, revoked_at INTEGER, revoked_by TEXT);
CREATE TABLE IF NOT EXISTS page_views (day TEXT NOT NULL, path TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY (day, path));`);
    // Columns added after the tables first shipped: how a session signed in and when it was last used;
    // what happened to an access request. Adding a column that exists throws, so each is tried alone.
    for (const column of [
      "ALTER TABLE auth_sessions ADD COLUMN via TEXT",
      "ALTER TABLE auth_sessions ADD COLUMN last_seen_at INTEGER",
      "ALTER TABLE access_requests ADD COLUMN status TEXT",
      "ALTER TABLE access_requests ADD COLUMN handled_at INTEGER",
      "ALTER TABLE access_requests ADD COLUMN handled_by TEXT",
    ]) {
      try {
        this.#db.exec(column);
      } catch {
        // Already there.
      }
    }
  }

  // ---------- Access given in the console ----------

  /** Whether an admin gave this email access (and nobody took it back). */
  isGranted(email: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 AS ok FROM access_grants WHERE email = ? AND revoked_at IS NULL").get(email));
  }

  grant(email: string, by: string | null, now: number): void {
    this.#db.prepare("INSERT INTO access_grants (email, granted_by, granted_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at, revoked_at = NULL, revoked_by = NULL").run(email, by, now);
    this.#db.prepare("UPDATE access_requests SET status = 'granted', handled_at = ?, handled_by = ? WHERE email = ? AND COALESCE(status, 'pending') = 'pending'").run(now, by, email);
  }

  /** Takes back access an admin gave, and ends that email's open sessions at once. */
  revoke(email: string, by: string | null, now: number): boolean {
    const changed = this.#db.prepare("UPDATE access_grants SET revoked_at = ?, revoked_by = ? WHERE email = ? AND revoked_at IS NULL RETURNING email").get(now, by, email);
    this.#db.prepare("UPDATE auth_sessions SET ended_at = ? WHERE email = ? AND ended_at IS NULL").run(now, email);
    return Boolean(changed);
  }

  grants(): Array<{ email: string; grantedBy: string | null; grantedAt: number }> {
    const rows = this.#db.prepare("SELECT email, granted_by, granted_at FROM access_grants WHERE revoked_at IS NULL ORDER BY granted_at DESC").all() as Array<{ email: string; granted_by: string | null; granted_at: number }>;
    return rows.map((r) => ({ email: r.email, grantedBy: r.granted_by, grantedAt: r.granted_at }));
  }

  /** Marks a waiting access request as dismissed. False when there is no such waiting request. */
  dismissRequest(id: number, by: string | null, now: number): boolean {
    return Boolean(this.#db.prepare("UPDATE access_requests SET status = 'dismissed', handled_at = ?, handled_by = ? WHERE id = ? AND COALESCE(status, 'pending') = 'pending' RETURNING id").get(now, by, id));
  }

  /** Access requests for the admin page: every waiting one, then the latest handled ones. */
  requestList(limit = 50): Array<AccessRequest & { id: number; createdAt: number; status: "pending" | "granted" | "dismissed" }> {
    const rows = this.#db.prepare("SELECT id, email, name, company, note, created_at, COALESCE(status, 'pending') AS status FROM access_requests ORDER BY CASE WHEN COALESCE(status, 'pending') = 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT ?").all(limit) as Array<{ id: number; email: string; name: string | null; company: string | null; note: string | null; created_at: number; status: "pending" | "granted" | "dismissed" }>;
    return rows.map((r) => ({ id: Number(r.id), email: r.email, name: r.name, company: r.company, note: r.note, createdAt: r.created_at, status: r.status }));
  }

  // ---------- Usage, for the admin page ----------

  /** Every session: who, how they signed in, when it began and when it was last used. */
  sessionLog(since: number): Array<{ email: string; via: string | null; createdAt: number; lastSeenAt: number | null }> {
    const rows = this.#db.prepare("SELECT email, via, created_at, last_seen_at FROM auth_sessions WHERE created_at >= ? OR last_seen_at >= ? ORDER BY created_at").all(since, since) as Array<{ email: string; via: string | null; created_at: number; last_seen_at: number | null }>;
    return rows.map((r) => ({ email: r.email, via: r.via, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
  }

  /** Per email: sign-ins with a link, the last one, and the last time a session was used. */
  usageByEmail(): Map<string, { signIns: number; lastSignIn: number | null; lastSeen: number | null }> {
    const rows = this.#db.prepare("SELECT email, COUNT(*) AS n, MAX(created_at) AS last_in, MAX(COALESCE(last_seen_at, created_at)) AS last_seen FROM auth_sessions WHERE COALESCE(via, 'link') = 'link' GROUP BY email").all() as Array<{ email: string; n: number; last_in: number | null; last_seen: number | null }>;
    return new Map(rows.map((r) => [r.email, { signIns: Number(r.n), lastSignIn: r.last_in, lastSeen: r.last_seen }]));
  }

  /** One more view of a public page on a day (YYYY-MM-DD). Counts only: no visitor is identified. */
  countView(day: string, path: string): void {
    this.#db.prepare("INSERT INTO page_views (day, path, views) VALUES (?, ?, 1) ON CONFLICT (day, path) DO UPDATE SET views = views + 1").run(day, path);
  }

  views(sinceDay: string): Array<{ day: string; path: string; views: number }> {
    return (this.#db.prepare("SELECT day, path, views FROM page_views WHERE day >= ? ORDER BY day").all(sinceDay) as Array<{ day: string; path: string; views: number }>).map((r) => ({ ...r, views: Number(r.views) }));
  }

  /** Keeps one access request. */
  addAccessRequest(request: AccessRequest, now: number): void {
    this.#db.prepare("INSERT INTO access_requests (email, name, company, note, created_at) VALUES (?, ?, ?, ?, ?)").run(request.email, request.name, request.company, request.note, now);
  }

  /** Access requests since `since`: from one email, or from anyone. */
  accessRequestsSince(since: number, email: string | null = null): number {
    const row = email
      ? this.#db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE email = ? AND created_at >= ?").get(email, since)
      : this.#db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE created_at >= ?").get(since);
    return Number((row as { n: number }).n);
  }

  /** The latest access requests, newest first. */
  accessRequests(limit = 50): Array<AccessRequest & { createdAt: number }> {
    const rows = this.#db.prepare("SELECT email, name, company, note, created_at FROM access_requests ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{ email: string; name: string | null; company: string | null; note: string | null; created_at: number }>;
    return rows.map((r) => ({ email: r.email, name: r.name, company: r.company, note: r.note, createdAt: r.created_at }));
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
    const used = this.#db.prepare("UPDATE auth_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING email").get(now, hashOf(t));
    return used ? row.email : null;
  }

  /** A new session. `via` says how it signed in: "link" (an emailed link) or "passkey" (the shared passkey). */
  createSession(email: string, now: number, via: "link" | "passkey" = "link"): { id: string; expiresAt: number } {
    const id = token();
    this.#db.prepare("INSERT INTO auth_sessions (id_hash, email, created_at, expires_at, via, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").run(hashOf(id), email, now, now + SESSION_MS, via, now);
    return { id, expiresAt: now + SESSION_MS };
  }

  /** The signed-in email for a session ID, or null. */
  session(id: string, now: number): string | null {
    return this.sessionInfo(id, now)?.email ?? null;
  }

  /**
   * Who a session is and how it signed in, or null. Sessions from before `via` existed say null.
   * Marks the session as used, at most once every 5 minutes (the console polls every few seconds).
   */
  sessionInfo(id: string, now: number): { email: string; via: string | null } | null {
    const row = this.#db.prepare("SELECT email, expires_at, ended_at, via, last_seen_at FROM auth_sessions WHERE id_hash = ?").get(hashOf(id)) as { email: string; expires_at: number; ended_at: number | null; via: string | null; last_seen_at: number | null } | undefined;
    if (!row || row.ended_at !== null || row.expires_at <= now) return null;
    if (row.last_seen_at === null || now - row.last_seen_at > SEEN_EVERY_MS) this.#db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id_hash = ?").run(now, hashOf(id));
    return { email: row.email, via: row.via };
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

/** Whether an email may sign in: listed in KRITVA_SIGNIN_EMAILS, or given access by an admin. An empty list lets anyone in (log delivery only). */
export function mayAccess(email: string, settings: AuthSettings, store: AuthStore): boolean {
  return !settings.allowed.length || settings.allowed.includes(email) || store.isGranted(email);
}

/** Who a request is, in detail: a signed-in session (with how it signed in), the access key, or null. */
export function whoIs(c: Context, deps: { store?: AuthStore | null; operatorKey?: string; now?: () => number }): { kind: "session"; email: string; via: string | null } | { kind: "key" } | null {
  const id = deps.store ? getCookie(c, SESSION_COOKIE) : undefined;
  if (id && deps.store) {
    const info = deps.store.sessionInfo(id, (deps.now ?? Date.now)());
    if (info) return { kind: "session", ...info };
  }
  if (deps.operatorKey) {
    const hash = (value: string) => createHash("sha256").update(value).digest();
    if (timingSafeEqual(hash(c.req.header("Authorization") ?? ""), hash(`Bearer ${deps.operatorKey}`))) return { kind: "key" };
  }
  return null;
}

/** Whether a request may use the admin page: an admin signed in with an emailed link, or the access key. */
export function isAdmin(who: ReturnType<typeof whoIs>, settings: AuthSettings): boolean {
  if (!who) return false;
  if (who.kind === "key") return true;
  return who.via === "link" && (settings.admins ?? []).includes(who.email);
}

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
    const sent = { ok: true, message: "A sign-in link is on its way. It works once, for 15 minutes." };
    if (!mayAccess(email, deps.settings, deps.store)) {
      // Said plainly, so a visitor is not left waiting for an email that never comes.
      log({ kind: "signin_not_allowed" });
      return c.json({ error: "no_access", message: "This email doesn't have access to Kritva yet. Request access, or use the email your team gave Kritva." }, 403);
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

  app.post("/api/auth/access", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const email = normalizeEmail(body.email);
    if (!email) return c.json({ error: "invalid_email", message: "Enter your email address." }, 400);
    if (mayAccess(email, deps.settings, deps.store)) return c.json({ ok: true, hasAccess: true, message: "This email already has access. Ask for a sign-in link." });
    const done = { ok: true, hasAccess: false, message: "Request sent. We reply by email." };
    // A second request from the same email in a day is answered the same way, and kept only once.
    if (deps.store.accessRequestsSince(now() - ACCESS_WINDOW_MS, email) > 0) return c.json(done, 202);
    if (deps.store.accessRequestsSince(now() - 3_600_000) >= ACCESS_PER_HOUR) return c.json({ error: "too_many", message: "Kritva is getting many requests right now. Try again in an hour." }, 429);
    const request: AccessRequest = { email, name: field(body.name, 120), company: field(body.company, 120), note: field(body.note, 600, true) };
    deps.store.addAccessRequest(request, now());
    log({ kind: "access_requested" });
    const notice = {
      subject: `Kritva access request: ${email}`,
      text: [`${request.name ?? "Someone"} asked for access to Kritva.`, "", `Email: ${email}`, `Name: ${request.name ?? "(not given)"}`, `Company: ${request.company ?? "(not given)"}`, `What they want to negotiate: ${request.note ?? "(not given)"}`, "", "To let them sign in, add the email to KRITVA_SIGNIN_EMAILS:", "npx wrangler secret put KRITVA_SIGNIN_EMAILS --config apps/worker/wrangler.jsonc"].join("\n"),
    };
    for (const to of deps.settings.notify ?? []) {
      try {
        await deps.settings.sender.sendNotice?.({ to, ...notice });
      } catch {
        log({ kind: "access_notice_failed" });
      }
    }
    return c.json(done, 202);
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

  app.post("/api/auth/passkey", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = await c.req.json<{ passkey?: unknown }>().catch(() => ({}) as { passkey?: unknown });
    const expected = deps.settings.passkey;
    const given = typeof body.passkey === "string" ? body.passkey.trim() : "";
    const hash = (value: string) => createHash("sha256").update(value).digest();
    if (!expected || !given || !timingSafeEqual(hash(given), hash(expected))) {
      log({ kind: "signin_passkey_failed" });
      return c.json({ error: "wrong_passkey", message: "That passkey didn't work. Check it and try again." }, 401);
    }
    const email = deps.settings.passkeyEmail ?? "jury@kritva.app";
    const session = deps.store.createSession(email, now(), "passkey");
    setCookie(c, SESSION_COOKIE, session.id, { httpOnly: true, secure: secure(c), sameSite: "Strict", path: "/", maxAge: Math.floor(SESSION_MS / 1000) });
    log({ kind: "signin_passkey" });
    return c.json({ ok: true, email });
  });

  app.get("/api/auth/me", (c) => {
    c.header("Cache-Control", "no-store");
    const who = whoIs(c, deps);
    if (!who) return c.json({ error: "signed_out", message: "Sign in to open the console." }, 401);
    return c.json({ email: who.kind === "key" ? null : who.email, admin: isAdmin(who, deps.settings) });
  });

  app.post("/api/auth/signout", (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) deps.store.endSession(id, now());
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secure(c), sameSite: "Strict", httpOnly: true });
    return c.json({ ok: true });
  });
}
