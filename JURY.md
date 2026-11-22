# Kritva: guide for the jury

Kritva is an AI negotiator that represents a person or business (the principal) in a negotiation with a counterparty, by text, browser voice or phone. The project rules for AI coding agents are in [CLAUDE.md](CLAUDE.md) at the root of this repository.

## Try it live

- URL: https://184-33-88-175.sslip.io
- Sign in: use the **passkey** field below the email field.

## Test login

| Method | Value |
| --- | --- |
| Passkey | `kritva-jury-2026` |
| Email link | Any email on a local run: the one-time link is printed in the server's log |

The passkey is set on the server with `KRITVA_PASSKEY` (default `kritva-jury-2026`; set `KRITVA_PASSKEY=off` to turn it off). `KRITVA_PASSKEY_EMAIL` sets which account a passkey sign-in uses.

## Run it locally

Requires Node 24 and an OpenAI API key.

```bash
git clone https://github.com/KrishnaKumarSoni/Kritva.git
cd Kritva
nvm install 24 && nvm use 24
npm install
echo "OPENAI_API_KEY=sk-..." > .env
```

Start the server (port 8787) in one terminal:

```bash
npm run dev -w @kritva/server
```

Start the web app (port 5173) in a second terminal:

```bash
npm run dev -w @kritva/web
```

Open http://localhost:5173 and sign in with the passkey `kritva-jury-2026`.

Run the offline test suite:

```bash
npm test
```

## End-to-end journeys to try

1. **Sign in.** Enter the passkey below the email field. The black curtain rises on the console.
2. **Create a mandate by chatting.** On Mandates, start a new mandate and describe what you want to sell or buy in plain language (for example, "Selling my queen bed, bought for 40,000, want around 25,000, lowest 20,000"). The intake agent asks only for what it cannot infer, a progress bar fills, and the draft appears with **Make it live**.
3. **Review and correct the mandate.** Check what Kritva understood (public details, private limit, authority), correct a value, and confirm the exact draft.
4. **Make it live.** The mandate gets a 4-digit listing code and a go-live moment with the line's number. Use "Copy for your ad".
5. **Negotiate by text as the counterparty.** Open the demo listing and chat as a buyer. Kritva says it is an AI acting for the principal, asks useful questions and counters. Try lowballing below the limit: it never goes below it.
6. **Negotiate by browser voice.** On the demo listing press "Call seller" and talk (Hindi by default, switch to English any time). Interrupt it mid-sentence: it stops and listens.
7. **Watch the console live.** Beside the call, the principal's console shows every message, offers delivered or held back, and the last recorded action.
8. **Approve an exception.** Push for a price just outside the limit. Kritva asks the principal for approval, scoped to that exact offer. Approve or decline from the console.
9. **Change instructions mid-negotiation.** Use "Change instructions" in the console, edit the mandate, and confirm. The open session follows the new revision.
10. **Pause and resume.** Pause the negotiation from the console, then resume it.
11. **Reach an outcome.** Agree on a price. The outcome card shows the agreed terms and pending obligations (payment, pickup).
12. **Phone call (outbound).** From the console, have Kritva call a phone number about a live mandate. The call uses the same voice and the same rules as the browser.
13. **New demo session.** Start a fresh session on the same saved mandate and try a different buyer style.
14. **Sign out.** The curtain comes back down.
