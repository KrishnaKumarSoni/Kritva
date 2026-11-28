/** Signing in to the console with an emailed link (docs/Kritva_Sign_In.md). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MandateRevisions, NegotiationEngine, NegotiationRecord, SqliteRecordBackend, type StructuredLlm } from "@kritva/core";
import { createApp } from "../src/app.ts";
import { AuthStore, authFromEnv, CloudflareEmailSender, ConsoleEmailSender, signInMessage, type AuthSettings, type EmailSender, type SignInEmail } from "../src/auth.ts";
import { loadConfirmedMandates } from "../src/main-helpers.ts";

const CASES = resolve(import.meta.dirname, "../../../cases");
const KEY = "scripts-key";

/** Keeps the emails it was asked to send. */
class Outbox implements EmailSender {
  readonly kind = "cloudflare" as const;
  readonly sent: SignInEmail[] = [];
  fail = false;
  async sendSignIn(email: SignInEmail) {
    if (this.fail) throw new Error("Email Sending said no");
    this.sent.push(email);
  }
}

function setup(settings: Partial<AuthSettings> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kritva-auth-"));
  const db = join(dir, "db.sqlite");
  const record = new NegotiationRecord(new SqliteRecordBackend(db));
  const llm: StructuredLlm = { generate: async () => { throw new Error("not used"); } };
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN" });
  const outbox = new Outbox();
  const store = new AuthStore(db);
  const auth = { store, settings: { webUrl: "https://kritva.example", allowed: ["krishna@example.com"], sender: outbox as EmailSender, ...settings } };
  const app = createApp({ record, engine, revisions: new MandateRevisions({ record, engine, mappingLlm: llm }), mandates: loadConfirmedMandates(CASES), locale: "en-IN", operatorKey: KEY, auth });
  const request = async (method: string, path: string, init: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
    if (init.cookie) headers.cookie = init.cookie;
    const res = await app.request(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any, setCookie: res.headers.get("set-cookie") };
  };
  const tokenOf = (link: string) => /#token=([\w-]+)$/.exec(link)![1]!;
  /** Asks for a link and signs in with it; returns the session cookie. */
  const signIn = async (email = "krishna@example.com") => {
    await request("POST", "/api/auth/link", { body: { email } });
    const verified = await request("POST", "/api/auth/verify", { body: { token: tokenOf(outbox.sent.at(-1)!.link) } });
    expect(verified.status).toBe(200);
    return verified.setCookie!.split(";")[0]!;
  };
  return { app, store, outbox, request, tokenOf, signIn };
}

