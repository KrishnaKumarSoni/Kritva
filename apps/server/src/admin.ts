/**
 * The admin page's API (docs/Kritva_Sign_In.md, section "Admin"). Admins are KRITVA_ADMIN_EMAILS (else
 * the first address in KRITVA_SIGNIN_EMAILS), signed in with an emailed link; the access key also works.
 *
 *   GET    /api/admin/overview                → usage for the last 30 days, the people with access, the requests
 *   POST   /api/admin/access   {email, invite} → give access (and, by default, email them where to sign in)
 *   DELETE /api/admin/access/:email           → take back access an admin gave; their sessions end at once
 *   POST   /api/admin/requests/:id/dismiss     → set a waiting request aside
 *
 *   POST   /api/views          {path}          → counts one view of a public page (no visitor is identified)
 *
 * Days are counted in India time, where Kritva's users are.
 */
import type { Context, Hono } from "hono";
import { isAdmin, normalizeEmail, whoIs, type AuthSettings, type AuthStore } from "./auth.ts";

const DAY_MS = 24 * 3_600_000;
const DAYS = 30;
/** Public pages whose views are counted. Anything else is ignored. */
const COUNTED = new Set(["/", "/signin"]);
const BOT = /bot|crawl|spider|slurp|preview|fetch|monitor|headless|lighthouse/i;

