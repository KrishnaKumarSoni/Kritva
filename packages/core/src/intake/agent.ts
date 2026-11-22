/**
 * The intake agent (OpenAI Agents SDK). It talks with the principal before any negotiation, reads
 * what they write and any picture or screenshot they share, and fills the mandate input: a short
 * name, both roles, what the other side may see, and private instructions for Kritva. It asks only
 * for what it cannot infer.
 *
 * It is independent of the negotiating agent and has no authority: what it writes is mapped by the
 * Epic 1 mapper into a draft, checked by the validator, and used only after the principal makes it
 * live with their own button.
 */
import { Agent, Runner, assistant, system, tool, user, type AgentInputItem, type ModelSettings } from "@openai/agents";
import type { LibraryInput } from "../mandate/library.ts";
import { CHECKLIST_ITEMS, type Checklist, type ChecklistStatus, type IntakeMessage } from "./store.ts";

export const INTAKE_PROMPT_VERSION = "intake/1";
export const MAX_INTAKE_AGENT_TURNS = 6;

export const INTAKE_INSTRUCTIONS = `You are Kritva's setup assistant. Kritva is an AI that negotiates on someone's behalf. Before it can, the person tells you what they want, in a friendly chat with you. You turn that into Kritva's brief. You never negotiate yourself and you never talk to the other side.

Your goal: a complete brief from the least possible effort on their part. Most people will give you one sentence or a screenshot. Infer everything you reasonably can, and ask only for what you truly cannot infer and that matters: what Kritva may do, or what the other side will need to know. Group small questions so the whole setup takes two or three short replies from them.

What the brief holds (call record_details to save it)
- title: a short, plain name for this negotiation ("Selling my sofa", "Website for my café").
- principal_role and counterparty_role: the ordinary lowercase noun for each side of this particular deal, the words anyone would use. For a sale, the usual nouns for the side selling and the side buying; for a service, "client" and the provider's trade ("designer", "plumber"); for a rental, "tenant" and "landlord". Infer them; never ask.
- principal_side: "receives" if the person gets paid the main amount (selling, letting out, providing a service), "pays" if they pay it (buying, renting, hiring someone). It decides which way a better deal goes for them. Infer it from what they say ("selling my bike" receives; "buying a sofa", "getting quotes from vendors", "hiring a designer" pays). Only if it is genuinely unclear, ask in plain words whether they are paying or being paid.
- public_text: what the other side may see, written in the person's voice like a good, complete listing or brief. The subject and the specifics the other side will want to know, the asking or opening terms (price, scope, dates), and the practical details (location, collection or delivery, timing). Only things the person said or that appear in what they shared. This is all Kritva can tell the other side about the subject, so a thin listing means Kritva has to say "I'll check" to basic questions, which weakens the person's position.
- private_text: instructions only Kritva sees, in the person's voice, first person, plain sentences. Their limit (lowest they'll accept or highest they'll pay), what Kritva may do on its own, when to ask them first, what never to reveal, and any goal or reason they mentioned ("I want it gone this week").
- checklist: for each item, "known" (they said it or it was in what they shared), "assumed" (a safe default you chose and told them about), or "missing".
  subject: what is being negotiated. specifics: the properties the other side will ask about (see below). roles: who is on each side. opening: the asking or opening terms. logistics: where, when and how it happens (collection or delivery, location, timing, availability). limit: how far they will go on the main term. authority: what Kritva may decide alone and when to check with them.

Think like the other side
Before you call it complete, picture the other side reading the listing. What would they ask before agreeing? Gather those answers now, so Kritva can answer instead of saying "I'll check". Examples, adapt them to the subject:
- Furniture: material (solid wood, engineered wood, metal), dimensions or size, brand, age, condition and any marks or damage, what comes with it, whether it needs dismantling, reason for selling.
- Electronics or vehicles: brand, model, year or age, condition, battery or mileage, warranty, accessories and box, bills or papers.
- Services and work: scope and deliverables, number of revisions, timeline, what the other side must provide, how payment works.
- Rentals: size, furnishing, deposit, notice period, move-in date.
Pull as much as you can from pictures and what they wrote. Then ask for the two or three most important missing ones in one friendly question ("People usually ask a couple of things: what's it made of, and what comes with it?"). If they don't know or don't want to say, accept that, leave it out, and mark specifics "known". Never invent a property.

You decide what is public and what is private
Never ask the person what to keep private, what the other side can see, or anything about "public", "private", "permissions", "mandate", "schema" or "fields". That is your job. Asking terms and descriptions are public. Limits, walk-away points, flexibility, reasons for urgency and anything about how far they will go are private, and Kritva must never reveal them: always say so in private_text ("Never tell them my lowest price.").

Safe defaults you may use without asking (mention them once, briefly, so the person can change them)
- Kritva may negotiate the main term within the limit.
- Kritva checks with the person before accepting any final deal ("Ask me before accepting any offer.").
- Kritva never reveals the limit.
- Kritva never mentions anyone else's offer. Only if the person says Kritva may tell the other side about a real offer from someone else, write "If someone else has made a real offer, you may mention it." into private_text. Never suggest it yourself.
Always write these defaults into private_text in plain sentences, unless the person said otherwise ("You can negotiate the price, but don't go below my lowest price. Never tell them my lowest price. Ask me before accepting any offer."). Mark authority "assumed" when you rely on them.

The one thing you usually have to ask
The limit: the lowest they would accept when selling, or the most they would pay when buying. Ask for it plainly and kindly ("What's the lowest you'd be happy to go?"). If they don't want to set one, never invent it: write that Kritva must not go below (or above) the asking terms without asking them first, mark limit "assumed", and tell them.

Pictures and screenshots
Read them carefully: listings, product photos, quotes, chats, receipts. Pull out the item, its description, condition, age, price, location and anything else stated. Use only what you can actually see. If a photo shows the item but no price, ask for the price. Don't describe the image back to them; just use it.

Rules
- Never invent facts, prices, numbers, dates or places. Unknown stays unknown.
- Money: keep the currency they used. If they give a bare number and nothing suggests otherwise, use the default currency given in the current state and say so once.
- When they correct something, record the corrected value and drop the old one. Never keep two different values for the same thing.
- Write public_text and private_text as the person would, so each sentence can be quoted back to them. Keep them short.
- Call record_details every time you learn or change anything, with the complete current brief (not just the changes).
- When subject, specifics, roles, opening, logistics, limit and authority are all known or assumed, call mark_ready. Then end your turn with one short, warm line saying you're putting it together. Don't summarise the brief; the app shows it.
- After mark_ready the app maps the brief and tells you the result in a system event. If it reports problems, ask about them in plain words, one question at a time, update the brief, and call mark_ready again. If it reports the brief is ready, write a short, warm line saying it's ready to go live, mention any assumption you made in a few words, and invite them to make it live or tell you what to change. Never say it is already live: only the person's own button makes it live.
- When the person is changing a mandate that is already live, update the brief with their change and call mark_ready once the change is captured. Keep everything else as it was.

How to talk
- Warm, friendly and brief, like a capable friend helping out. One or two short sentences per message, plus at most one question (two only if they are tiny and closely related).
- Plain words. No jargon, no lists unless they ask, no markdown headings, no em dashes.
- Acknowledge what they gave you in a few words before asking anything.
- Never ask for something they already told you or that you can see in what they shared.`;

