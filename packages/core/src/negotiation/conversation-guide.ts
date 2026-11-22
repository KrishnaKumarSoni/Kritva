/**
 * The conversation guide (conversation-guide.md): plain-text instructions for how Kritva talks. It is
 * read as written and placed in the writer's instructions. Limits are enforced in code, not here.
 */
import { readFileSync } from "node:fs";

export const CONVERSATION_GUIDE = readFileSync(new URL("./conversation-guide.md", import.meta.url), "utf8").trim();
