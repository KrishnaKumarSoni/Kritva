/**
 * Intake conversations: the chat in which the principal describes a negotiation and the intake
 * agent fills the mandate input. A conversation is working state, not authority: nothing in it is
 * used by a negotiation until the principal makes the mapped draft live.
 */
import { DatabaseSync } from "node:sqlite";
import type { LibraryInput } from "../mandate/library.ts";

/** What the intake agent has gathered, item by item. */
export const CHECKLIST_ITEMS = [
  { id: "subject", label: "What it's about", required: true },
  { id: "specifics", label: "What they'll ask about", required: true },
  { id: "roles", label: "Who you're dealing with", required: true },
  { id: "opening", label: "Your asking terms", required: true },
  { id: "logistics", label: "Where and when", required: true },
  { id: "limit", label: "How far you'll go", required: true },
  { id: "authority", label: "When to check with you", required: true },
] as const;

export type ChecklistId = (typeof CHECKLIST_ITEMS)[number]["id"];
/** known: the person said it or it was in what they shared; assumed: a safe default the agent chose and told them about. */
export type ChecklistStatus = "known" | "assumed" | "missing";
export type Checklist = Record<ChecklistId, ChecklistStatus>;

export const EMPTY_CHECKLIST: Checklist = Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i.id, "missing"])) as Checklist;
export const EMPTY_FIELDS: LibraryInput = { title: "", principalRole: "", counterpartyRole: "", principalSide: null, publicText: "", privateText: "" };

/** A mapped draft offered to the principal in the chat, with the open notes they accept by making it live. */
export interface ReadyCard {
  kind: "ready";
  mandateId: string;
  versionId: string;
  draftHash: string;
  /** Non-blocking issues shown on the card. Making the draft live acknowledges exactly these. */
  notes: Array<{ id: string; message: string }>;
  /** "new" for a first revision, "update" for a change to a mandate that already has one. */
  mode: "new" | "update";
}

export interface LiveCard {
  kind: "live";
  mandateId: string;
  revision: number;
}

export interface IntakeMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Images the person shared, as data URLs. */
  images: string[];
  at: string;
  card: ReadyCard | LiveCard | null;
}

export interface IntakeConversation {
  id: string;
  /** Set once the input has been mapped into a saved mandate (or when the chat opened on one). */
  mandateId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: IntakeMessage[];
  fields: LibraryInput;
  checklist: Checklist;
  /** The agent said everything needed is gathered; the next step is mapping it into a draft. */
  readyToPrepare: boolean;
  /** The fields as last mapped, so an unchanged input is not mapped twice. */
  preparedFields: LibraryInput | null;
}

export interface IntakeStore {
  get(id: string): IntakeConversation | null;
  forMandate(mandateId: string): IntakeConversation | null;
  /** Conversations that have not become a saved mandate yet. */
  unmapped(): IntakeConversation[];
  save(conversation: IntakeConversation): void;
  delete(id: string): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intake_conversations (
  id TEXT PRIMARY KEY, mandate_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS intake_by_mandate ON intake_conversations (mandate_id);
`;

export class SqliteIntakeStore implements IntakeStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#db.exec(SCHEMA);
  }

  get(id: string): IntakeConversation | null {
    const row = this.#db.prepare("SELECT body FROM intake_conversations WHERE id = ?").get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as IntakeConversation) : null;
  }

  forMandate(mandateId: string): IntakeConversation | null {
    const row = this.#db.prepare("SELECT body FROM intake_conversations WHERE mandate_id = ? ORDER BY updated_at DESC LIMIT 1").get(mandateId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as IntakeConversation) : null;
  }

  unmapped(): IntakeConversation[] {
    return (this.#db.prepare("SELECT body FROM intake_conversations WHERE mandate_id IS NULL ORDER BY created_at").all() as Array<{ body: string }>).map((r) => JSON.parse(r.body) as IntakeConversation);
  }

  save(c: IntakeConversation): void {
    this.#db
      .prepare("INSERT INTO intake_conversations (id, mandate_id, created_at, updated_at, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET mandate_id = excluded.mandate_id, updated_at = excluded.updated_at, body = excluded.body")
      .run(c.id, c.mandateId, c.createdAt, c.updatedAt, JSON.stringify(c));
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM intake_conversations WHERE id = ?").run(id);
  }

  close(): void {
    this.#db.close();
  }
}

/** In-memory store for tests and scripts. */
export class MemoryIntakeStore implements IntakeStore {
  readonly #rows = new Map<string, IntakeConversation>();
  get(id: string) {
    const c = this.#rows.get(id);
    return c ? structuredClone(c) : null;
  }
  forMandate(mandateId: string) {
    const all = [...this.#rows.values()].filter((c) => c.mandateId === mandateId).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    return all.length ? structuredClone(all.at(-1)!) : null;
  }
  unmapped() {
    return [...this.#rows.values()].filter((c) => c.mandateId === null).map((c) => structuredClone(c));
  }
  save(c: IntakeConversation) {
    this.#rows.set(c.id, structuredClone(c));
  }
  delete(id: string) {
    this.#rows.delete(id);
  }
}

/**
 * Intake progress, 0 to 1. Gathering the required items fills the bar to 90%; the last 10% is a
 * mapped draft that is ready to go live (or a live mandate).
 */
export function intakeProgress(checklist: Checklist, options: { draftReady: boolean; live: boolean }): number {
  if (options.live || options.draftReady) return 1;
  const required = CHECKLIST_ITEMS.filter((i) => i.required);
  const done = required.filter((i) => checklist[i.id] !== "missing").length;
  return Math.round((done / required.length) * 0.9 * 100) / 100;
}
