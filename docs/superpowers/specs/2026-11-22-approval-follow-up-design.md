# Approval with a later follow-up: design

Written 2026-11-22. Branch `claude/approval-flow-1d75c9`. Approved by the user on 2026-11-22, with the instruction to build for a five-minute demo: the main path solid, rare edge cases later.

## 1. Intent

The seller (principal) is often away from the console. Today a buyer's acceptance waits for the seller while the buyer sits on the call or in the chat. If the seller decides later, a buyer who hung up hears nothing, and an approval can close a deal the buyer has already walked away from.

New rule: approval never happens during the conversation and never closes a deal by itself.

1. Kritva recaps the exact terms and the buyer confirms them.
2. Kritva asks how long the offer stands and the best way and time to reach the buyer.
3. Kritva says clearly that nothing is final until the seller confirms, thanks the buyer, and ends the call.
4. The pending offer, with everything the seller needs, waits on the seller's approval card.
5. The seller approves, counters or declines whenever they are back.
6. Kritva follows up on the channel the buyer chose. The agreement is recorded only after the buyer says yes again.

The same steps apply in text chat (the user's choice), except that a chat does not end. The chat thread is the follow-up channel unless the buyer asks for a call.

## 2. Goals, non-goals, anti-goals

**Goals**
- The flow above, on browser calls, phone calls and chat.
- Approve, counter and decline from the console card, with the follow-up worded from each.
- Follow-ups through the chat thread and through Vobiz call-backs.
- A recording of each browser call and each follow-up call, on the card.
- Edge cases: an expired offer, a changed term and no answer. For several pending offers on one item, the hooks the multi-party work needs (section 8).
- The four gaps found earlier: the seller's message reaches the buyer, the seller can counter, the seller is alerted and sees how long the offer stands, and a decision made after the call still reaches the buyer.

**Non-goals (this round)**
- WhatsApp. If a buyer asks for WhatsApp, the preference and number are saved and Kritva follows up by call. The card says so.
- Recording incoming phone calls. They come through the SIP trunk, which runs no Vobiz XML. The card says "not recorded". Follow-up calls are recorded.
- Telling the buyer about the recording. The user decided on no announcement. Note: India's DPDP Act expects notice. This is the user's call, recorded here.
- Cloud storage. Recordings go to the server's data folder for now (see section 9).

**Anti-goals (a failure even if it works)**
- An agreement recorded, or claimed in words, without the seller's approval and the buyer's yes after it.
- Kritva implying agreement while the offer waits ("great, it's yours").
- Silence on the line, or a call that ends without the buyer knowing what happens next.
- An approval used after the buyer changed a term.

## 3. Constraints

- Code decides every commitment. The model only words a move. The record refuses an agreement that breaks the rules.
- Never use em dashes (CLAUDE.md, memory).
- The parent session's refactor (`conversation-guide.md`, split `price` and `other_terms` brief) lands first, and this work is built on it.
- Latency matters (Bangalore users). Nothing new runs on the hot path of a normal turn, except a few extra fields in the reading while an offer is pending.
- The console UI must use the `fluid-design`, `apple-design`, `better-ui`, `better-polish` and `better-interface` skills, Geist Serif headings, burnt orange for primary actions, and Kritva-styled dropdowns (CLAUDE.md).

## 4. Approaches considered

**Who runs the wrap-up conversation (recap, validity, contact, close)**
- A. *Picked.* The engine plans it: code tracks which details are still missing, asks each at most once, and decides when to close and end the call. The writer model words each line from the brief and the conversation guide. The realtime voice gets the user's instruction too, so its own words never imply agreement.
- B. The realtime voice model runs the wrap-up itself from the instruction. Rejected: ending the call and saving the pending offer are commitments, and the engine already owns every deal turn.

**How the follow-up call reaches the buyer**
- A. *Picked.* Vobiz Make Call to the buyer's number. When the buyer answers, Vobiz runs Kritva's answer XML, which records the session and dials OpenAI's SIP address with a follow-up token in a SIP header. OpenAI's `realtime.call.incoming` webhook then joins the call to the existing negotiation, not a new one.
- B. Same, but the answer XML dials Kritva's own Vobiz number, so the call re-enters through the incoming trunk, which already has TLS and SRTP working. This is kept as a configuration fallback (`KRITVA_FOLLOW_UP_SIP_URI`), because Vobiz documents OpenAI for incoming calls only. Matching then falls back to "the follow-up call answered in the last 30 seconds".
- C. A browser call-back. Rejected: a buyer who left the page is unreachable.

**Where the approval decision lives**
- A. *Picked.* `approval_responded` gains `countered` (with the counter offer) and `declined`, and agreements require a buyer acceptance recorded after the approval. Both acceptance and exception approvals use the same path.
- B. A separate pending-offer aggregate. Rejected: it duplicates the approval request, which already binds the exact terms and mandate revision.

## 5. The conversation, step by step

**Accepting stated terms (acceptance approval)**
1. Read-back, as today (`state_final_terms`): "So that's ₹19,000, pickup today evening in Indiranagar. Right?"
2. Buyer: "Yes." Code records the acceptance and the approval request (as today). The reply thanks them and asks how long the offer stands.
3. Buyer answers. The reply asks the best way and time to reach them. On a phone call: "Should I call you back on this number? Any time that works best?" In chat: here in the chat, or a call (then the number).
4. Buyer answers. The reply says clearly it is not final until the seller confirms, that Kritva will get back to them, thanks them warmly, and on a call the server ends the call once the line has played.

A detail the buyer refuses, ignores or already gave is not asked again. Each is asked once. Several details given in one message all count. If the buyer asks "so is it a deal?" while waiting, the answer is that it isn't final until the seller confirms.

**An offer below the limit (exception approval)**
The request is recorded as today. The reply now recaps their offer as theirs, with the exact terms ("Just to check: your offer is ₹17,500 with pickup in Koramangala, right?") and says it needs the seller's decision. Steps 3 and 4 follow. Nothing is offered.

**A term changes while waiting**
The approval request is void (as today). Kritva handles the new terms like any turn: it reads back the new complete terms, and on the buyer's yes a new approval request starts the wrap-up again. Known contact details are reused. Validity is asked again for the new terms.

## 6. The seller's decision and the follow-up

| Decision | Recorded | Follow-up (model words it) | Next |
|---|---|---|---|
| Approve | `approval_responded: approved`. Status back to active. Approval on record for these exact terms. | "Good news, Krishna's confirmed ₹19,000. Still good for pickup today?" | The buyer's yes records the acceptance and then the agreement. |
| Counter | A new offer by the seller (`offer_proposed`, final terms). `approval_responded: countered` linked to it. | "Krishna can do ₹19,500 with pickup tomorrow. Would that work?" | The buyer's yes starts a new round and a new approval (the user's rule). |
| Decline | `approval_responded: declined`. Status no agreement, ended by the seller. | "Sorry, Krishna can't do that one. Can I keep your number in case anything changes?" | Their answer is saved as consent (yes or no). The call then ends. |

