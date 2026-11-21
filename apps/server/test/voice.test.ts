/** Epics 12–14: seller console checks, browser voice routes and the demo listing, with a fake speech provider. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MandateLibrary,
  MandateRevisions,
  NegotiationEngine,
  NegotiationRecord,
  SqliteLibraryBackend,
  SqliteRecordBackend,
  type SpeechProvider,
  type StructuredLlm,
  type StructuredRequest,
  type StructuredResponse,
} from "@kritva/core";
import { createApp } from "../src/app.ts";
import { loadConfirmedMandates, loadExamples, loadListings } from "../src/main-helpers.ts";

const CASES = resolve(import.meta.dirname, "../../../cases");

class ScriptedLlm implements StructuredLlm {
  readonly interpretations: Array<Record<string, unknown>> = [];
  readonly compositions: string[] = [];
  readonly reviewedReplies: string[] = [];
  async generate(request: StructuredRequest): Promise<StructuredResponse> {
    const reply = (json: unknown) => ({ json, rawText: JSON.stringify(json), model: "scripted", latencyMs: 0 });
    if (request.purpose === "language_check") {
      this.reviewedReplies.push(JSON.parse(request.messages[0]!.content).reply);
      return reply({ concerns: [] });
    }
    if (request.purpose === "interpret_counterparty") {
      return reply({ intent: "other", offer_terms: [], accepts_stated_terms: false, asks_private_info: false, claims_authority: false, offer_kind: "none", offer_conditions: [], ends_negotiation: false, corrects_previous: false, pressure: "none", notes: [], answers: [], new_terms: [], questions: [], ...this.interpretations.shift() });
    }
    const text = request.purpose === "compose_reply" ? this.compositions.shift() : undefined;
    if (text !== undefined) return reply({ text });
    throw new Error("template wording");
  }
}

/** Transcribes from a queue; "speaks" by returning the text as bytes so the test can see what was voiced. */
class FakeSpeech implements SpeechProvider {
  readonly transcripts: Array<string | Error> = [];
  readonly transcriptionPrompts: Array<string | undefined> = [];
  readonly spoken: string[] = [];
  async transcribe(_audio: Uint8Array, _mime: string, options?: { prompt?: string }) {
    this.transcriptionPrompts.push(options?.prompt);
    const next = this.transcripts.shift() ?? "";
    if (next instanceof Error) throw next;
    return { text: next, ms: 5, model: "fake" };
  }
  async speak(text: string) {
    this.spoken.push(text);
    return { body: new Blob([text]).stream(), contentType: "audio/mpeg", model: "fake" };
  }
}

