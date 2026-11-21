# Epics 9–11 manual checks

- Date: 2026-11-21
- Setup: `kritva-server` (port 8787) and `kritva-web` (port 5173), turn model `gpt-5.4-mini`, mapping model `gpt-5.5`, guidance `seller-strategy/1`. Browser pane at a narrow (about 590px) width.

## Epic 11: mandate library (in the browser)

| # | Action | Result |
| --- | --- | --- |
| 1 | Top bar → **Mandates**. | The library opens with "New mandate" and the input form: name, your role, the other side's role, public facts, private instructions (marked private). |
| 2 | **Load an example** → "King-size bed sale" (custom select). | The form fills from `cases/bed-sale` (listing and seller instructions as separate texts). |
| 3 | **Map to a draft** (live mapping, about 40s). | The review shows: price ₹20,000, pickup Koramangala, delivery not included (public); three listing facts; private minimum ₹18,000 and "delivery: only No"; the goal; permissions (negotiate: Kritva may; accept: ask me first; share private information: not allowed). It says "7 private items, never shown to the other side". The draft is marked not in force. |
| 4 | **Correct** the minimum to 18500 (Enter saves). | Version 2 is created. The minimum reads ₹18,500 "From Correction by the principal (private)". History shows 2 versions. |
| 5 | **Confirm mandate**. | "Revision 1 confirmed and saved." The list shows "Revision 1". The header shows when it was confirmed. |
| 6 | **Use for the next negotiation** → **New session**. | The negotiation view selects the saved mandate. The operator API shows `mandateSource: revision 1` and minimum ₹18,500. |
| 7 | As the buyer: "Hi, I can pay ₹17,000." | "I can offer ₹18,500." The ask is held at the saved revision's limit. The buyer view shows ₹18,500 only as the delivered offer. |
| 8 | Logo-design example, mapped live through the same create route. | Five terms (price, logo concepts, revision rounds, delivery timing, final file format) appear in the same generic review. Roles are buyer and designer. Open questions are "missing permissions" and "unclear budget". There are no bed facts or limits. |

Fixed during the check:
- The view switch overlapped the wordmark at narrow widths; the top bar now wraps.
- The example picker read only "Choose…"; it now says "Load an example".
- Review rows were too tall; label margins removed (this also tightens the Offers tab).
- Correcting a value now selects the old value and saves on Enter.

## Epic 9: text chat

- The buyer chat shows, above the conversation: "You're chatting with Kritva, an AI. It negotiates for the seller and isn't the seller or a person. Anything agreed is confirmed with the seller." Replies are labelled "Kritva (AI) for the seller".
- The seller console summary shows **Last action** with its reason (for example "Counter: Offer is outside the limit; counter without revealing it.").
- A model failure returns HTTP 503 with a neutral message. The chat keeps the message ID, so **Try again** resumes the same turn. Covered by the unit test and by the existing retry control in the chat; not forced against the live model.

## Not checked manually

- Applying a confirmed revision to an open session from the browser. It is covered by the server test that confirms ₹19,000 while a ₹18,500 offer is pending.
- Voice (out of scope).