- **Expired offer.** If the offer's time has passed when the follow-up reaches them, the follow-up re-confirms first: "Is ₹19,000 still good for you?" Agreement only on yes.
- **A changed term on the follow-up.** The approval does not cover the new terms (approvals bind the terms hash), so the step-5 wrap-up runs again and the call ends.
- **"No, I've bought one."** No agreement, ended by the buyer.
- **The seller's message.** The card has an optional "Message for the buyer". The follow-up passes it on, and the reply checks still run (no amount beyond the decided terms, nothing private). The seller's private note stays private, as today.
- **The buyer is still connected when the seller decides** (a live call or an open chat). The follow-up goes out right away on that channel. My call: there's no reason to hang up and ring back.
- Old `rejected` requests are read as `declined`. Scenario 13 changes: a rejected exception now ends with no agreement instead of returning to the previous price. The seller can counter instead.

## 7. Follow-up delivery

**Chat.** The follow-up is recorded as a text message and appears in the buyer's chat. If the buyer does not reply within `KRITVA_FOLLOW_UP_CHAT_WAIT_MINUTES` (default 120), one short reminder is sent. If there is still no reply after the same wait again, the follow-up is lapsed.

**Call.** At the later of now and their preferred time (when they gave one that can be read as a time), Kritva places a Vobiz call:

```
POST https://api.vobiz.ai/api/v1/Account/{VOBIZ_AUTH_ID}/Call/
  from: Kritva's number   to: the buyer's number
  answer_url:  {KRITVA_PUBLIC_URL}/api/webhooks/vobiz/answer?t=<token>
  hangup_url:  {KRITVA_PUBLIC_URL}/api/webhooks/vobiz/hangup?t=<token>
answer XML:
  <Response>
    <Record recordSession="true" fileFormat="mp3" maxLength="1800" playBeep="false"
            callbackUrl="{...}/api/webhooks/vobiz/recording?t=<token>"/>
    <Dial callerId="{Kritva's number}" timeout="30" action="{...}/api/webhooks/vobiz/dial?t=<token>">
      <User sipHeaders="KritvaFollowUp=<token>">{KRITVA_FOLLOW_UP_SIP_URI}</User>
    </Dial>
  </Response>
```

- The token is random, single use and expires. It is the only authority on these webhooks (Vobiz's signature check can be added once its scheme is confirmed).
- OpenAI's incoming-call webhook finds the token in the SIP headers (or, as a fallback, the follow-up call answered in the last 30 seconds) and joins the call to the existing session. The engine writes the opening follow-up line at that moment, so expiry is judged when the buyer actually hears it.
- **No answer, busy or failed** (from the Dial result or a hang-up without an answer): retry once after `KRITVA_FOLLOW_UP_RETRY_MINUTES` (default 15). A second failure marks it lapsed: no agreement, reason "lapsed", and the card says so.
- The buyer's number is saved only when they agree to be called (on a phone call, "this number" uses the caller's number from the SIP headers). It is visible only on the operator side, and masked in logs.
- A scheduler in the server (every 30 seconds) places due calls, sends due reminders and lapses due follow-ups. Each step is an event in the record, so a restart picks up where it left off.

