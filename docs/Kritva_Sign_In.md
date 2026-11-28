# Kritva sign-in and the curtain

How the principal gets into the console, and the two full-screen moments around it. Written 2026-11-22.

## 1. What the principal sees

| Moment | What happens |
|---|---|
| **The curtain** (every load of the console) | A jet-black screen with the Kritva wordmark; the orange dot pulses once; after about a second the curtain rises and reveals the console. Any key or click raises it at once. With reduced motion it fades. |
| **Signing in** (signed out) | The curtain stays down and carries one field: the email. **Email me a link** sends a one-time link. Opening it signs this browser in, and the curtain rises. |
| **Signing out** (account menu, top right) | The session ends and the curtain comes down from the top, back to the sign-in field. |
| **Going live** (a mandate's first **Make it live**) | The curtain comes down once more: "Kritva is live.", the mandate, the line's number and the listing code, digit by digit, with **Copy for your ad** and **Done** (or Escape). Later revisions do not repeat it. |

There is no password and no access key on screen. The console stays signed in for 30 days on that browser.

## 2. How the link works

```
POST /api/auth/link   {email}  → a one-time link (15 minutes), emailed (or printed in the server log)
link: <KRITVA_WEB_URL>/signin#token=...   → the page posts the token
POST /api/auth/verify {token}  → the token is used up; cookie kritva_session (HttpOnly, SameSite=Strict, 30 days)
GET  /api/auth/me              → who is signed in (401 when nobody is)
POST /api/auth/signout         → the session ends; the cookie is cleared
```

- **The token is in the fragment** (`#token=`), so it never reaches a server log, a proxy or a Referer header, and the page removes it from the address at once.
- **An email scanner that opens the link does not use it up**: the token is only used when the page posts it, and scanners run no script.
- **Only hashes are stored** (of link tokens and session IDs), in `auth_links` and `auth_sessions` in `data/kritva.sqlite`.
- **The link always points at `KRITVA_WEB_URL`**, never at the address a request claims to come from. Otherwise a stranger's page could make Kritva email the principal a real link that leads to the stranger's site. Without `KRITVA_WEB_URL`, only a local address (localhost) is accepted.
- **Who may sign in**: with emailed links, only the addresses in `KRITVA_SIGNIN_EMAILS`. Any other address sends nothing and is told so plainly (`403 no_access`), so a visitor never waits for an email that will not come. This shows whether an address is on the list; it gives no access, because a link only ever goes to the address itself. With links in the server log, any email may ask, because whoever reads that log already controls the server.
- **Access requests**: after `no_access`, the sign-in page offers a short form (name, company, what they want to negotiate). `POST /api/auth/access` keeps it in `access_requests` and emails it to `KRITVA_ACCESS_NOTIFY`, or else to the first address in `KRITVA_SIGNIN_EMAILS`. One request per email a day is kept and sent; at most 30 an hour in all. To let someone in, add their email to `KRITVA_SIGNIN_EMAILS`.
- **Limits**: 5 links per address per 15 minutes; a link works once.
- **Scripts and tools** keep using the access key (`Authorization: Bearer <KRITVA_OPERATOR_KEY>`); the server prints a random one at startup when none is set. The console never asks for it.
- The web app and the API must share one origin (the Vite dev proxy does this locally), because the cookie is `SameSite=Strict`.

## 3. Settings

| Setting | Default | Meaning |
|---|---|---|
| `KRITVA_WEB_URL` | (none) | The console's public address (https), where links point. Locally, the page's own localhost address is used. |
| `KRITVA_EMAIL_FROM` | (none) | The sender, for example `Kritva <signin@kritva.krishnakumarsoni.com>`. On a domain set up for Cloudflare Email Sending. |
| `KRITVA_SIGNIN_EMAILS` | (none) | Who may sign in, comma-separated. Required for emailed links. |
| `KRITVA_ACCESS_NOTIFY` | the first address in `KRITVA_SIGNIN_EMAILS` | Who gets access requests by email, comma-separated. |
| `KRITVA_EMAIL_PROVIDER` | `cloudflare` on Cloudflare when `KRITVA_EMAIL_FROM` is set, else `console` | `console` prints links in the server log. `cloudflare` needs the Worker's `EMAIL` binding, so it works only on Cloudflare. |

The server prints at startup how sign-in links are delivered and what is missing.

## 4. Email delivery: Cloudflare Email Sending

Since 2026-11-28 Kritva runs on Cloudflare (`docs/Kritva_Cloudflare.md`), and Cloudflare Email Sending replaced Amazon SES. The Worker has a `send_email` binding named `EMAIL`; `CloudflareEmailSender` in `apps/server/src/auth.ts` sends through it. On Node (local runs) there is no binding, so links go to the server log.

Set up once (done for `kritva.krishnakumarsoni.com`):

```bash
npx wrangler email sending enable kritva.krishnakumarsoni.com
npx wrangler email sending dns get kritva.krishnakumarsoni.com   # the records Cloudflare added
```

Sending is enabled on the subdomain only, so Cloudflare's DKIM (`cf-bounce._domainkey`), SPF and bounce MX (`cf-bounce`) and DMARC records live under `kritva.krishnakumarsoni.com` and the apex domain's records are untouched. The sender is `Kritva <signin@kritva.krishnakumarsoni.com>` (a var in `apps/worker/wrangler.jsonc`), and who may sign in is the `KRITVA_SIGNIN_EMAILS` secret. The Workers Paid plan lets it send to any address; the first link sent on 2026-11-28 landed in the Gmail inbox, not spam.

Until this is set up, links are printed in the server log, which is all a local demo needs.

## 5. Demo day

1. Before the audience arrives, open the console on the demo laptop and sign in (from the email, or the link in the server log). It stays signed in for 30 days.
2. On stage, reload the page: the curtain rises on the console.
3. Make a mandate live: the go-live moment shows the number and the code. Invite the room to call.

## 6. Code map

| File | What it holds |
|---|---|
| `apps/server/src/auth.ts` | Links, sessions, the Cloudflare Email Sending and log senders, settings, the `/api/auth` routes, and `signedIn` for the console's routes. |
| `apps/server/src/app.ts` | `/api/operator/*` accepts a signed-in session or the scripts' access key. |
| `apps/web/src/Stage.tsx` | The curtain: hold, sign-in form, lift; the drop on sign-out. |
| `apps/web/src/GoLive.tsx` | The go-live moment. |
| `apps/web/src/App.tsx` | Who is signed in, the link's token, the account menu. |
| `apps/server/test/auth.test.ts` | One-time links, expiry, who may sign in, the link's address, the rate limit, a failed email, sign-out, and the scripts' key. |
