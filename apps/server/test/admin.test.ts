/** The admin page's API: who may use it, giving and taking access, and usage (src/admin.ts). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MandateRevisions, NegotiationEngine, NegotiationRecord, SqliteRecordBackend, type StructuredLlm } from "@kritva/core";
import { createApp } from "../src/app.ts";
import { dayOf } from "../src/admin.ts";
import { AuthStore, type AuthSettings, type EmailSender, type Notice, type SignInEmail } from "../src/auth.ts";
import { loadConfirmedMandates } from "../src/main-helpers.ts";

const CASES = resolve(import.meta.dirname, "../../../cases");
const ADMIN = "owner@example.com";
const TEAM = "team@example.com";

class Outbox implements EmailSender {
  readonly kind = "cloudflare" as const;
  readonly sent: SignInEmail[] = [];
  readonly notices: Notice[] = [];
  async sendSignIn(email: SignInEmail) {
    this.sent.push(email);
  }
  async sendNotice(notice: Notice) {
    this.notices.push(notice);
  }
}

function setup(settings: Partial<AuthSettings> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kritva-admin-"));
  const db = join(dir, "db.sqlite");
  const record = new NegotiationRecord(new SqliteRecordBackend(db));
  const llm: StructuredLlm = { generate: async () => { throw new Error("not used"); } };
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN" });
  const outbox = new Outbox();
  const store = new AuthStore(db);
  const auth = { store, settings: { webUrl: "https://kritva.example", allowed: [ADMIN, TEAM], admins: [ADMIN], notify: [ADMIN], sender: outbox as EmailSender, passkey: "jury-key", passkeyEmail: ADMIN, ...settings } };
  const app = createApp({ record, engine, revisions: new MandateRevisions({ record, engine, mappingLlm: llm }), mandates: loadConfirmedMandates(CASES), locale: "en-IN", operatorKey: "scripts-key", auth });
  const request = async (method: string, path: string, init: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
    if (init.cookie) headers.cookie = init.cookie;
    const res = await app.request(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any, setCookie: res.headers.get("set-cookie") };
  };
  const cookieOf = (r: { setCookie: string | null }) => r.setCookie!.split(";")[0]!;
  const signIn = async (email: string) => {
    expect((await request("POST", "/api/auth/link", { body: { email } })).status).toBe(202);
    const token = /#token=([\w-]+)$/.exec(outbox.sent.at(-1)!.link)![1]!;
    return cookieOf(await request("POST", "/api/auth/verify", { body: { token } }));
  };
  const passkey = async () => cookieOf(await request("POST", "/api/auth/passkey", { body: { passkey: "jury-key" } }));
  return { store, outbox, request, signIn, passkey };
}

describe("Admin: who may use it", () => {
  it("lets an admin signed in with a link in, and nobody else", async () => {
    const t = setup();
    const admin = await t.signIn(ADMIN);
    expect((await t.request("GET", "/api/auth/me", { cookie: admin })).json).toEqual({ email: ADMIN, admin: true });
    expect((await t.request("GET", "/api/admin/overview", { cookie: admin })).status).toBe(200);

    const team = await t.signIn(TEAM);
    expect((await t.request("GET", "/api/auth/me", { cookie: team })).json.admin).toBe(false);
    expect((await t.request("GET", "/api/admin/overview", { cookie: team })).json.error).toBe("not_admin");

    // The shared passkey signs in as the admin's email, but never opens the admin page.
    const jury = await t.passkey();
    expect((await t.request("GET", "/api/auth/me", { cookie: jury })).json).toEqual({ email: ADMIN, admin: false });
    const refused = await t.request("GET", "/api/admin/overview", { cookie: jury });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe("admin_needs_link");

    expect((await t.request("GET", "/api/admin/overview")).status).toBe(401);
    expect((await t.request("GET", "/api/admin/overview", { headers: { Authorization: "Bearer scripts-key" } })).status).toBe(200);
  });
});

describe("Admin: giving and taking access", () => {
  it("gives access, emails where to sign in, and handles their waiting request", async () => {
    const t = setup();
    const admin = await t.signIn(ADMIN);
    await t.request("POST", "/api/auth/access", { body: { email: "asha@vendor.example", name: "Asha" } });
    expect((await t.request("POST", "/api/auth/link", { body: { email: "asha@vendor.example" } })).status).toBe(403);

    const given = await t.request("POST", "/api/admin/access", { cookie: admin, body: { email: " Asha@Vendor.example " } });
    expect(given.json).toMatchObject({ ok: true, email: "asha@vendor.example", already: false, invited: true });
    expect(t.outbox.notices.at(-1)).toMatchObject({ to: "asha@vendor.example", subject: "You have access to Kritva" });
    expect(t.outbox.notices.at(-1)!.text).toContain("https://kritva.example/signin");

    // Now she can sign in, and her request no longer waits.
    const asha = await t.signIn("asha@vendor.example");
    expect((await t.request("GET", "/api/operator/mandates", { cookie: asha })).status).toBe(200);
    const overview = (await t.request("GET", "/api/admin/overview", { cookie: admin })).json;
    expect(overview.requests[0]).toMatchObject({ email: "asha@vendor.example", status: "granted" });
    expect(overview.totals.waiting).toBe(0);
    expect(overview.people.find((p: any) => p.email === "asha@vendor.example")).toMatchObject({ source: "admin", grantedBy: ADMIN, signIns: 1 });
  });

  it("can give access without an email", async () => {
    const t = setup();
    const admin = await t.signIn(ADMIN);
    const before = t.outbox.notices.length;
    expect((await t.request("POST", "/api/admin/access", { cookie: admin, body: { email: "quiet@vendor.example", invite: false } })).json.invited).toBe(false);
    expect(t.outbox.notices).toHaveLength(before);
    expect(t.store.isGranted("quiet@vendor.example")).toBe(true);
  });

  it("takes access back and signs them out at once, but not from settings or from yourself", async () => {
    const t = setup();
    const admin = await t.signIn(ADMIN);
    await t.request("POST", "/api/admin/access", { cookie: admin, body: { email: "temp@vendor.example" } });
    const temp = await t.signIn("temp@vendor.example");
    expect((await t.request("DELETE", "/api/admin/access/temp%40vendor.example", { cookie: admin })).status).toBe(200);
    expect((await t.request("GET", "/api/operator/mandates", { cookie: temp })).status).toBe(401);
    expect((await t.request("POST", "/api/auth/link", { body: { email: "temp@vendor.example" } })).status).toBe(403);

    expect((await t.request("DELETE", `/api/admin/access/${encodeURIComponent(TEAM)}`, { cookie: admin })).json.error).toBe("in_settings");
    expect((await t.request("DELETE", `/api/admin/access/${encodeURIComponent(ADMIN)}`, { cookie: admin })).json.error).toBe("self");
    expect((await t.request("DELETE", "/api/admin/access/nobody%40vendor.example", { cookie: admin })).status).toBe(404);
  });

  it("sets a waiting request aside", async () => {
    const t = setup();
    const admin = await t.signIn(ADMIN);
    await t.request("POST", "/api/auth/access", { body: { email: "spam@vendor.example" } });
    const id = (await t.request("GET", "/api/admin/overview", { cookie: admin })).json.requests[0].id;
    expect((await t.request("POST", `/api/admin/requests/${id}/dismiss`, { cookie: admin })).status).toBe(200);
    expect((await t.request("POST", `/api/admin/requests/${id}/dismiss`, { cookie: admin })).status).toBe(404);
    expect((await t.request("GET", "/api/admin/overview", { cookie: admin })).json.requests[0].status).toBe("dismissed");
  });
});

describe("Admin: usage", () => {
  it("counts link sign-ins by day, passkey sign-ins apart, active people and landing visits", async () => {
    const t = setup();
    const admin = await t.signIn(ADMIN);
    await t.signIn(TEAM);
    await t.passkey();
    await t.request("POST", "/api/views", { body: { path: "/" } });
    await t.request("POST", "/api/views", { body: { path: "/" } });
    await t.request("POST", "/api/views", { body: { path: "/" }, headers: { "user-agent": "Googlebot/2.1" } });
    await t.request("POST", "/api/views", { body: { path: "/secret" } });

    const o = (await t.request("GET", "/api/admin/overview", { cookie: admin })).json;
    expect(o.days).toHaveLength(30);
    expect(o.days.at(-1)).toMatchObject({ day: dayOf(Date.now()), signIns: 2, visits: 2 });
    expect(o.totals).toMatchObject({ people: 2, active7: 2, signIns30: 2, passkeySignIns30: 1, visits30: 2, waiting: 0 });
    expect(o.people.map((p: any) => [p.email, p.source, p.admin])).toEqual([
      [ADMIN, "settings", true],
      [TEAM, "settings", false],
    ]);
  });

  it("counts days in India time", () => {
    // 20:00 UTC on 28 Nov is 01:30 on 29 Nov in India.
    expect(dayOf(Date.UTC(2026, 10, 28, 20, 0))).toBe("2026-11-29");
  });
});
