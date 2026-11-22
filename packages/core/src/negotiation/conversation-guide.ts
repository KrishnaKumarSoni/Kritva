/**
 * The conversation guide (conversation-guide.md): plain-text instructions for how Kritva talks. It is
 * read as written and placed in the writer's instructions. Limits are enforced in code, not here.
 */
import { readFileSync } from "node:fs";

export const CONVERSATION_GUIDE = readFileSync(new URL("./conversation-guide.md", import.meta.url), "utf8").trim();

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