## 8. Several pending offers on one item

This belongs to the multi-party session (branch `claude/multiple-counterparties-cd7063`), as agreed with it on 2026-11-22. It owns everything across sessions: the group of sessions for one item, a shared offer list, an item lock (first approved wins), and closing the other buyers politely, including during a live call. Nothing across sessions exists yet.

This work owns the per-session part and gives it two hooks:
- Every agreement is written through one engine function (`#recordAgreement`), as a single `agreement_recorded` append. "The deal is final" happens only there. It takes an optional claim: if the claim fails, nothing is written and the function returns "not recorded". The multi-party work claims the item lock there and tells the other sessions right after.
- The seller's approval goes through one function (`#onApproved`). If the user wants approval to reserve the item (so no second approval can go through while the approved buyer reconfirms), the multi-party work takes the reservation there.

This work adds no "close the rest" step. Whether the lock is taken at approval or at the buyer's yes is the user's decision, raised by the multi-party session.

## 9. What is saved, and where

New record events (operator-only, never public):
- `follow_up_noted`: valid until (time, plus their words), contact (chat, call or WhatsApp), number, best time (their words, plus an earliest time when one can be read), details refused, and `keepContact` (their yes or no to being contacted if anything changes). Every field is optional, so the multi-party work can record consent with no pending offer.
- `status_changed` gains an optional `outcome`: `declined_by_principal`, `lapsed` or `went_elsewhere` (the last for the multi-party work).
- `follow_up_attempted`: channel, attempt number, outcome (reached, no answer, busy, failed), Vobiz call ID.
- `recording_saved`: which call, source (browser or Vobiz), file reference, length.
- `approval_responded`: decision `approved`, `countered` or `declined` (old `rejected` still reads), optional counter offer ID, optional message for the buyer.

Record rules (hardening):
- An agreement that needs approval must reference an acceptance recorded *after* that approval.
- A `countered` response must reference an offer by the seller recorded before it.

Recordings: browser calls are recorded in the browser (microphone plus Kritva's audio, mixed) and uploaded when the call ends. Follow-up calls use Vobiz's recording, downloaded on the recording callback. Files go to the server's data folder now. **Proposal for deployment (not decided):** S3 in `ap-south-1` (Mumbai), encrypted, with a retention rule.

## 10. Console approval card

- The buyer, where and when the offer was made, the exact terms.
- Valid until, with time left or "expired 20 min ago (Kritva will re-confirm first)".
- How to reach them: chat, or call to `98••••3210`, plus the best time in their words.
- The recording (player) and a link to the transcript in the record.
- Optional "Message for the buyer".
- Approve (burnt orange), Counter (opens a term editor with Kritva-styled controls; the price and each term are editable), Decline.
- "Terms changed, approve again": when the buyer changes a term, the old request is void and the new one is labelled as a re-approval, with the earlier terms shown for comparison. (The multi-party work adds "Reserved for X" and "Went to X".)
- After the decision: the follow-up status ("Calling now", "No answer, retrying at 7:15 pm", "Waiting for their yes", "Lapsed", "Agreed").
- Alerts: a count in the page title and a browser notification when a new pending offer arrives.

The buyer side already shows the call transcript in the chat and turns typing off during a call. It also shows "Waiting for Krishna's approval".

## 11. Left to the builder, and open items

- Exact wording comes from the brief and the conversation guide. The user's instruction is added to both:
  > When terms need approval: recap the exact terms, ask how long the offer stands and the best way and time to reach them, say clearly it is not final until {{principal.name}} confirms, thank them warmly, and end the call. Never say or imply agreement.
- Reading "good till tonight" or "after 6" as a time uses the Asia/Kolkata time zone by default (`KRITVA_TIME_ZONE`).
- **Needs a live test by the user:** a Vobiz call-back bridged into OpenAI SIP (option A, or the fallback B), and whether the SIP header carries the token.
- **Several buyers on one item** is the multi-party session's work (section 8). Changes to `record/events.ts` and `record/rules.ts` are announced to it before they are made.

## 12. Tests and evals

- Unit tests for the policy (wrap-up order, each detail asked once, close and end-call, the decision table, expiry wording), the record rules (acceptance after approval, countered), the state projection (follow-up details), the server routes (decision API, Vobiz webhooks with a fake Vobiz, follow-up scheduler, retry and lapse), and the voice end-call.
- Live scenarios, one per behaviour: wrap-up in chat, approve then yes, approve after expiry, counter then a new approval, decline with keep-contact, a changed term on the follow-up, and lapse. (Two buyers on one item is tested by the multi-party work.) Scenarios 12, 13 and 27 are updated for the yes after approval. A full eval run shows no regressions.