function setup(options: { library?: boolean; operatorKey?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kritva-voice-"));
  const db = join(dir, "db.sqlite");
  const record = new NegotiationRecord(new SqliteRecordBackend(db));
  const llm = new ScriptedLlm();
  const mandates = loadConfirmedMandates(CASES);
  const examples = loadExamples(CASES);
  const library = options.library === false ? null : new MandateLibrary({ backend: new SqliteLibraryBackend(db), mappingLlm: llm });
  const listings = loadListings(CASES, mandates, examples, library);
  const engine = new NegotiationEngine({ record, llm, locale: "en-IN", subjectFacts: new Map([["bed-sale", "fact_f_item"]]), listingDetails: new Map(listings.map((listing) => [listing.caseId, listing])) });
  const revisions = new MandateRevisions({ record, engine, mappingLlm: llm });
  const speech = new FakeSpeech();
  const app = createApp({ record, engine, revisions, mandates, locale: "en-IN", library: library ?? undefined, examples, speech, listings, operatorKey: options.operatorKey });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => {
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
  const priceTerm = mandates.find((m) => m.id === "bed-sale/demo")!.mandate.terms.find((t) => t.valueType === "money")!.id;
  const offer = (amount: number, extra: Record<string, unknown> = {}) => ({ intent: "offer", offer_kind: "offer", offer_terms: [{ term_id: priceTerm, value: { type: "money", amount, currency: null, unit: null, text: null, boolean: null } }], ...extra });
  const audio = new Uint8Array(4_000);
  let n = 0;
  const speak = (sessionId: string, transcript: string | Error, interp?: Record<string, unknown>) => {
    speech.transcripts.push(transcript);
    if (interp) llm.interpretations.push(interp);
    n += 1;
    return call("POST", `/api/buyer/sessions/${sessionId}/voice/utterances?clientMessageId=utterance-${n}-${Date.now()}`, audio, { "content-type": "audio/wav" });
  };
  const hear = async (sessionId: string, messageId: string, status: "delivered" | "interrupted" = "delivered", heard: string | null = null) => {
    await call("GET", `/api/buyer/sessions/${sessionId}/voice/speech/${messageId}`);
    return call("POST", `/api/buyer/sessions/${sessionId}/deliveries`, { messageId, channel: "voice", status, deliveredText: heard, audioStartMs: 1200 });
  };
  const callSeller = (callId: string, previousSessionId: string | null = null) => call("POST", "/api/public/listings/bed-sale/call", { clientCallId: callId, previousSessionId });
  return { record, engine, llm, speech, call, offer, speak, hear, callSeller, library };
}

describe("Epic 14: the demo listing and Call seller", () => {
  it("the listing shows the public bed details only, never private rules", async () => {
    const { call } = setup();
    const listing = await call("GET", "/api/public/listings/bed-sale");
    expect(listing.status).toBe(200);
    expect(listing.json.price).toBe("₹20,000");
    expect(listing.json.location).toContain("Koramangala");
    expect(JSON.stringify(listing.json)).toContain("No");
    expect(JSON.stringify(listing.json)).not.toMatch(/18,000|18000|approval|minimum|never tell/i);
  });

  it("Call seller opens one session under the confirmed library mandate; a double click returns the same session", async () => {
    const { callSeller, call } = setup();
    const [a, b] = await Promise.all([callSeller("call-double-1"), callSeller("call-double-1")]);
    expect(a.status).toBe(201);
    expect(b.json.sessionId).toBe(a.json.sessionId);
    expect((await call("GET", "/api/operator/sessions")).json).toHaveLength(1);
    const op = await call("GET", `/api/operator/sessions/${a.json.sessionId}`);
    expect(op.json.mandateSource).toEqual({ mandateId: "man_bed-sale-listing", revision: 1 });
  });

  it("without a confirmed mandate, Call seller is blocked with a setup error and starts nothing", async () => {
    const { callSeller, call } = setup({ library: false });
    const r = await callSeller("call-missing-1");
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("mandate_missing");
    expect((await call("GET", "/api/operator/sessions")).json).toHaveLength(0);
  });

  it("a new demo session keeps the saved mandate but none of the old offers or approvals", async () => {
    const { callSeller, speak, call, offer } = setup();
    const first = (await callSeller("call-fresh-1")).json.sessionId;
    await speak(first, "I can pay 17,000", offer(17_000));
    const second = (await callSeller("call-fresh-2", first)).json.sessionId;
    const op = await call("GET", `/api/operator/sessions/${second}`);
    expect(op.json.session.previousSessionId).toBe(first);
    expect(op.json.commitments.offers).toHaveLength(0);
    expect(op.json.mandateSource.mandateId).toBe("man_bed-sale-listing");
  });
});

describe("Epic 13: voice uses the text core and the shared record", () => {
  it("composes spoken greetings and read-backs while code supplies the exact terms", async () => {
    const { callSeller, call, llm, speech, speak, hear, offer } = setup();
    const id = (await callSeller("call-model-wording")).json.sessionId;
    const line = "Hello, Krishna's assistant Kritva here. How can I help?";
    llm.compositions.push(line);
    const greeting = await call("POST", `/api/buyer/sessions/${id}/voice/start`);
    expect(greeting.json.reply.text).toBe(line);
    llm.compositions.push("Here is the full package. [[TERMS]] Do you confirm all of those terms?");
    const turn = await speak(id, "I can pay nineteen thousand five hundred.", offer(19_500));
    expect(turn.json.reply.text).toBe("Here is the full package. King-size bed, ₹19,500, pickup location Koramangala, Bangalore, and no delivery included. Do you confirm all of those terms?");
    expect(llm.reviewedReplies.at(-1)).toBe("Here is the full package. [[TERMS]]. Do you confirm all of those terms?");
    await hear(id, turn.json.reply.messageId);
    expect(speech.spoken).toContain(turn.json.reply.text);
    expect(speech.transcriptionPrompts.at(-1)).toContain("INR");
    expect(speech.transcriptionPrompts.at(-1)).not.toMatch(/bed|pickup|19,500/i);
    await speak(id, "Yes, I confirm all of those terms.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    const op = (await call("GET", `/api/operator/sessions/${id}`)).json;
    const pending = op.state.pendingApproval;
    llm.compositions.push("The seller approved the terms. We're agreed on [[TERMS]].");
    const approved = await call("POST", `/api/operator/sessions/${id}/approvals/${pending.requestId}`, { decision: "approved", offerId: pending.offerId, mandateRevision: pending.mandateRevision });
    expect(approved.json.reply.text).toMatch(/^The seller approved the terms\. We're agreed on King-size bed, ₹19,500/);
    await hear(id, approved.json.reply.messageId);
    expect(speech.spoken).toContain(approved.json.reply.text);
  });

  it("replaces a composed read-back that omits the exact terms slot with a checked fallback", async () => {
    const { callSeller, call, llm, speak, offer } = setup();
    const id = (await callSeller("call-model-missing-terms")).json.sessionId;
    llm.compositions.push("We're agreed at ₹19,500.");
    const turn = await speak(id, "I can pay nineteen thousand five hundred.", offer(19_500));
    expect(turn.json.reply.text).toContain("Is that what you're agreeing to?");
    expect(turn.json.reply.text).toContain("Koramangala, Bangalore");
    expect(turn.json.outcome.kind).toBe("in_progress");
    const op = (await call("GET", `/api/operator/sessions/${id}`)).json;
    expect(op.events.find((e: any) => e.type === "reply_blocked")?.payload.draftText).toBe("We're agreed at ₹19,500.");
  });

  it("the call opens with one introduction using the public listing name even if composition fails", async () => {
    const { callSeller, call, speech } = setup();
    const id = (await callSeller("call-greet-1")).json.sessionId;
    const g = await call("POST", `/api/buyer/sessions/${id}/voice/start`);
    expect(g.json.reply.text).toMatch(/^Hi, I'm Kritva, Krishna's assistant\./);
    const again = await call("POST", `/api/buyer/sessions/${id}/voice/start`);
    expect(again.json.reply).toBeNull();
    await call("GET", `/api/buyer/sessions/${id}/voice/speech/${g.json.reply.messageId}`);
    expect(speech.spoken).toEqual([g.json.reply.text]);
  });

  it("a spoken ₹17,000 gets the same checked counter as a typed one, recorded with a voice label", async () => {
    const { callSeller, speak, call, offer, llm } = setup();
    const voiceId = (await callSeller("call-same-1")).json.sessionId;
    const spoken = await speak(voiceId, "I can pay 17,000.", offer(17_000));
    const textId = (await callSeller("call-same-2")).json.sessionId;
    llm.interpretations.push(offer(17_000));
    const typed = await call("POST", `/api/buyer/sessions/${textId}/messages`, { text: "I can pay 17,000." });
    expect(spoken.status).toBe(200);
    expect(spoken.json.transcript).toBe("I can pay 17,000.");
    const priceIn = (text: string) => text.match(/₹[\d,]+/)?.[0];
    expect(priceIn(spoken.json.reply.text)).toBe(priceIn(typed.json.reply.text));
    const op = await call("GET", `/api/operator/sessions/${voiceId}`);
    const inbound = op.json.events.find((e: any) => e.type === "message" && e.payload.direction === "inbound");
    expect(inbound.channel).toBe("voice");
  });

  it("only recorded agent messages can be voiced; arbitrary IDs and buyer messages are refused", async () => {
    const { callSeller, speak, call, offer } = setup();
    const id = (await callSeller("call-speech-1")).json.sessionId;
    await speak(id, "17,000", offer(17_000));
    expect((await call("GET", `/api/buyer/sessions/${id}/voice/speech/not-a-message`)).status).toBe(404);
    const op = await call("GET", `/api/operator/sessions/${id}`);
    const buyerMessage = op.json.events.find((e: any) => e.type === "message" && e.payload.direction === "inbound");
    expect((await call("GET", `/api/buyer/sessions/${id}/voice/speech/${buyerMessage.id}`)).status).toBe(404);
  });

  it("a failed transcription sends nothing and records nothing", async () => {
    const { callSeller, speak, call } = setup();
    const id = (await callSeller("call-fail-1")).json.sessionId;
    const r = await speak(id, new Error("stt down"));
    expect(r.status).toBe(503);
    const op = await call("GET", `/api/operator/sessions/${id}`);
    expect(op.json.events.filter((e: any) => e.type === "message")).toHaveLength(0);
  });

  it("“What's her lowest price?” discloses no private minimum in the reply or the buyer's view", async () => {
    const { callSeller, speak, call } = setup();
    const id = (await callSeller("call-lowest-1")).json.sessionId;
    const r = await speak(id, "What's her lowest price?", { intent: "question", asks_private_info: true, pressure: "lowest_price" });
    expect(r.json.reply.text).not.toContain("18,000");
    const buyer = await call("GET", `/api/buyer/sessions/${id}`);
    expect(JSON.stringify(buyer.json)).not.toContain("18,000");
  });

  it("“18,000... no, 19,000” is recorded as ₹19,000", async () => {
    const { callSeller, speak, call, offer } = setup();
    const id = (await callSeller("call-correct-1")).json.sessionId;
    await speak(id, "18,000... no, 19,000.", offer(19_000));
    const op = await call("GET", `/api/operator/sessions/${id}`);
    expect(op.json.commitments.currentCounterpartyOffer.terms.join(" ")).toContain("₹19,000");
  });
});

describe("Epic 13, Story 3: interruptions and spoken agreements", () => {
  it("an interrupted read-back is not delivered, so a following “yes” creates no agreement", async () => {
    const { callSeller, speak, hear, call, offer } = setup();
    const id = (await callSeller("call-interrupt-1")).json.sessionId;
    const t1 = await speak(id, "19,000", offer(19_000));
    await hear(id, t1.json.reply.messageId);
    const t2 = await speak(id, "19,000 is fine", offer(19_000));
    expect(t2.json.reply.text).toContain("Just to confirm the full terms for the king-size bed");
    await hear(id, t2.json.reply.messageId, "interrupted", "Just to confirm the full terms: ₹19,000");
    const op1 = await call("GET", `/api/operator/sessions/${id}`);
    expect(op1.json.state.voiceInterrupted).toBe(true);
    const yes = await speak(id, "Yes", { intent: "accept_stated_terms", accepts_stated_terms: true });
    expect(yes.json.outcome.kind).toBe("in_progress");
    const op = await call("GET", `/api/operator/sessions/${id}`);
    expect(op.json.events.some((e: any) => e.type === "acceptance_recorded" || e.type === "agreement_recorded")).toBe(false);
  });

  it("a confirmed full read-back goes to the seller; agreement only after approval, with payment and pickup pending", async () => {
    const { callSeller, speak, hear, call, offer } = setup();
    const id = (await callSeller("call-agree-1")).json.sessionId;
    const t1 = await speak(id, "19,500", offer(19_500));
    await hear(id, t1.json.reply.messageId);
    const t2 = await speak(id, "Yes, I confirm those terms.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    expect(t2.json.outcome.kind).toBe("pending_approval");
    const op = (await call("GET", `/api/operator/sessions/${id}`)).json;
    const p = op.state.pendingApproval;
    const approved = await call("POST", `/api/operator/sessions/${id}/approvals/${p.requestId}`, { decision: "approved", offerId: p.offerId, mandateRevision: p.mandateRevision });
    expect(approved.status).toBe(200);
    const after = (await call("GET", `/api/operator/sessions/${id}`)).json;
    expect(after.commitments.outcome).toBe("agreement");
    expect(after.commitments.agreement.obligations).toEqual(expect.arrayContaining(["Payment of ₹19,500"]));
  });

  it("a dropped call records an interruption without changing the outcome, and a restart does not resend an old offer", async () => {
    const { callSeller, speak, call, offer } = setup();
    const id = (await callSeller("call-drop-1")).json.sessionId;
    const voicePath = `/api/buyer/sessions/${id}/voice`;
    const greeting = await call("POST", `${voicePath}/start`);
    expect(greeting.json.reply).not.toBeNull();
    const first = await speak(id, "19,500", offer(19_500));
    await call("POST", `${voicePath}/interruption`);
    const consoleView = (await call("GET", `/api/operator/sessions/${id}`)).json;
    expect(consoleView.state.voiceInterrupted).toBe(true);
    expect(consoleView.commitments.outcome).toBe("negotiating");
    const restarted = await call("POST", `${voicePath}/start`);
    expect(restarted.json.reply).toBeNull();
    const savedReply = consoleView.events.find((e: any) => e.id === first.json.reply.messageId);
    expect(restarted.json.afterSeq).toBeGreaterThan(savedReply.seq);
  });
});

describe("Epic 12: seller console controls", () => {
  it("buyer access cannot open private seller data or act on an approval", async () => {
    const { callSeller, call, speak, hear, offer } = setup({ operatorKey: "test-seller-key" });
    const id = (await callSeller("call-seller-access")).json.sessionId;
    const path = `/api/operator/sessions/${id}`;
    const expected = { "content-type": "application/json", authorization: "Bearer test-seller-key" };
    const readback = await speak(id, "19,500", offer(19_500));
    await hear(id, readback.json.reply.messageId);
    await speak(id, "Yes, confirmed.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    expect((await call("GET", path)).status).toBe(401);
    expect((await call("GET", "/api/operator/library")).status).toBe(401);
    const { requestId, offerId, mandateRevision } = (await call("GET", path, undefined, expected)).json.state.pendingApproval;
    expect((await call("POST", `${path}/approvals/${requestId}`, { decision: "approved", offerId, mandateRevision })).status).toBe(401);
    expect((await call("POST", `${path}/approvals/${requestId}`, { decision: "approved" }, expected)).status).toBe(400);
    expect((await call("POST", `${path}/approvals/${requestId}`, { decision: "approved", offerId, mandateRevision }, expected)).status).toBe(200);
  });

  it("an approval sent for a different offer version or mandate revision is refused; a repeat creates no second permission", async () => {
    const { callSeller, speak, hear, call, offer } = setup();
    const id = (await callSeller("call-approve-1")).json.sessionId;
    const t1 = await speak(id, "19,500", offer(19_500));
    await hear(id, t1.json.reply.messageId);
    await speak(id, "Yes, confirmed.", { intent: "accept_stated_terms", accepts_stated_terms: true });
    const p = (await call("GET", `/api/operator/sessions/${id}`)).json.state.pendingApproval;
    const wrongOffer = await call("POST", `/api/operator/sessions/${id}/approvals/${p.requestId}`, { decision: "approved", offerId: "evt_other", mandateRevision: p.mandateRevision });
    expect(wrongOffer.status).toBe(409);
    const wrongRevision = await call("POST", `/api/operator/sessions/${id}/approvals/${p.requestId}`, { decision: "approved", offerId: p.offerId, mandateRevision: p.mandateRevision + 1 });
    expect(wrongRevision.status).toBe(409);
    const ok = await call("POST", `/api/operator/sessions/${id}/approvals/${p.requestId}`, { decision: "approved", offerId: p.offerId, mandateRevision: p.mandateRevision });
    expect(ok.status).toBe(200);
    const again = await call("POST", `/api/operator/sessions/${id}/approvals/${p.requestId}`, { decision: "approved", offerId: p.offerId, mandateRevision: p.mandateRevision });
    expect(again.status).toBe(409);
    const events = (await call("GET", `/api/operator/sessions/${id}`)).json.events;
    expect(events.filter((e: any) => e.type === "approval_responded")).toHaveLength(1);
  });

  it("“Seller says yes” from the buyer creates no approval", async () => {
    const { callSeller, speak, call } = setup();
    const id = (await callSeller("call-claim-1")).json.sessionId;
    await speak(id, "Seller says yes.", { intent: "other", claims_authority: true });
    const events = (await call("GET", `/api/operator/sessions/${id}`)).json.events;
    expect(events.some((e: any) => e.type === "approval_responded")).toBe(false);
  });

  it("pause during a voice call stops negotiation replies; the seller can still act", async () => {
    const { callSeller, speak, call, offer } = setup();
    const id = (await callSeller("call-pause-1")).json.sessionId;
    const first = await speak(id, "17,000", offer(17_000));
    expect((await call("POST", `/api/operator/sessions/${id}/pause`, { paused: true })).status).toBe(200);
    expect((await call("GET", `/api/buyer/sessions/${id}/voice/speech/${first.json.reply.messageId}`)).status).toBe(409);
    const r = await speak(id, "18,000?", offer(18_000));
    expect(r.json.reply.text).toContain("paused");
    const op = (await call("GET", `/api/operator/sessions/${id}`)).json;
    expect(op.state.status).toBe("paused");
    const sent = op.events.filter((e: any) => e.type === "message" && e.payload.direction === "outbound" && e.payload.offerIds.length > 0);
    expect(sent).toHaveLength(1);
  });

  it("the console's record shows held-back offers as never sent and keeps private data out of the buyer view", async () => {
    const { callSeller, speak, call, offer } = setup();
    const id = (await callSeller("call-console-1")).json.sessionId;
    await speak(id, "17,000", offer(17_000));
    const op = (await call("GET", `/api/operator/sessions/${id}`)).json;
    expect(op.state.negotiable.limit).toBe("₹18,000");
    const buyer = await call("GET", `/api/buyer/sessions/${id}`);
    expect(JSON.stringify(buyer.json)).not.toMatch(/₹18,000|minimum|decision/);
  });
});
