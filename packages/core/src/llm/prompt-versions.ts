/**
 * Short content hashes of the turn prompts, so evaluation runs record exactly which prompt text
 * produced them. A changed prompt gives a different version without anyone remembering to bump it.
 */
import { createHash } from "node:crypto";
import { LANGUAGE_CHECK_PROMPT } from "../governance/language-check.ts";
import { MAPPING_PROMPT_VERSION } from "../mapping/prompt.ts";
import { COMPOSE_PROMPT } from "../negotiation/compose.ts";
import { INTERPRET_PROMPT } from "../negotiation/interpret.ts";
import { AGENT_INSTRUCTIONS, READ_MESSAGE_DESCRIPTION, SEND_REPLY_DESCRIPTION } from "../agent/negotiator.ts";

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

export function promptVersions(): Record<string, string> {
  return {
    agent: `agent@${short(AGENT_INSTRUCTIONS + READ_MESSAGE_DESCRIPTION + SEND_REPLY_DESCRIPTION)}`,
    interpret: `interpret@${short(INTERPRET_PROMPT)}`,
    compose: `compose@${short(COMPOSE_PROMPT)}`,
    languageCheck: `language-check@${short(LANGUAGE_CHECK_PROMPT)}`,
    mapping: MAPPING_PROMPT_VERSION,
  };
}
