/**
 * Epic 13 timing check. Plays the buyer with synthesized speech (no microphone needed) through the
 * real voice routes: speech → transcription → the text negotiation core → a checked reply → speech.
 * Measures, per turn, the server time (transcription + core) and the time to the first byte of
 * Kritva's audio, and writes test-results/epic-12-14/voice-timing.md.
 *
 *   node --env-file=.env apps/server/scripts/voice-check.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createMappingLlmFromEnv,
  createSpeechFromEnv,
  createTurnLlmFromEnv,
  MandateLibrary,
  MandateRevisions,
  NegotiationEngine,
  NegotiationRecord,
  SqliteLibraryBackend,
  SqliteRecordBackend,
} from "@kritva/core";
import { createApp } from "../src/app.ts";
import { loadConfirmedMandates, loadExamples, loadGuidance, loadListings } from "../src/main-helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const speech = createSpeechFromEnv();
if (!speech) throw new Error("OPENAI_API_KEY is not set.");
const db = join(mkdtempSync(join(tmpdir(), "kritva-voice-check-")), "db.sqlite");
const record = new NegotiationRecord(new SqliteRecordBackend(db));
const mappingLlm = createMappingLlmFromEnv();
const library = new MandateLibrary({ backend: new SqliteLibraryBackend(db), mappingLlm });
const mandates = loadConfirmedMandates(join(ROOT, "cases"));
const examples = loadExamples(join(ROOT, "cases"));
const listings = loadListings(join(ROOT, "cases"), mandates, examples, library);
const subjectFacts = new Map(listings.flatMap((listing) => listing.subjectFactId ? [[listing.caseId, listing.subjectFactId] as const] : []));
const engine = new NegotiationEngine({ record, llm: createTurnLlmFromEnv(), locale: "en-IN", guidance: loadGuidance(ROOT, "bed-sale"), subjectFacts });
const app = createApp({ record, engine, revisions: new MandateRevisions({ record, engine, mappingLlm }), mandates, locale: "en-IN", library, examples, speech, listings });

async function audioOf(text: string): Promise<Uint8Array> {
  const out = await speech!.speak(text);
  return new Uint8Array(await new Response(out.body).arrayBuffer());
}

/** Time to the first byte of Kritva's reply audio, then the whole download. */
async function speechTiming(sessionId: string, messageId: string) {
  const started = performance.now();
  const res = await app.request(`/api/buyer/sessions/${sessionId}/voice/speech/${messageId}`);
  const reader = res.body!.getReader();
  const first = await reader.read();
  const firstByteMs = Math.round(performance.now() - started);
  let bytes = first.value?.byteLength ?? 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) bytes += r.value.byteLength;
  return { firstByteMs, totalMs: Math.round(performance.now() - started), bytes };
}

const conversations = [
  ["Hi, is the bed still available?", "I can pay seventeen thousand rupees.", "Pickup will cost me another two thousand, so that's my budget.", "Okay, how about eighteen thousand five hundred?", "Yes, that works. I confirm."],
  ["Hello. What's her lowest price for the bed?", "Eighteen thousand... no, nineteen thousand.", "Can you deliver it to Whitefield?", "Fine, I'll pick it up. Nineteen thousand then.", "Yes, I confirm those terms."],
  ["I do not want to speak to an AI."],
];

interface Row {
  conversation: number;
  turn: number;
  said: string;
  heard: string;
  reply: string;
  transcribeMs: number;
  coreMs: number;
  serverMs: number;
  speechFirstByteMs: number | null;
  toFirstAudioMs: number | null;
}
const rows: Row[] = [];

