/**
 * Setup check for phone calls (docs/Kritva_Phone_Calls.md). Prints what Vobiz and OpenAI need from
 * the current settings, and optionally sends a signed webhook to a running server to prove the
 * public URL and the webhook secret match, before a real call is placed.
 *
 *   node --env-file=.env apps/server/scripts/phone-check.ts
 *       Shows the settings, the SIP URI for the Vobiz origination URI, and any problem.
 *   node --env-file=.env apps/server/scripts/phone-check.ts --url https://<tunnel host>
 *       Sends OpenAI's empty test event (as the dashboard's "Send test event" does). Expect 200.
 *   node --env-file=.env apps/server/scripts/phone-check.ts --url https://<tunnel host> --ring +918071234567
 *       Sends a made-up incoming call to that number. The server routes it, starts a session and
 *       tries to answer three times; OpenAI refuses because the call does not exist (it answers
 *       503), so expect 200 with error "accept_failed" for a routed number, or "rejected": 404 for
 *       a number with no route. This leaves one empty session in the record.
 */
import { randomUUID } from "node:crypto";
import { INDIA_SIP_HOST, phoneSettingsFromEnv, sipUri } from "../src/phone/config.ts";
import { WEBHOOK_PATH } from "../src/phone/routes.ts";
import { signWebhook } from "../src/phone/webhook-signature.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const { settings, problems } = phoneSettingsFromEnv();
console.log(settings ? "Phone calls: on" : "Phone calls: off");
for (const problem of problems) console.log(`  problem: ${problem}`);
if (!process.env.OPENAI_API_KEY) console.log("  problem: OPENAI_API_KEY is not set.");
const host = settings?.sipHost ?? process.env.KRITVA_PHONE_SIP_HOST ?? INDIA_SIP_HOST;
console.log(`\nVobiz origination URI:  ${sipUri({ projectId: settings?.projectId ?? process.env.OPENAI_PROJECT_ID ?? null, sipHost: host })}`);
console.log("  transport TLS (chosen in the Vobiz console), trunk Secure (SRTP) on");
console.log(`OpenAI webhook URL:     https://<public host>${WEBHOOK_PATH}   (event: realtime.call.incoming)`);
if (settings) {
  console.log("\nNumbers:");
  for (const r of settings.routes) console.log(`  ${r.number === "*" ? "* (any number)" : `+${r.number}`} -> ${r.target.kind === "listing" ? `listing ${r.target.caseId}` : `mandate ${r.target.mandateId}`}`);
  console.log(`Silence check after ${settings.idleMs / 1000} s, time limit ${settings.maxCallMs / 60_000} min, at most ${settings.maxCalls} calls at once.`);
}

const url = option("--url");
if (url) {
  const secret = process.env.OPENAI_WEBHOOK_SECRET;
  if (!secret) throw new Error("OPENAI_WEBHOOK_SECRET is needed to sign the test webhook.");
  const ring = option("--ring");
  const event = ring
    ? { id: `evt_check_${randomUUID()}`, object: "event", type: "realtime.call.incoming", created_at: Math.floor(Date.now() / 1000), data: { call_id: `rtc_check_${randomUUID().replace(/-/g, "")}`, sip_headers: [{ name: "From", value: "<sip:+910000000000@check.invalid>;tag=check" }, { name: "To", value: `<sip:${ring}@${host}>` }] } }
    : { id: `evt_check_${randomUUID()}`, object: "event", type: "realtime.call.incoming", created_at: Math.floor(Date.now() / 1000), data: {} };
  const body = JSON.stringify(event);
  const id = `wh_check_${randomUUID()}`;
  const ts = Math.floor(Date.now() / 1000);
  const target = `${url.replace(/\/+$/, "")}${WEBHOOK_PATH}`;
  const res = await fetch(target, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signWebhook(body, id, ts, secret) }, body });
  console.log(`\nPOST ${target}\n  ${res.status} ${await res.text()}`);
  if (res.status === 400) console.log("  The server refused the signature: OPENAI_WEBHOOK_SECRET differs between here and the server.");
  if (res.status === 404) console.log("  Not found: phone calls are off on that server, or the URL is not this server.");
  if (ring && res.status === 200) console.log("  Routed and tried to answer: \"accept_failed\" is expected for a made-up call. Check the server's phone_incoming log line.");
}
