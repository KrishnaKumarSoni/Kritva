/**
 * Intake: the conversational way to create or change a saved mandate.
 *
 * 1. The principal chats with the intake agent (text and images). The agent fills the mandate
 *    input and a checklist; the checklist drives the progress bar.
 * 2. When the agent says the input is complete, it is mapped into a library draft through the same
 *    mapper, validator and blockers as the library routes. Problems go back to the agent, which asks
 *    the principal about them in plain words.
 * 3. A draft with no blockers is offered in the chat with its open notes. Only the principal's
 *    "make it live" action confirms it, for that exact version and hash, acknowledging exactly the
 *    notes the card showed.
 */
import { randomUUID } from "node:crypto";
import type { ConfirmedMandate } from "../schema/records.ts";
import type { LibraryDetail, LibraryInput, MandateLibrary } from "../mandate/library.ts";
import type { IntakeAgent, IntakeTurnOutput } from "./agent.ts";
import { CHECKLIST_ITEMS, EMPTY_CHECKLIST, EMPTY_FIELDS, type Checklist, type IntakeConversation, type IntakeCounterparty, type IntakeMessage, type IntakeStore, type ReadyCard } from "./store.ts";

export type IntakeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const MAX_IMAGES = 4;
/** Data URL length cap per image (about 6 MB of base64). The web app downscales before sending. */
const MAX_IMAGE_CHARS = 8_000_000;

export const GREETING_NEW = "Hi! What would you like me to negotiate for you? A sentence is plenty, or drop in a screenshot of your listing and I'll take it from there.";

export class IntakeService {
  readonly #store: IntakeStore;
  readonly #agent: IntakeAgent;
  readonly #library: MandateLibrary;
  readonly #now: () => Date;
  readonly #defaultCurrency: string | null;
  /** One mapping per conversation at a time: a repeated request joins the one in flight. */
  readonly #preparing = new Map<string, Promise<IntakeResult<IntakeConversation>>>();

  /** defaultCurrency: what a bare amount means where the principal lives, for example "euros". */
  /** How many counterparties one mandate may list (the deployment's cap, KRITVA_MAX_COUNTERPARTIES). */
  readonly #counterpartyCap: number;
  constructor(options: { store: IntakeStore; agent: IntakeAgent; library: MandateLibrary; defaultCurrency?: string | null; now?: () => Date; counterpartyCap?: number }) {
    this.#counterpartyCap = Math.max(1, Math.floor(options.counterpartyCap ?? 5));
    this.#defaultCurrency = options.defaultCurrency ?? null;
    this.#store = options.store;
    this.#agent = options.agent;
    this.#library = options.library;
    this.#now = options.now ?? (() => new Date());
  }

  get(id: string): IntakeConversation | null {
    return this.#store.get(id);
  }

  /** Conversations that have not become a saved mandate yet and have at least one message from the principal. */
  drafts(): IntakeConversation[] {
    return this.#store.unmapped().filter((c) => c.messages.some((m) => m.role === "user"));
  }

  /** A fresh conversation for a new mandate, opened with a greeting. */
  start(): IntakeConversation {
    const at = this.#now().toISOString();
    const c: IntakeConversation = { id: `itk_${randomUUID()}`, mandateId: null, createdAt: at, updatedAt: at, messages: [message("assistant", GREETING_NEW, at)], fields: { ...EMPTY_FIELDS }, checklist: { ...EMPTY_CHECKLIST }, readyToPrepare: false, preparedFields: null };
    this.#store.save(c);
    return c;
  }

