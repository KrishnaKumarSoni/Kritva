/**
 * Vobiz inbound trunk helper for phone calls (docs/Kritva_Phone_Calls.md, section 9.2).
 *
 * Vobiz's console has no switch for SRTP (encrypted call audio) on an inbound trunk, and OpenAI's
 * SIP endpoint needs it: without SRTP a call connects and bills but has no audio. This shows a
 * trunk's settings and turns SRTP on through Vobiz's API
 * (https://www.vobiz.ai/docs/trunks/update-trunk).
 *
 *   node --env-file=.env apps/server/scripts/vobiz-trunk.ts              shows the trunk
 *   node --env-file=.env apps/server/scripts/vobiz-trunk.ts --secure     sets TLS signalling and SRTP media
 *
 * Needs VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN (console dashboard) and VOBIZ_TRUNK_ID (the trunk's ID).
 */
const { VOBIZ_AUTH_ID: id, VOBIZ_AUTH_TOKEN: token, VOBIZ_TRUNK_ID: trunk } = process.env;
if (!id || !token || !trunk) throw new Error("Set VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN and VOBIZ_TRUNK_ID in .env.");

const url = `https://api.vobiz.ai/api/v1/Account/${encodeURIComponent(id)}/trunks/${encodeURIComponent(trunk)}`;
const headers = { "X-Auth-ID": id, "X-Auth-Token": token, "Content-Type": "application/json" };

async function call(method: "GET" | "PUT", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vobiz ${method} trunk failed (${res.status}): ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as Record<string, unknown>;
  return (json.trunk ?? json.data ?? json) as Record<string, unknown>;
}

/** The settings that matter for OpenAI's SIP endpoint, nothing secret. */
const show = (t: Record<string, unknown>) =>
  console.log(JSON.stringify({ name: t.name, direction: t.trunk_direction, status: t.trunk_status, transport: t.transport, secure: t.secure, primary_uri_uuid: t.primary_uri_uuid, concurrent_calls_limit: t.concurrent_calls_limit }, null, 2));

if (process.argv.includes("--secure")) {
  await call("PUT", { secure: true, transport: "tls" });
  console.log("Updated: transport tls, secure (SRTP) on.");
}
show(await call("GET"));
