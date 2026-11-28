/**
 * The conversation guide (conversation-guide.md): plain-text instructions for how Kritva talks. It is
 * read as written and placed in the writer's instructions. Limits are enforced in code, not here.
 */
import { readFileSync } from "node:fs";
import { textFile } from "../text-files.ts";

export const CONVERSATION_GUIDE = textFile("conversation-guide.md", () => readFileSync(new URL("./conversation-guide.md", import.meta.url), "utf8")).trim();

/** One "## " section of the guide, without its heading. */
export function guideSection(title: string): string {
  const section = CONVERSATION_GUIDE.split(/^## /m).find((part) => part.startsWith(`${title}\n`));
  if (!section) throw new Error(`The conversation guide has no section "${title}".`);
  return section.slice(title.length + 1).trim();
}

/**
 * "How Kritva sounds": the tone, the same in a chat and on a call. The voice model reads it too, for the
 * turns it answers itself (greetings, small talk, "are you a bot?"), so both sound like one person.
 */
export const CONVERSATION_TONE = guideSection("How Kritva sounds");

/** "Mistakes to avoid": what went wrong on real calls and chats, each with what to say instead. Read by the writer and the voice model alike. */
export const CONVERSATION_MISTAKES = guideSection("Mistakes to avoid");

/** The guide's "Default language: <name>." line: the language Kritva speaks before the other party has spoken. Set in the guide, never in code. */
export const DEFAULT_LANGUAGE = /^- Default language: ([^.\n]+)\./m.exec(CONVERSATION_GUIDE)?.[1]?.trim() ?? null;
