# Kritva on Cloudflare

How Kritva runs in production since 2026-11-28, when it moved off AWS (the hackathon account ended). Live at https://kritva.krishnakumarsoni.com.

## 1. What runs where

```
Browser ──► Worker "kritva" (custom domain kritva.krishnakumarsoni.com, every Cloudflare edge)
              ├─ web app: static assets (apps/web/dist), single-page fallback
              └─ /api/*  ──► Durable Object KritvaServer "kritva" (one object, created in US east)
                               ├─ the Hono server from apps/server (compose.ts), unchanged
                               ├─ SQLite: record, mandate library, intake, sign-in (the object's own storage)
                               ├─ R2 bucket kritva-recordings: browser call recordings
                               ├─ Email Sending: sign-in links from signin@kritva.krishnakumarsoni.com
                               └─ OpenAI (models, realtime sideband) and Twilio (REST)
Twilio and OpenAI webhooks ──► the same /api routes
Call audio: browser ↔ OpenAI (WebRTC) and Twilio ↔ OpenAI (SIP), never through Kritva.
```

| Piece | Where | Why |
|---|---|---|
| Web app | Workers static assets | Served from the edge nearest the user (Bangalore users get a local edge). |
| Server | One Durable Object, `apps/worker/src/server.ts` | The server keeps live calls, the deal board and the record in one process's memory, as on Node. A Durable Object is one long-lived process with its own storage, so the server runs unchanged. |
| Database | The object's SQLite storage, `apps/worker/src/durable-sql.ts` | Synchronous like `node:sqlite`, so every store runs as is (`packages/core/src/record/sql.ts`). Writes are durable before the response leaves. |
| Recordings | R2 `kritva-recordings`, keys `recordings/<session>/<rec>.<ext>` | Object storage; a Worker has no disk. |
| Sign-in email | Cloudflare Email Sending (`send_email` binding) | Replaces Amazon SES. Sending is set up on the subdomain only (DKIM, SPF and DMARC records under `kritva.krishnakumarsoni.com`), so the apex domain's records are untouched. |
| Guides and cases | Bundled at build time (`apps/worker/scripts/bundle-files.ts`) | A Worker has no disk; the `.md` and `.json` files stay the only copies. |

### Why the server is in US east, not near Bangalore

Every negotiation turn makes several OpenAI calls one after another, and OpenAI serves them from the US. Measured from Durable Objects on 2026-11-28 with Kritva's turn model (`gpt-5.4-mini`, 16 short calls each):

| Object location | Short model call (median) | API round trip |
|---|---|---|
| Singapore (`apac`) | about 930 ms | about 460 ms |
| US west (`wnam`) | about 580 ms | about 290 ms |
| US east (`enam`) | about 560 ms | about 330 ms |

So the object is created with `locationHint: "enam"` (`KRITVA_LOCATION_HINT`). The browser's single hop from Bangalore to the object costs about 250 ms once per request, while a turn saves about 350 ms per model call. With no hint, the object was placed in Amsterdam. An object never moves after it is created: to move it, change the name in `apps/worker/src/index.ts` (this starts an empty database).

## 2. Deploy

```bash
scripts/deploy-cloudflare.sh
```

It deploys `main` exactly as it is on origin, built from a clean copy (`git archive`), and waits until `https://kritva.krishnakumarsoni.com/api/health` reports the commit. Options: `--secrets` also sets the secrets, `--ref <commit>` deploys a commit that is not on origin yet. Needs Node 24 and `npx wrangler login` (the Cloudflare account that holds `krishnakumarsoni.com`). A deploy never touches the database.

Check what is live:

```bash
curl -s https://kritva.krishnakumarsoni.com/api/health
```

## 3. Settings and secrets

Safe settings are `vars` in `apps/worker/wrangler.jsonc`: the public URL, the email sender, board calls, the phone setup delay and the location hint.

Secrets are set with `wrangler secret`, never in git. `scripts/deploy-cloudflare.sh --secrets` reads `.env` and then `.env.production` (later wins), skips local-only settings (`PORT`, `KRITVA_HOST`, `KRITVA_DATA_DIR`, `KRITVA_PHONE_LOG_FILE`, old `VOBIZ_*` and AWS ones) and anything already in `vars`, and sends the rest with `wrangler secret bulk`. Values are never printed. Set today: `OPENAI_API_KEY`, `SARVAM_API_KEY`, `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `OPENAI_PROJECT_ID`, `OPENAI_WEBHOOK_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `KRITVA_OPERATOR_KEY`, `KRITVA_SIGNIN_EMAILS`, `KRITVA_PHONE_ROUTES`, `KRITVA_PHONE_CALLER_ID`, `KRITVA_PHONE_OUTBOUND_ALLOW`, `KRITVA_PHONE_SIP_HOST`, `KRITVA_PHONE_TRACE`. To change one:

```bash
npx wrangler secret put OPENAI_API_KEY --config apps/worker/wrangler.jsonc
```

The jury passkey is the built-in default (`kritva-jury-2026`, see `JURY.md`); set `KRITVA_PASSKEY=off` as a secret to turn it off.

## 4. Phone calls

Phone calls run on Vobiz with Sarvam speech, and the media stream comes into the Durable Object as a WebSocket (`docs/Kritva_Phone_Calls.md`, section 17). Kritva's Vobiz number `+91 80 6426 4194` is linked to the Vobiz application `kritva`, whose answer and hangup URLs are `https://kritva.krishnakumarsoni.com/api/phone/vobiz/answer` and `…/hangup`. Outbound calls carry their own URLs. Nothing points at OpenAI's SIP webhook or Twilio any more; that path stays in the code behind `KRITVA_TELEPHONY=twilio`.

## 5. Local development

Unchanged: `npm run dev -w @kritva/server` and `npm run dev -w @kritva/web` run on Node with `data/kritva.sqlite`. To run the Cloudflare version locally (the real Workers runtime, a local Durable Object, R2 and email simulated):

```bash
npm run build -w @kritva/web
npm run dev -w @kritva/worker     # http://localhost:8787, secrets from apps/worker/.dev.vars
```

## 6. Operations

- **Logs**: `npx wrangler tail --config apps/worker/wrangler.jsonc`, or Workers & Pages, kritva, Logs in the dashboard (observability is on).
- **Roll back**: `npx wrangler rollback --config apps/worker/wrangler.jsonc` (code only; the database is not rolled back).
- **Data**: the object's SQLite has point-in-time recovery for 30 days (Durable Objects bookmarks). The data from the AWS box was not carried over: the box was unreachable once the hackathon account ended. The demo listing is seeded from `cases/` on start, as before.
- **Limits**: an open outbound WebSocket keeps the object in memory for up to 15 minutes, longer than a call's time limit.