for (let c = 0; c < conversations.length; c += 1) {
  const call = await app.request("/api/public/listings/bed-sale/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientCallId: `voice-check-${c}-${Date.now()}` }) });
  const { sessionId } = (await call.json()) as { sessionId: string };
  const greet = (await (await app.request(`/api/buyer/sessions/${sessionId}/voice/start`, { method: "POST" })).json()) as { reply: { messageId: string; text: string } | null };
  if (greet.reply) await app.request(`/api/buyer/sessions/${sessionId}/deliveries`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: greet.reply.messageId, channel: "voice", status: "delivered" }) });
  for (let t = 0; t < conversations[c]!.length; t += 1) {
    const said = conversations[c]![t]!;
    const audio = await audioOf(said);
    const started = performance.now();
    const res = await app.request(`/api/buyer/sessions/${sessionId}/voice/utterances?clientMessageId=voice-check-${c}-${t}-${Date.now()}`, { method: "POST", headers: { "content-type": "audio/mpeg" }, body: audio });
    const body = (await res.json()) as { transcript?: string; reply?: { messageId: string; text: string } | null; timings?: { transcribeMs: number; turnMs: number; serverMs: number }; message?: string };
    const serverMs = Math.round(performance.now() - started);
    let speechFirstByteMs: number | null = null;
    if (body.reply) {
      const s = await speechTiming(sessionId, body.reply.messageId);
      speechFirstByteMs = s.firstByteMs;
      await app.request(`/api/buyer/sessions/${sessionId}/deliveries`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: body.reply.messageId, channel: "voice", status: "delivered", audioStartMs: serverMs + s.firstByteMs }) });
    }
    rows.push({
      conversation: c + 1,
      turn: t + 1,
      said,
      heard: body.transcript ?? `(failed: ${body.message ?? res.status})`,
      reply: body.reply?.text ?? "(no reply)",
      transcribeMs: body.timings?.transcribeMs ?? 0,
      coreMs: body.timings?.turnMs ?? 0,
      serverMs,
      speechFirstByteMs,
      toFirstAudioMs: speechFirstByteMs === null ? null : serverMs + speechFirstByteMs,
    });
    console.log(`${c + 1}.${t + 1} ${serverMs}ms + ${speechFirstByteMs ?? "-"}ms | heard: ${body.transcript} | ${body.reply?.text ?? body.message}`);
    const outcome = (await (await app.request(`/api/buyer/sessions/${sessionId}`)).json()) as { outcome: { kind: string } };
    if (outcome.outcome.kind === "pending_approval") {
      const op = (await (await app.request(`/api/operator/sessions/${sessionId}`)).json()) as { state: { pendingApproval: { requestId: string; offerId: string; mandateRevision: number } } };
      const p = op.state.pendingApproval;
      const approved = (await (await app.request(`/api/operator/sessions/${sessionId}/approvals/${p.requestId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved", offerId: p.offerId, mandateRevision: p.mandateRevision }) })).json()) as { reply?: { text: string } };
      console.log(`   seller approved → ${approved.reply?.text}`);
      rows.push({ conversation: c + 1, turn: t + 1.5, said: "(seller approves in the console)", heard: "", reply: approved.reply?.text ?? "", transcribeMs: 0, coreMs: 0, serverMs: 0, speechFirstByteMs: null, toFirstAudioMs: null });
    }
    if (outcome.outcome.kind === "agreement" || outcome.outcome.kind === "no_agreement") break;
  }
}

const measured = rows.filter((r) => r.toFirstAudioMs !== null).map((r) => r.toFirstAudioMs!);
const sorted = [...measured].sort((a, b) => a - b);
const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
const pct = (xs: number[], f: (r: Row) => number) => {
  const s = rows.filter((r) => r.toFirstAudioMs !== null).map(f).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const out = [
  `# Epic 13 voice timing (model-composed wording)`,
  "",
  `- Run at: ${new Date().toISOString()}`,
  "- Path: synthesized buyer speech → POST /voice/utterances (transcription + the text negotiation core + outgoing checks) → GET /voice/speech (Kritva's audio, streamed). Same routes the browser uses, run in-process; network time to and from a browser is not included.",
  `- Turns measured: ${measured.length}. Time from the end of the buyer's speech to the first byte of Kritva's audio: median ${(median / 1000).toFixed(1)}s, slowest ${((sorted.at(-1) ?? 0) / 1000).toFixed(1)}s. Target: about 1.5s.`,
  `- Median parts: transcription ${(pct(measured, (r) => r.transcribeMs) / 1000).toFixed(1)}s, negotiation core ${(pct(measured, (r) => r.coreMs) / 1000).toFixed(1)}s, speech first byte ${(pct(measured, (r) => r.speechFirstByteMs ?? 0) / 1000).toFixed(1)}s.`,
  "",
  "| # | Buyer said | Transcribed | Kritva replied | Transcribe | Core | To first audio |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.conversation}.${r.turn} | ${r.said} | ${r.heard} | ${r.reply.replace(/\|/g, "\\|")} | ${r.transcribeMs ? `${(r.transcribeMs / 1000).toFixed(1)}s` : ""} | ${r.coreMs ? `${(r.coreMs / 1000).toFixed(1)}s` : ""} | ${r.toFirstAudioMs !== null ? `${(r.toFirstAudioMs / 1000).toFixed(1)}s` : ""} |`),
  "",
];
mkdirSync(join(ROOT, "test-results/epic-12-14"), { recursive: true });
writeFileSync(join(ROOT, `test-results/epic-12-14/voice-timing-composed.md`), out.join("\n"));
console.log(out.slice(0, 6).join("\n"));
process.exit(0);
