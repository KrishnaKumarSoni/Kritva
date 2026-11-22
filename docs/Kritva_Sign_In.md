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
- **Who may sign in**: with emailed links, only the addresses in `KRITVA_SIGNIN_EMAILS`. A request for any other address gets the same answer and sends nothing. With links in the server log, any email may ask, because whoever reads that log already controls the server.
- **Limits**: 5 links per address per 15 minutes; a link works once.
- **Scripts and tools** keep using the access key (`Authorization: Bearer <KRITVA_OPERATOR_KEY>`); the server prints a random one at startup when none is set. The console never asks for it.
- The web app and the API must share one origin (the Vite dev proxy does this locally), because the cookie is `SameSite=Strict`.

## 3. Settings

| Setting | Default | Meaning |
|---|---|---|
| `KRITVA_WEB_URL` | (none) | The console's public address (https), where links point. Locally, the page's own localhost address is used. |
| `KRITVA_EMAIL_FROM` | (none) | The sender, for example `Kritva <signin@yourdomain.com>`. Setting it turns on emailed links (Amazon SES). |
| `KRITVA_SIGNIN_EMAILS` | (none) | Who may sign in, comma-separated. Required for emailed links. |
| `KRITVA_EMAIL_PROVIDER` | `ses` when `KRITVA_EMAIL_FROM` is set, else `console` | `console` prints links in the server log. |
| `KRITVA_SES_REGION` | `ap-south-1` | The SES region (Mumbai, close to Bangalore). |
| AWS credentials | (environment, profile or instance role) | The usual AWS settings; the server needs `ses:SendEmail`. |

The server prints at startup how sign-in links are delivered and what is missing.

## 4. Email delivery: Amazon SES

Chosen because the project runs on AWS (`CLAUDE.md`) and SES has a Mumbai region. The sender is one small class (`SesEmailSender` in `apps/server/src/auth.ts`), so another provider is a drop-in replacement. These steps need your AWS account:

1. In the SES console, region **Asia Pacific (Mumbai)**, verify the sender: a domain (best: add the DKIM records it gives you) or a single email address.
2. A new SES account is in the **sandbox**: it can only send to verified addresses. For the demo, verify your own address too; or request production access.
3. Give the server credentials allowed `ses:SendEmail` (an IAM user's keys locally, the instance or task role on AWS).
4. Set `KRITVA_EMAIL_FROM`, `KRITVA_SIGNIN_EMAILS` and `KRITVA_WEB_URL`, and restart.

Until then, links are printed in the server log, which is all a local demo needs.

## 5. Demo day

1. Before the audience arrives, open the console on the demo laptop and sign in (from the email, or the link in the server log). It stays signed in for 30 days.
2. On stage, reload the page: the curtain rises on the console.
3. Make a mandate live: the go-live moment shows the number and the code. Invite the room to call.

## 6. Code map

| File | What it holds |
|---|---|
| `apps/server/src/auth.ts` | Links, sessions, the SES and log senders, settings, the `/api/auth` routes, and `signedIn` for the console's routes. |
| `apps/server/src/app.ts` | `/api/operator/*` accepts a signed-in session or the scripts' access key. |
| `apps/web/src/Stage.tsx` | The curtain: hold, sign-in form, lift; the drop on sign-out. |
| `apps/web/src/GoLive.tsx` | The go-live moment. |
| `apps/web/src/App.tsx` | Who is signed in, the link's token, the account menu. |
| `apps/server/test/auth.test.ts` | One-time links, expiry, who may sign in, the link's address, the rate limit, a failed email, sign-out, and the scripts' key. |
