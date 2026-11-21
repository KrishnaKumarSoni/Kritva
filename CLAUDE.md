# Kritva: standing rules

These rules apply to every piece of work in this project.

## Brand and visual design

1. **Typeface:** Use Vercel's Geist Serif for the "Kritva" wordmark and for all headings across the product.
2. **Colors:**
   - **Accent: burnt orange** (starting value `#CC5500`). Use it for key/primary buttons and brand components.
   - **Primary: jet black** (starting value `#0A0A0A`). Use it for basic buttons, headings and the rest of the UI.
   - **Base/secondary: white.**
3. **Dropdowns:** Build every dropdown or select in Kritva's own design-system style. Never ship the default macOS or browser-native look.

## UI and UX process

4. For every interface piece, you must use **all** of these skills: `fluid-design`, `apple-design`, `better-ui`, `better-polish` and `better-interface`.

## AI and deployment stack

5. **AI:** OpenAI for all text reasoning and LLM work, with different models used where each fits. OpenAI for voice too, for now.
6. **Infrastructure:** AWS for deployment and the database. Choose regions for low latency, because latency matters a lot (the target users and demo are in Bangalore, India). Database and service choices are still open: propose industry-standard options when the time comes, and don't decide them silently.