  /**
   * The conversation for a saved mandate. A mandate made before intake existed (or from a case file)
   * gets one seeded with its current wording, so the principal can change it by chatting.
   */
  forMandate(mandateId: string): IntakeResult<IntakeConversation> {
    const detail = this.#library.get(mandateId);
    if (!detail || detail.deleted) return { ok: false, code: "not_found", message: "That mandate does not exist." };
    const existing = this.#store.forMandate(mandateId);
    if (existing) return { ok: true, value: existing };
    const at = this.#now().toISOString();
    const known: Checklist = Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i.id, "known"])) as Checklist;
    const draft = detail.latest?.status === "draft" ? detail.latest : null;
    const card = draft && draft.blockers.length === 0 ? readyCard(detail, detail.active ? "update" : "new") : null;
    const text = detail.state === "draft"
      ? draft && draft.blockers.length > 0
        ? `This one isn't live yet. One thing needs sorting first: ${plain(draft.blockers[0]!)} Tell me how you'd like it, and I'll update it.`
        : "This one isn't live yet. Everything's in place, so you can make it live now, or tell me anything you'd like to change."
      : card
        ? "There are changes here that aren't live yet. Apply them when you're happy, or tell me what to adjust."
        : "Tell me anything you'd like to change, like the price or how far I can go, and I'll update it.";
    const c: IntakeConversation = { id: `itk_${randomUUID()}`, mandateId, createdAt: at, updatedAt: at, messages: [{ ...message("assistant", text, at), card }], fields: { ...detail.input }, checklist: known, readyToPrepare: false, preparedFields: draft ? { ...detail.input } : null };
    this.#store.save(c);
    return { ok: true, value: c };
  }

  /** The principal's message, with any images. A failed agent turn saves nothing, so the message can be sent again. */
  async send(id: string, input: { text: string; images: string[] }, signal?: AbortSignal): Promise<IntakeResult<IntakeConversation>> {
    const c = this.#store.get(id);
    if (!c) return { ok: false, code: "not_found", message: "That conversation does not exist." };
    const text = (input.text ?? "").trim().slice(0, 8_000);
    const images = (input.images ?? []).filter((i) => typeof i === "string");
    if (!text && images.length === 0) return { ok: false, code: "invalid_input", message: "Write a message or add a picture." };
    if (images.length > MAX_IMAGES) return { ok: false, code: "invalid_input", message: `Add up to ${MAX_IMAGES} pictures at a time.` };
    if (images.some((i) => !/^data:image\/(png|jpeg|webp|gif);base64,/.test(i) || i.length > MAX_IMAGE_CHARS)) return { ok: false, code: "invalid_input", message: "Pictures must be PNG, JPEG, WebP or GIF, up to about 6 MB each." };
    const at = this.#now().toISOString();
    const next = structuredClone(c);
    next.messages.push(message("user", text, at, images));
    let out;
    try {
      out = await this.#agent.run({ conversation: next.messages, fields: next.fields, checklist: next.checklist, context: this.#context(next) }, signal);
    } catch {
      return { ok: false, code: "agent_failed", message: "I couldn't reply just now. Your message wasn't saved; send it again." };
    }
    this.#apply(next, out.fields, out.checklist);
    this.#takeCounterparties(next, out.counterparties ?? []);
    next.readyToPrepare = readyAfter(out);
    next.messages.push(message("assistant", out.reply, this.#now().toISOString()));
    next.updatedAt = this.#now().toISOString();
    this.#store.save(next);
    return { ok: true, value: next };
  }

  /**
   * Maps the gathered input into a library draft and lets the agent respond to the result: a ready
   * card when nothing blocks it, or a plain question about what does.
   */
  prepare(id: string, signal?: AbortSignal): Promise<IntakeResult<IntakeConversation>> {
    const running = this.#preparing.get(id);
    if (running) return running;
    const started = this.#prepare(id, signal).finally(() => this.#preparing.delete(id));
    this.#preparing.set(id, started);
    return started;
  }

  async #prepare(id: string, signal?: AbortSignal): Promise<IntakeResult<IntakeConversation>> {
    const c = this.#store.get(id);
    if (!c) return { ok: false, code: "not_found", message: "That conversation does not exist." };
    if (!c.readyToPrepare) return { ok: false, code: "not_ready", message: "There's still something to gather first." };
    const next = structuredClone(c);
    let detail: LibraryDetail | null = next.mandateId ? this.#library.get(next.mandateId) : null;
    const unchanged = detail?.latest?.status === "draft" && next.preparedFields && sameFields(next.preparedFields, next.fields);
    if (!unchanged) {
      const result = next.mandateId ? await this.#library.remap(next.mandateId, next.fields) : await this.#library.create(next.fields);
      if (!result.ok) return { ok: false, code: result.code, message: result.code === "invalid_input" ? `Something's missing: ${result.message}` : "I couldn't put it together just now. Nothing changed; try again in a moment." };
      detail = result.value;
      next.mandateId = detail.mandateId;
      next.preparedFields = { ...next.fields };
      // The people named before the mandate existed join its counterparty list now.
      this.#takeCounterparties(next, []);
      // Link the conversation to its mandate now, so an interrupted turn never maps it into a second one.
      next.updatedAt = this.#now().toISOString();
      this.#store.save(next);
    }
    const latest = detail!.latest!;
    const notes = latest.draft.issues.map((i) => ({ id: i.id, message: i.message }));
    const event = latest.blockers.length > 0
      ? `The brief was mapped, but it can't go live until this is sorted: ${latest.blockers.join(" ")}${notes.length ? ` Also worth checking: ${notes.map((n) => n.message).join(" ")}` : ""} Ask the person about the first problem in plain words, update the brief, and call mark_ready again.`
      : `The brief is mapped and ready to go live${detail!.active ? " as an update to the live mandate" : ""}. ${notes.length ? `The card will show these notes, which the person accepts by making it live: ${notes.map((n) => n.message).join(" ")}` : "There are no open notes."} Write one or two short, warm sentences.`;
    // A ready draft needs no model turn: the card says it all, so the reply is immediate. Problems go
    // back to the agent, which asks about them in plain words.
    let out: IntakeTurnOutput;
    if (latest.blockers.length === 0) {
      out = { reply: detail!.active ? "Here are your changes. Apply them when you're happy, or tell me what to adjust." : "All set! Here's what I'll work with. Make it live when you're happy, or tell me anything you'd like to change.", fields: next.fields, checklist: next.checklist, ready: false };
    } else {
      try {
        out = await this.#agent.run({ conversation: next.messages, fields: next.fields, checklist: next.checklist, context: this.#context(next), event }, signal);
      } catch {
        out = { reply: `One thing needs sorting before this can go live: ${plain(latest.blockers[0]!)}`, fields: next.fields, checklist: next.checklist, ready: false };
      }
    }
    const changed = !sameFields(out.fields, next.fields);
    this.#apply(next, out.fields, out.checklist);
    this.#takeCounterparties(next, out.counterparties ?? []);
    next.readyToPrepare = out.ready;
    const card = latest.blockers.length === 0 && !changed ? readyCard(detail!, detail!.active ? "update" : "new") : null;
    next.messages.push({ ...message("assistant", out.reply, this.#now().toISOString()), card });
    next.updatedAt = this.#now().toISOString();
    this.#store.save(next);
    return { ok: true, value: next };
  }

  /**
   * The principal's "make it live": confirms exactly the draft on the card, acknowledging exactly its
   * notes, and makes a paused or closed mandate live again. The caller applies the new revision to
   * open negotiations.
   */
  goLive(id: string, input: { versionId: string; draftHash: string }): IntakeResult<{ conversation: IntakeConversation; revision: number; mandate: ConfirmedMandate; detail: LibraryDetail }> {
    const c = this.#store.get(id);
    if (!c?.mandateId) return { ok: false, code: "not_found", message: "That conversation does not exist." };
    const card = [...c.messages].reverse().find((m) => m.card?.kind === "ready" && m.card.versionId === input.versionId)?.card as ReadyCard | undefined;
    if (!card || card.draftHash !== input.draftHash) return { ok: false, code: "stale_draft", message: "This version changed. Use the latest one in the chat." };
    const result = this.#library.confirm(c.mandateId, { versionId: card.versionId, draftHash: card.draftHash, acknowledgedIssueIds: card.notes.map((n) => n.id) });
    if (!result.ok) return { ok: false, code: result.code, message: result.code === "stale_draft" || result.code === "changed_draft" ? "This version changed. Use the latest one in the chat." : result.message };
    let detail = result.value.detail;
    if (detail.state === "paused" || detail.state === "closed") {
      const resumed = this.#library.setLifecycle(c.mandateId, detail.state === "paused" ? "resumed" : "reopened");
      if (resumed.ok) detail = resumed.value;
    }
    const next = structuredClone(c);
    const first = result.value.revision === 1;
    next.messages.push({ ...message("assistant", first ? "It's live. I'll negotiate within exactly what you set here, and check with you whenever you asked me to." : `Done, your changes are live as revision ${result.value.revision}. Any negotiation already using this one now follows them too.`, this.#now().toISOString()), card: { kind: "live", mandateId: c.mandateId, revision: result.value.revision } });
    next.readyToPrepare = false;
    next.updatedAt = this.#now().toISOString();
    this.#store.save(next);
    return { ok: true, value: { conversation: next, revision: result.value.revision, mandate: result.value.mandate, detail } };
  }

  /** Removes a conversation that never became a saved mandate. */
  discard(id: string): IntakeResult<null> {
    const c = this.#store.get(id);
    if (!c) return { ok: false, code: "not_found", message: "That conversation does not exist." };
    if (c.mandateId) return { ok: false, code: "has_mandate", message: "Delete the mandate instead." };
    this.#store.delete(id);
    return { ok: true, value: null };
  }

  #apply(c: IntakeConversation, fields: LibraryInput, checklist: Checklist) {
    c.fields = { ...fields };
    c.checklist = { ...checklist };
  }

  #context(c: IntakeConversation): Record<string, unknown> {
    const detail = c.mandateId ? this.#library.get(c.mandateId) : null;
    return {
      mandate: detail ? { state: detail.state, live_revision: detail.active?.revision ?? null, changing_a_live_mandate: Boolean(detail.active) } : "new, nothing saved yet",
      default_currency: this.#defaultCurrency ?? "none: ask which currency if they give a bare amount",
      counterparties_on_list: this.counterpartiesOf(c).map((p) => ({ name: p.name, has_phone: Boolean(p.phone) })),
      counterparty_cap: this.#counterpartyCap,
    };
  }

  /** Who Kritva will contact for this conversation: the mandate's list once it exists, else those named so far. */
  counterpartiesOf(c: IntakeConversation): IntakeCounterparty[] {
    return c.mandateId ? this.#library.counterparties(c.mandateId).map((e) => ({ name: e.name, phone: e.phone ?? null })) : [...(c.pendingCounterparties ?? [])];
  }

  /**
   * People the principal named: onto the mandate's list once the mandate exists (with any held before),
   * otherwise held on the conversation. The same person is never added twice; a number given later
   * fills in one that was missing. The list stops at the cap.
   */
  #takeCounterparties(c: IntakeConversation, named: IntakeCounterparty[]) {
    const digits = (p: string | null) => (p ?? "").replace(/\D/g, "");
    const same = (a: { name: string; phone: string | null }, b: { name: string; phone: string | null }) =>
      a.name.trim().toLowerCase() === b.name.trim().toLowerCase() || (digits(a.phone).length >= 6 && digits(a.phone) === digits(b.phone));
    const incoming = [...(c.mandateId ? (c.pendingCounterparties ?? []) : []), ...named];
    if (!c.mandateId) {
      const held = [...(c.pendingCounterparties ?? [])];
      for (const p of incoming) {
        const known = held.find((h) => same(h, p));
        if (known) known.phone ??= p.phone;
        else if (held.length < this.#counterpartyCap) held.push({ name: p.name, phone: p.phone });
      }
      c.pendingCounterparties = held;
      return;
    }
    for (const p of incoming) {
      const known = this.#library.counterparties(c.mandateId).find((e) => same({ name: e.name, phone: e.phone ?? null }, p));
      if (known) {
        if (!known.phone && p.phone) this.#library.updateCounterparty(c.mandateId, known.id, { name: known.name, phone: p.phone, note: known.note ?? null });
        continue;
      }
      this.#library.addCounterparty(c.mandateId, { name: p.name, phone: p.phone }, this.#counterpartyCap);
    }
    c.pendingCounterparties = [];
  }
}

/**
 * The agent's own "ready", or a complete brief with nothing left to ask: the model sometimes says it
 * is putting things together without calling mark_ready, and the hand-off must not depend on that.
 */
export function readyAfter(out: { ready: boolean; reply: string; fields: LibraryInput; checklist: Checklist }): boolean {
  if (out.ready) return true;
  const complete = CHECKLIST_ITEMS.every((i) => !i.required || out.checklist[i.id] !== "missing") && Boolean(out.fields.title && out.fields.principalRole && out.fields.counterpartyRole && out.fields.publicText);
  return complete && !out.reply.includes("?");
}

function message(role: IntakeMessage["role"], text: string, at: string, images: string[] = []): IntakeMessage {
  return { id: `itm_${randomUUID()}`, role, text, images, at, card: null };
}

function readyCard(detail: LibraryDetail, mode: ReadyCard["mode"]): ReadyCard {
  const latest = detail.latest!;
  return { kind: "ready", mandateId: detail.mandateId, versionId: latest.versionId, draftHash: latest.draftHash, notes: latest.draft.issues.map((i) => ({ id: i.id, message: i.message })), mode };
}

function sameFields(a: LibraryInput, b: LibraryInput): boolean {
  return a.title === b.title && a.principalRole === b.principalRole && a.counterpartyRole === b.counterpartyRole && (a.principalSide ?? null) === (b.principalSide ?? null) && a.publicText === b.publicText && a.privateText === b.privateText;
}

/** Blocker text in a conversational register. */
function plain(blocker: string): string {
  return blocker.replace(/^Resolve the conflict first: /, "").replace(/^Clarify /, "");
}