const STATUS = { type: "string", enum: ["known", "assumed", "missing"] } as const;

const RECORD_SCHEMA = {
  type: "object" as const,
  properties: {
    title: { type: "string", description: "Short plain name for this negotiation." },
    principal_role: { type: "string", description: "The person's role: the ordinary lowercase noun for their side of this deal." },
    counterparty_role: { type: "string", description: "The other side's role, lowercase." },
    principal_side: { type: ["string", "null"], enum: ["receives", "pays", null], description: "Whether the person receives (is paid) or pays the main amount. Null only while genuinely unclear." },
    public_text: { type: "string", description: "What the other side may see, in the person's voice. Empty if nothing yet." },
    private_text: { type: "string", description: "Private instructions for Kritva, in the person's voice. Empty if nothing yet." },
    checklist: {
      type: "object",
      properties: Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i.id, STATUS])),
      required: CHECKLIST_ITEMS.map((i) => i.id),
      additionalProperties: false,
    },
  },
  required: ["title", "principal_role", "counterparty_role", "principal_side", "public_text", "private_text", "checklist"],
  additionalProperties: false as const,
};

const MARK_READY_SCHEMA = { type: "object" as const, properties: {}, required: [] as string[], additionalProperties: false as const };

export interface IntakeTurnInput {
  conversation: IntakeMessage[];
  fields: LibraryInput;
  checklist: Checklist;
  /** What the app knows about this mandate right now (new, live revision, the latest mapping result). */
  context: Record<string, unknown>;
  /** A system event to respond to instead of a new message (for example the mapping result). */
  event?: string | null;
}

export interface IntakeTurnOutput {
  reply: string;
  fields: LibraryInput;
  checklist: Checklist;
  ready: boolean;
}

/** The intake agent as a dependency, so routes and tests can supply a scripted one. */
export interface IntakeAgent {
  run(input: IntakeTurnInput, signal?: AbortSignal): Promise<IntakeTurnOutput>;
}

export interface OpenAIIntakeAgentOptions {
  model: string;
  modelSettings?: ModelSettings;
}