export interface AdminDeps {
  store: AuthStore;
  settings: AuthSettings;
  operatorKey?: string;
  /** When each negotiation began (the record's sessions), for the usage counts. */
  negotiations?: () => Promise<Array<{ createdAt: string }>>;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

/** A day in India time, as YYYY-MM-DD. */
export function dayOf(ms: number): string {
  return new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/** The message an invited person gets: where to sign in, and how. */
export function inviteMessage(webUrl: string | null): { subject: string; text: string } {
  const where = webUrl ? `${webUrl}/signin` : "the Kritva sign-in page";
  return {
    subject: "You have access to Kritva",
    text: [
      "You now have access to Kritva, the negotiation console.",
      "",
      `Sign in here: ${where}`,
      "Enter this email address, and Kritva sends you a sign-in link. There is no password.",
      "",
      "If you didn't ask for access, you can ignore this email.",
    ].join("\n"),
  };
}

export function registerAdminRoutes(app: Hono, deps: AdminDeps): void {
  const now = () => (deps.now ?? Date.now)();
  const log = (entry: Record<string, unknown>) => deps.log?.(entry);

  // Counted page views: the landing page and the sign-in page. Bots are skipped; nothing else is kept.
  app.post("/api/views", async (c) => {
    const body = await c.req.json<{ path?: unknown }>().catch(() => ({}) as { path?: unknown });
    const path = typeof body.path === "string" ? body.path : "";
    if (COUNTED.has(path) && !BOT.test(c.req.header("user-agent") ?? "")) deps.store.countView(dayOf(now()), path);
    return c.body(null, 204);
  });

  /** The admin's email for the record, or a reply that stops the request. */
  const admin = (c: Context): { by: string | null } | Response => {
    c.header("Cache-Control", "no-store");
    const who = whoIs(c, deps);
    if (!who) return c.json({ error: "signed_out", message: "Sign in to open the console." }, 401);
    if (!isAdmin(who, deps.settings)) {
      const listed = who.kind === "session" && (deps.settings.admins ?? []).includes(who.email);
      // An admin who signed in with the passkey, or before admin existed, signs in again with a link.
      return listed
        ? c.json({ error: "admin_needs_link", message: "Sign in again with an emailed link to use the admin page." }, 403)
        : c.json({ error: "not_admin", message: "Only an admin can open this page." }, 403);
    }
    return { by: who.kind === "session" ? who.email : null };
  };

  app.get("/api/admin/overview", async (c) => {
    const a = admin(c);
    if (a instanceof Response) return a;
    const t = now();
    const since = t - DAYS * DAY_MS;
    const days = Array.from({ length: DAYS }, (_, i) => dayOf(t - (DAYS - 1 - i) * DAY_MS));
    const byDay = new Map(days.map((d) => [d, { day: d, signIns: 0, visits: 0, negotiations: 0 }]));

    const sessions = deps.store.sessionLog(since);
    const active = new Set<string>();
    let passkeySignIns = 0;
    for (const s of sessions) {
      if (s.createdAt >= since) {
        if (s.via === "passkey") passkeySignIns += 1;
        else {
          const d = byDay.get(dayOf(s.createdAt));
          if (d) d.signIns += 1;
        }
      }
      if (s.via !== "passkey" && Math.max(s.createdAt, s.lastSeenAt ?? 0) >= t - 7 * DAY_MS) active.add(s.email);
    }
    for (const v of deps.store.views(days[0]!)) {
      const d = byDay.get(v.day);
      if (d && v.path === "/") d.visits += v.views;
    }
    let negotiations = 0;
    for (const n of (await deps.negotiations?.().catch(() => [])) ?? []) {
      const at = Date.parse(n.createdAt);
      if (!Number.isFinite(at) || at < since) continue;
      negotiations += 1;
      const d = byDay.get(dayOf(at));
      if (d) d.negotiations += 1;
    }

    // People with access: the settings' list, then the ones an admin added.
    const usage = deps.store.usageByEmail();
    const admins = new Set(deps.settings.admins ?? []);
    const people = [
      ...deps.settings.allowed.map((email) => ({ email, source: "settings" as const, grantedBy: null as string | null, grantedAt: null as number | null })),
      ...deps.store.grants().filter((g) => !deps.settings.allowed.includes(g.email)).map((g) => ({ email: g.email, source: "admin" as const, grantedBy: g.grantedBy, grantedAt: g.grantedAt })),
    ].map((p) => ({ ...p, admin: admins.has(p.email), signIns: usage.get(p.email)?.signIns ?? 0, lastSignIn: usage.get(p.email)?.lastSignIn ?? null, lastSeen: usage.get(p.email)?.lastSeen ?? null }));

    const requests = deps.store.requestList();
    const series = [...byDay.values()];
    return c.json({
      me: a.by,
      totals: {
        people: people.length,
        active7: [...active].filter((e) => people.some((p) => p.email === e)).length,
        signIns30: series.reduce((n, d) => n + d.signIns, 0),
        passkeySignIns30: passkeySignIns,
        waiting: requests.filter((r) => r.status === "pending").length,
        negotiations30: negotiations,
        visits30: series.reduce((n, d) => n + d.visits, 0),
      },
      days: series,
      people,
      requests,
    });
  });

  app.post("/api/admin/access", async (c) => {
    const a = admin(c);
    if (a instanceof Response) return a;
    const body = await c.req.json<{ email?: unknown; invite?: unknown }>().catch(() => ({}) as { email?: unknown; invite?: unknown });
    const email = normalizeEmail(body.email);
    if (!email) return c.json({ error: "invalid_email", message: "Enter a valid email address." }, 400);
    const already = deps.settings.allowed.includes(email) || deps.store.isGranted(email);
    // Also marks any waiting request from them as handled.
    deps.store.grant(email, a.by, now());
    log({ kind: already ? "access_regranted" : "access_granted" });
    let invited = false;
    if (body.invite !== false && deps.settings.sender.sendNotice) {
      try {
        await deps.settings.sender.sendNotice({ to: email, ...inviteMessage(deps.settings.webUrl) });
        invited = true;
      } catch {
        log({ kind: "access_invite_failed" });
      }
    }
    return c.json({ ok: true, email, already, invited });
  });

  app.delete("/api/admin/access/:email", (c) => {
    const a = admin(c);
    if (a instanceof Response) return a;
    const email = normalizeEmail(decodeURIComponent(c.req.param("email")));
    if (!email) return c.json({ error: "invalid_email", message: "Enter a valid email address." }, 400);
    if (email === a.by) return c.json({ error: "self", message: "You can't take away your own access." }, 409);
    if (deps.settings.allowed.includes(email)) return c.json({ error: "in_settings", message: "This email is in KRITVA_SIGNIN_EMAILS. Remove it there to take away access." }, 409);
    if (!deps.store.revoke(email, a.by, now())) return c.json({ error: "not_found", message: "This email has no access to take away." }, 404);
    log({ kind: "access_revoked" });
    return c.json({ ok: true });
  });

  app.post("/api/admin/requests/:id/dismiss", (c) => {
    const a = admin(c);
    if (a instanceof Response) return a;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || !deps.store.dismissRequest(id, a.by, now())) return c.json({ error: "not_found", message: "That request was already handled." }, 404);
    return c.json({ ok: true });
  });
}