describe("Sign-in: the emailed link", () => {
  it("emails a one-time link to the configured web address, and signs in with it", async () => {
    const t = setup();
    expect((await t.request("GET", "/api/operator/mandates")).status).toBe(401);
    const asked = await t.request("POST", "/api/auth/link", { body: { email: "  Krishna@Example.com " } });
    expect(asked.status).toBe(202);
    expect(t.outbox.sent).toHaveLength(1);
    expect(t.outbox.sent[0]).toMatchObject({ to: "krishna@example.com", minutes: 15 });
    // The token is in the fragment: it never reaches a server log or a Referer header.
    expect(t.outbox.sent[0]!.link).toMatch(/^https:\/\/kritva\.example\/signin#token=[\w-]{40,}$/);
    const verified = await t.request("POST", "/api/auth/verify", { body: { token: t.tokenOf(t.outbox.sent[0]!.link) } });
    expect(verified.json).toEqual({ ok: true, email: "krishna@example.com" });
    expect(verified.setCookie).toMatch(/kritva_session=[\w-]+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Strict/);
    const cookie = verified.setCookie!.split(";")[0]!;
    expect((await t.request("GET", "/api/operator/mandates", { cookie })).status).toBe(200);
    expect((await t.request("GET", "/api/auth/me", { cookie })).json).toEqual({ email: "krishna@example.com" });
  });

  it("uses a link only once", async () => {
    const t = setup();
    await t.request("POST", "/api/auth/link", { body: { email: "krishna@example.com" } });
    const token = t.tokenOf(t.outbox.sent[0]!.link);
    expect((await t.request("POST", "/api/auth/verify", { body: { token } })).status).toBe(200);
    const again = await t.request("POST", "/api/auth/verify", { body: { token } });
    expect(again).toMatchObject({ status: 400, json: { error: "link_expired" } });
    expect(again.setCookie).toBeNull();
  });

  it("refuses an expired link", async () => {
    const t = setup();
    const token = t.store.createLink("krishna@example.com", Date.now() - 16 * 60_000);
    expect((await t.request("POST", "/api/auth/verify", { body: { token } })).status).toBe(400);
  });

  it("sends nothing to an address that may not sign in, and answers the same way", async () => {
    const t = setup();
    const asked = await t.request("POST", "/api/auth/link", { body: { email: "stranger@example.com" } });
    expect(asked.status).toBe(202);
    expect(asked.json.message).toMatch(/If this email can sign in/);
    expect(t.outbox.sent).toHaveLength(0);
    expect((await t.request("POST", "/api/auth/link", { body: { email: "not an email" } })).status).toBe(400);
  });

  it("never points the link at the address a request claims to come from", async () => {
    const t = setup({ webUrl: null });
    // A stranger's page cannot make Kritva email a real link that leads to their site.
    const evil = await t.request("POST", "/api/auth/link", { body: { email: "krishna@example.com" }, headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(503);
    expect(t.outbox.sent).toHaveLength(0);
    // Without a configured address, a local page may ask (development).
    await t.request("POST", "/api/auth/link", { body: { email: "krishna@example.com" }, headers: { origin: "http://localhost:5173" } });
    expect(t.outbox.sent[0]!.link).toMatch(/^http:\/\/localhost:5173\/signin#token=/);
  });

  it("limits how many links one address can ask for", async () => {
    const t = setup();
    for (let i = 0; i < 5; i += 1) expect((await t.request("POST", "/api/auth/link", { body: { email: "krishna@example.com" } })).status).toBe(202);
    expect((await t.request("POST", "/api/auth/link", { body: { email: "krishna@example.com" } })).status).toBe(429);
  });

  it("says so when the email could not be sent", async () => {
    const t = setup();
    t.outbox.fail = true;
    expect((await t.request("POST", "/api/auth/link", { body: { email: "krishna@example.com" } })).json.error).toBe("email_failed");
  });

  it("signs out: the session ends and the console is closed again", async () => {
    const t = setup();
    const cookie = await t.signIn();
    const out = await t.request("POST", "/api/auth/signout", { cookie });
    expect(out.setCookie).toMatch(/kritva_session=;/);
    expect((await t.request("GET", "/api/operator/mandates", { cookie })).status).toBe(401);
    expect((await t.request("GET", "/api/auth/me", { cookie })).status).toBe(401);
  });

  it("still lets scripts use the access key", async () => {
    const t = setup();
    expect((await t.request("GET", "/api/operator/mandates", { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(200);
    expect((await t.request("GET", "/api/operator/mandates", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });
});

describe("Sign-in: settings", () => {
  it("prints links in the log unless Cloudflare Email Sending is set up with who may sign in", () => {
    const binding = { send: async () => ({ messageId: "m1" }) };
    const env = { KRITVA_EMAIL_FROM: "signin@kritva.example", KRITVA_SIGNIN_EMAILS: "Krishna@Example.com, bad", KRITVA_WEB_URL: "https://kritva.example/" };
    expect(authFromEnv({}).settings.sender.kind).toBe("console");
    expect(authFromEnv({ KRITVA_EMAIL_FROM: "Kritva <signin@kritva.example>" }, { emailBinding: binding }).settings.sender.kind).toBe("console");
    // Off Cloudflare there is no binding, so the link stays in the log even with everything else set.
    expect(authFromEnv(env).settings.sender.kind).toBe("console");
    const cloudflare = authFromEnv(env, { emailBinding: binding });
    expect(cloudflare.settings.sender.kind).toBe("cloudflare");
    expect(cloudflare.settings.allowed).toEqual(["krishna@example.com"]);
    expect(cloudflare.settings.webUrl).toBe("https://kritva.example");
    expect(authFromEnv({ KRITVA_WEB_URL: "http://kritva.example" }).settings.webUrl).toBeNull();
  });

  it("Cloudflare Email Sending gets the sender's name and address, and the link in text and HTML", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const sender = new CloudflareEmailSender({ send: async (m) => void sent.push(m) }, "Kritva <signin@kritva.example>");
    await sender.sendSignIn({ to: "a@b.co", link: "https://kritva.example/signin#token=abc", minutes: 15 });
    expect(sent[0]).toMatchObject({ from: { name: "Kritva", email: "signin@kritva.example" }, to: "a@b.co", subject: "Your Kritva sign-in link" });
    expect(String(sent[0]!.text)).toContain("https://kritva.example/signin#token=abc");
    expect(String(sent[0]!.html)).toContain("https://kritva.example/signin#token=abc");
  });

  it("the log sender prints the link; the email carries it in text and HTML", async () => {
    const lines: string[] = [];
    await new ConsoleEmailSender((l) => lines.push(l)).sendSignIn({ to: "a@b.co", link: "http://localhost:5173/signin#token=abc", minutes: 15 });
    expect(lines[0]).toContain("http://localhost:5173/signin#token=abc");
    const message = signInMessage({ to: "a@b.co", link: "https://kritva.example/signin#token=abc", minutes: 15 });
    expect(message.text).toContain("https://kritva.example/signin#token=abc");
    expect(message.html).toContain('href="https://kritva.example/signin#token=abc"');
  });
});
