/**
 * Live check for realtime voice (docs/Kritva_Realtime_Voice.md): runs the real call controller and
 * engine against OpenAI's realtime model, playing recorded speech clips (24 kHz mono PCM16) into the
 * call at real-time pace, and reports what Kritva said and how fast.
 *
 *   node --env-file=.env apps/server/scripts/realtime-check.ts <clips-dir> clip1 clip2 ...
 *
 * Uses a WebSocket call instead of WebRTC, so the browser is not needed. Writes to a temporary record.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentFromEnv, createTurnLlmFromEnv, NegotiationEngine, NegotiationRecord, SqliteRecordBackend, type PayloadOf } from "@kritva/core";
import { loadCaseRuntime } from "../src/main-helpers.ts";
import { RealtimeCall, realtimeSession, realtimeSettingsFromEnv, type RealtimeEvent, type RealtimeLink } from "../src/realtime-voice.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const [dir, ...clips] = process.argv.slice(2);
if (!dir || clips.length === 0) throw new Error("Usage: realtime-check.ts <clips-dir> clip ...");
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error("OPENAI_API_KEY is not set.");

const record = new NegotiationRecord(new SqliteRecordBackend(join(mkdtempSync(join(tmpdir(), "kritva-rt-")), "record.sqlite")));
const { mandates, guidanceByCase, defaultGuidance, subjectFacts, listingDetails } = loadCaseRuntime(ROOT, null);
const engine = new NegotiationEngine({ record, llm: createTurnLlmFromEnv(), ...createAgentFromEnv(), locale: "en-IN", guidance: defaultGuidance, guidanceByCase, subjectFacts, listingDetails });
const mandate = mandates.find((m) => m.mandate.caseId === (process.env.CASE ?? "bed-sale"))?.mandate ?? mandates[0]!.mandate;
const started = await record.startSession({ mandate });
if (!started.ok) throw new Error(started.error.message);
const sessionId = started.session.id;

const settings = realtimeSettingsFromEnv();
const briefing = (await engine.voiceBriefing(sessionId))!;
const session = realtimeSession(settings, briefing) as { audio: { input: Record<string, unknown>; output: Record<string, unknown> } };
session.audio.input.format = { type: "audio/pcm", rate: 24_000 };
session.audio.output.format = { type: "audio/pcm", rate: 24_000 };

const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${settings.model}`, { headers: { Authorization: `Bearer ${key}` } } as unknown as string[]);
const observers: Array<(e: RealtimeEvent & { _t: number }) => void> = [];
const link: RealtimeLink = { send: (e) => ws.send(JSON.stringify(e)), close: () => ws.close(), onEvent: null, onClose: null };
let last = performance.now();
ws.onmessage = (m) => {
  const e = JSON.parse(String(m.data)) as RealtimeEvent & { _t: number };
  e._t = last = performance.now();
  if (e.type === "error") console.log("  ! error", JSON.stringify(e.error));
  for (const o of observers) o(e);
  link.onEvent?.(e);
};
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ type: "session.update", session }));
await new Promise<void>((r) => observers.push((e) => e.type === "session.updated" && r()));

let hungUp = false;
const call = new RealtimeCall({
  engine,
  record,
  sessionId,
  link,
  afterSeq: 0,
  log: (entry) => console.log("  [controller]", JSON.stringify(entry)),
  // Kritva decided the call is over: noted here instead of hanging up a phone line.
  hangup: async () => {
    hungUp = true;
    console.log("  [hangup] Kritva ended the call");
  },
});
const said: string[] = [];
/** Times from the end of the clip's speech (before the trailing silence). */
let clipEnd = 0;
const marks: Record<string, number> = {};
const mark = (name: string, t: number) => {
  if (clipEnd && marks[name] === undefined) marks[name] = Math.round(t - clipEnd);
};
const sayResponses = new Set<string>();
observers.push((e) => {
  if (e.type === "input_audio_buffer.speech_stopped") mark("vad_end", e._t);
  if (e.type === "response.created" && e.response?.metadata?.kritva === "say") sayResponses.add(e.response.id);
  if (e.type === "response.output_audio.delta") mark(sayResponses.has(e.response_id) ? "reply_audio" : "first_audio", e._t);
  if (e.type === "response.function_call_arguments.done") mark("tool_args", e._t);
  if (e.type === "response.done") {
    const text = (e.response?.output ?? []).flatMap((o: { content?: Array<{ transcript?: string }> }) => o.content ?? []).map((c: { transcript?: string }) => c.transcript ?? "").join(" ").trim();
    const mine = e.response?.metadata?.kritva === "say";
    if (!mine) mark("own_done", e._t);
    // No browser here: a reply that finished generating counts as heard, as the browser would report after playback.
    if (mine && e.response?.status === "completed") void engine.reportDelivery({ sessionId, messageId: e.response.metadata.message_id, channel: "voice", status: "delivered" });
    if (text) said.push(`${mine ? "say" : "own"}: ${text}`);
  }
});

/** Waits until the call is idle and nothing has arrived for a while (audio still plays after generation). */
const quiet = async (ms: number) => {
  while ((performance.now() - last < ms || !call.idle) && !call.closed) await new Promise((r) => setTimeout(r, 200));
};
const sendClip = async (pcm: Buffer) => {
  const chunk = 4_800; // 100 ms
  for (let i = 0; i < pcm.length; i += chunk) {
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.subarray(i, i + chunk).toString("base64") }));
    await new Promise((r) => setTimeout(r, 100));
  }
  clipEnd = performance.now();
  for (const k of Object.keys(marks)) delete marks[k];
  const silence = Buffer.alloc(chunk);
  for (let i = 0; i < 45; i += 1) {
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: silence.toString("base64") }));
    await new Promise((r) => setTimeout(r, 100));
  }
};

await call.start();
await quiet(3_000);
console.log(`greeting: ${said.splice(0).join(" | ")}`);
for (const clip of clips) {
  console.log(`\n> ${clip}`);
  await sendClip(readFileSync(join(dir, `${clip}.pcm`)));
  await quiet(4_000);
  console.log(`  ms after speech ended: ${JSON.stringify(marks)}`);
  clipEnd = 0;
  for (const s of said.splice(0)) console.log(`  ${s}`);
  if (hungUp || call.closed) {
    console.log("  (the call has ended)");
    break;
  }
}
console.log(`\ncall ended by Kritva: ${hungUp ? "yes" : "no"}`);

const ctx = await record.context(sessionId);
console.log("\nrecorded messages:");
for (const e of ctx.events) {
  if (e.type !== "message") continue;
  const p = e.payload as PayloadOf<"message">;
  console.log(`  ${p.direction === "inbound" ? "them" : "kritva"}: ${p.text}`);
}
call.close();
process.exit(0);
