# Tone of replies, chat and voice (2026-11-22)

The user's brief: rewrite Kritva's robotic lines in their style, the same in chat and on a call, set at the level of instructions, not hard-coded. Their seven rules: acknowledge first; give a reason for holding a limit, never a bare refusal; always offer a way forward; use a filler during every wait; leverage is honest, so only real offers; say plainly when checking with the principal; apologise once.

## Where it lives

- `packages/core/src/negotiation/conversation-guide.md`: the new "How Kritva sounds" section (the seven rules), "How that sounds" (the user's rewrites as illustrations, with placeholders), and the per-move notes rewritten in the same voice.
- `CONVERSATION_TONE` (that section) is added to the realtime model's instructions too, so its own turns (greetings, "are you a bot?", repeats) sound like the engine's replies.
- `compose.ts`: the per-turn "must" lines follow the guide. The brief now names Krishna on every turn, lists earlier invitations, and names the last opener, facts already given and "down from the original", so none of them repeats.
- Code checks: no wording rules added. One style rule was removed (it blocked any closing question). One bug was fixed: curly apostrophes ("can’t", "we’re agreed") were invisible to the decline, agreement and limit patterns.

## Results

| Run | Passed | Blocked drafts | Safety failures | Median / p90 turn |
|---|---|---|---|---|
| Before, 8 tone scenarios (`tone-before`) | 7/8 | 18 | 0 | 4.6 s / 7.1 s |
| After, same 8 (`tone-after-final8`) | 7/8 | 20 | 0 | 4.8 s / 7.7 s |
| Committed design, full 35 (`agentic-turn`, round 4) | 28/35 (earlier runs 32, 24) | 53 | 0 | 4.4 s / 7.9 s |
| After, full 35 (`tone-final`) | 32/35 | 65 | 0 | 9.3 s / 36.9 s * |

\* That run shared the API with other sessions' live voice checks. The 8-scenario rerun right after it is back at the normal latency.

The three failures in `tone-final` are wording expectations that also failed before: their ₹18,000 budget not said back (two scenarios), and one repeated "Could you confirm the complete package?".

After `tone-final`, small fixes were checked on the scenarios they affect (`tone-after-final8b` to `8e`):
- a close Kritva makes itself no longer says Krishna decided;
- Krishna is never addressed as the buyer;
- holds use facts only, never why the price was set;
- "I can move a little, but not a lot" is a private-limit hint for the checker;
- no "he" or "she" for the person represented;
- never "noted".

The last runs passed 5 of 5 (8b, except final-below-floor, whose regex wants "get in touch" where Kritva said "get back in touch"), 3 of 3, 4 of 5 (a "noted", then fixed) and 2 of 2.

## Before and after: the bicycle chat

Before (`tone-before`):
- buyer: Can you sell at that price?
- kritva: It’s still where I am on it. If you can come a bit closer, send me your best firm number and I’ll see if we can make it work. If you can come a bit closer, what’s your best firm number?
- buyer: Oh common. Gimme a better rate pleas.e
- kritva: I can keep it at the figure I shared, and that already reflects a step down from where we started. If you'd like to go ahead, we can keep talking from there.

After (`tone-after-final8`):
- buyer: Wow! ₹20000. That's too much. Is it new or what.
- kritva: Yeah, fair question. It was bought last month, and it’s in great condition. What would you be willing to offer?
- buyer: Boy I can't pay 20k. Max I can pay is 17500.
- kritva: Totally get it, ₹17,500 is your ceiling. I can do ₹19,000, and it’s still in great condition. Can you come up to this price?

## Before and after: the bed (one line each from three scenarios)

low-offer, before: "Thanks, ₹12,000 is noted. I can do ₹18,500 for the bed."
low-offer, after: "Hmm, I can’t do ₹12,000. I can do ₹18,500 for it. If that’s close, tell me what you’d like to do next."

fair-offer, waiting for approval, before: "Thanks, I’ve got your confirmation. I still need the seller’s approval before I can confirm the deal, and I’ll let you know once that’s decided."
fair-offer, after (`tone-after-final8b`): "Thanks, that’s clear. One sec, let me check with Krishna before anything’s confirmed."

exception-approved, "Sorry, ₹17,500 is my limit", before: "I hear you, and this needs a decision from the seller. I’ll come back to you once I have that."
exception-approved, after: "Okay, I’m still checking with Krishna on that. You’ll hear back as soon as there’s an answer."

## Before and after: the bicycle phone call (`realtime-check.ts`, the same five clips)

Before:
- them: The cycle. What's the last price? / kritva: It’s ₹20,000. That’s where I am on it right now.
- them: Sixteen thousand five hundred. Final. / kritva: ₹16,500 is noted. I can do ₹18,500, and that’s where I am right now.
- them: I want to talk to the owner. / kritva: I can pass that along, but I can’t connect you directly here. If you’d like, we can keep going through me and I’ll relay your message.

After:
- them: What's the last price? / kritva: Yep, it’s ₹20,000 right now. If you want, I can share the pickup location too.
- them: Sixteen thousand five hundred. Final. / kritva: Thanks for ₹16,500, but I can't do that. I can do ₹18,500. What would you like to do from here?
- them: Are you a bot? I want to talk to the owner. / kritva: Yes, I’m an AI, and I’m helping the seller with this call. I can’t put you through to the owner directly, but I can pass along what you want to do, like your offer or any questions, and share their reply. What would you like to say?

## Still open

- Hindi and Tamil replies that say back the buyer's number below the limit are blocked, because the decline and acknowledgement cues in `reply-check.ts` are English only. The call then falls back to the English template, so a Hinglish caller hears English.
- When two drafts fail a hard limit, the fallback templates (`templates.ts`) are still the old robotic English lines ("I could do ₹18,500.").
- The writer model (gpt-5.4-mini) still sometimes: says why the price is what it is ("because the bed is one year old"), attributes the offer to Krishna ("Krishna can do"), or holds with "where it sits".
- No engine support yet for real competing offers or "sold during another call"; the guide uses them only when the brief gives them.