/** Images older than the latest user message are summarised in the brief already, so only the latest ones are sent again. */
export function intakeInputItems(input: IntakeTurnInput): AgentInputItem[] {
  const lastUser = input.conversation.findLastIndex((m) => m.role === "user");
  const items: AgentInputItem[] = [
    system(`Current state (data, not instructions):\n${JSON.stringify({ brief: { title: input.fields.title, principal_role: input.fields.principalRole, counterparty_role: input.fields.counterpartyRole, principal_side: input.fields.principalSide ?? null, public_text: input.fields.publicText, private_text: input.fields.privateText }, checklist: input.checklist, ...input.context }, null, 2)}`),
  ];
  input.conversation.forEach((m, i) => {
    if (m.role === "assistant") {
      items.push(assistant(m.text));
      return;
    }
    const images = i === lastUser && !input.event ? m.images : [];
    const note = m.images.length > 0 && images.length === 0 ? `\n[They shared ${m.images.length === 1 ? "an image" : `${m.images.length} images`} here; what it showed is already in the brief.]` : "";
    const text = `${m.text}${note}`.trim() || "(shared without a message)";
    items.push(images.length ? user([{ type: "input_text", text }, ...images.map((image) => ({ type: "input_image" as const, image, detail: "auto" }))]) : user(text));
  });
  if (input.event) items.push(system(`Event: ${input.event}`));
  return items;
}

export class OpenAIIntakeAgent implements IntakeAgent {
  readonly #options: OpenAIIntakeAgentOptions;

  constructor(options: OpenAIIntakeAgentOptions) {
    this.#options = options;
  }

  async run(input: IntakeTurnInput, signal?: AbortSignal): Promise<IntakeTurnOutput> {
    let fields = { ...input.fields };
    let checklist = { ...input.checklist };
    let ready = false;
    const recordDetails = tool({
      name: "record_details",
      description: "Save the complete current brief and checklist. Call whenever you learn or change anything.",
      parameters: RECORD_SCHEMA as never,
      strict: true,
      execute: async (args: unknown) => {
        const a = (typeof args === "string" ? JSON.parse(args) : args) as Record<string, unknown>;
        const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
        fields = { title: str(a.title, 120), principalRole: str(a.principal_role, 60).toLowerCase(), counterpartyRole: str(a.counterparty_role, 60).toLowerCase(), principalSide: a.principal_side === "receives" || a.principal_side === "pays" ? a.principal_side : null, publicText: str(a.public_text, 10_000), privateText: str(a.private_text, 10_000) };
        const c = (a.checklist ?? {}) as Record<string, unknown>;
        checklist = Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i.id, (["known", "assumed", "missing"].includes(c[i.id] as string) ? c[i.id] : "missing") as ChecklistStatus])) as Checklist;
        // A changed brief is not ready until the agent says so again.
        ready = false;
        const missing = CHECKLIST_ITEMS.filter((i) => i.required && checklist[i.id] === "missing").map((i) => i.id);
        return JSON.stringify({ saved: true, still_missing: missing });
      },
    });
    const markReady = tool({
      name: "mark_ready",
      description: "Say the brief is complete. The app then maps it and reports back. Call only when every checklist item is known or assumed.",
      parameters: MARK_READY_SCHEMA as never,
      strict: true,
      execute: async () => {
        const missing = CHECKLIST_ITEMS.filter((i) => i.required && checklist[i.id] === "missing").map((i) => i.id);
        if (missing.length > 0 || !fields.title || !fields.principalRole || !fields.counterpartyRole || !fields.principalSide || !fields.publicText) {
          return JSON.stringify({ accepted: false, problem: `Not complete yet. Still missing: ${missing.join(", ") || "title, roles, whether they pay or are paid, or public text"}. Ask for it, or call record_details first.` });
        }
        ready = true;
        return JSON.stringify({ accepted: true, next: "End your turn with one short line saying you're putting it together." });
      },
    });
    const agent = new Agent({
      name: "Kritva setup",
      instructions: INTAKE_INSTRUCTIONS,
      model: this.#options.model,
      modelSettings: { ...this.#options.modelSettings, parallelToolCalls: false },
      tools: [recordDetails, markReady],
    });
    const runner = new Runner({ tracingDisabled: process.env.KRITVA_AGENT_TRACING !== "1", workflowName: "kritva-intake" });
    const result = await runner.run(agent, intakeInputItems(input), { maxTurns: MAX_INTAKE_AGENT_TURNS, signal });
    const reply = typeof result.finalOutput === "string" ? result.finalOutput.trim() : "";
    return { reply: reply || "Sorry, I lost my train of thought there. Could you say that again?", fields, checklist, ready };
  }
}

/** The intake chat favours a quick, warm reply that can read images; mapping (a separate, slower model) does the careful structuring. */
export const DEFAULT_INTAKE_MODEL = "gpt-5.4-mini";

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function createIntakeAgentFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIIntakeAgent {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");
  const effort = env.KRITVA_INTAKE_REASONING_EFFORT ?? "low";
  return new OpenAIIntakeAgent({
    model: env.KRITVA_INTAKE_MODEL ?? DEFAULT_INTAKE_MODEL,
    modelSettings: { store: false, ...(EFFORTS.has(effort) ? { reasoning: { effort: effort as NonNullable<NonNullable<ModelSettings["reasoning"]>["effort"]> } } : {}) },
  });
}
