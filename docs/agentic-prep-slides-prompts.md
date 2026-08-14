# Google Slides Prompt Pack — "Agentic Prep" Deck

Companion to `agentic-prep-source-doc.md`. Audience: internal Tableau Solution Engineering
(executive / non-technical). ~12 core slides + optional appendix.

---

## Option A — One-shot prompt (fastest)

Use this in **Google Slides → Gemini panel** *after* pasting the source doc into a Google Doc in
the same Drive, or paste the doc text directly into the prompt.

> Create a clean, executive-level 12-slide presentation titled **"Agentic Prep: Tableau Prep as a
> Headless, Agentic Data-Acquisition Skill"** for an internal Tableau Solution Engineering audience.
> Tone: confident, strategic, minimal jargon, outcome-focused. Use the content from [the attached
> document / pasted text below] — one slide per numbered section, keeping each section header as the
> slide title. Favor short bullet phrases (max ~6 words each, max 5 bullets per slide), not
> paragraphs. Use a modern corporate theme with a blue/teal palette consistent with Tableau's brand
> feel (do not reproduce the logo). Add concise speaker notes to each slide from the "Talk track"
> lines. Leave any [PLACEHOLDER] items as visible placeholders. End with a call-to-action slide.

---

## Option B — Slide-by-slide prompts (more control)

Run these in order. Each `PROMPT:` line goes to the Gemini/Slides generator or a new-slide request.
`IMAGE:` lines can be pasted into Slides' image generator or an external tool, then inserted.

### Slide 1 — Title
**PROMPT:** Create a title slide. Title: "Agentic Prep." Subtitle: "Tableau Prep as a Headless,
Agentic Data-Acquisition Skill." Small tagline: "A building block for the AI-integrated future of
analytics." Minimal, bold, blue/teal gradient background.
**IMAGE:** Abstract flowing data streams converging into a single clean channel, deep blue and
teal, subtle, corporate, no text.
**NOTES:** Not a new UI — a new way to *invoke* Prep so agents can prepare data on demand.

### Slide 2 — The one-sentence idea
**PROMPT:** Single-statement slide, large centered text: "We made Tableau Prep headless and
agent-callable — so an AI agent can crawl, acquire, clean, and shape data on demand, with no analyst
driving the flow." No bullets.
**NOTES:** If a human can build a Prep flow, an agent can now compose that same power as a skill.

### Slide 3 — Why this matters now
**PROMPT:** Slide titled "Why This Matters Now." Three short bullets: "Analytics is shifting from
humans operating tools to agents orchestrating capabilities"; "The real AI bottleneck is clean,
trustworthy data — not the model"; "Making Prep headless + agentic turns our strength into an
AI-native capability." Clean layout.
**IMAGE:** Simple left-to-right arrow motif: "human + tool" evolving into "agent + capability,"
flat corporate icons, blue/teal.
**NOTES:** Every AI conversation hits "the data isn't ready." This is how Tableau is the answer.

### Slide 4 — What headless + agentic mean
**PROMPT:** Slide titled "Headless + Agentic, in Plain Language." Two-column comparison. Left column
"Headless": "Runs without its visual UI"; "Invoked by code or an agent"; "Returns results to the
caller." Right column "Agentic": "Agent decides what data to pull"; "Chooses how to join & clean";
"Verifies its own result." Below both, one line: "Together: Prep becomes a skill in an agent's
toolbox."
**NOTES:** Prep goes from "an app you open" to "a service your AI can ask for help."

### Slide 5 — The capability, illustrated
**PROMPT:** Slide titled "Agentic Crawling & Acquisition." Numbered 4-step horizontal flow:
1 Crawl sources; 2 Acquire & combine via Prep; 3 Clean & shape; 4 Verify & hand off to Tableau.
Add a placeholder box labeled "[PLACEHOLDER: live demo / recorded GIF]".
**IMAGE:** Four-node horizontal pipeline diagram with arrows, minimalist, blue/teal, labeled nodes.
**NOTES:** The agent does the multi-source legwork a person would do manually. Show the demo here.

### Slide 6 — Interoperability (the strategic key)
**PROMPT:** Slide titled "Interoperability — The Strategic Key." Three bullets with bold lead-ins:
"Callable as an agentic skill — any compliant agent can invoke it"; "Programmatically composable —
chains with retrieval, analysis, visualization"; "Open interop surfaces — works over standard
model/agent interfaces (LLM gateways, Model Context Protocol pattern)." Visually emphasize this as
the key slide (accent color, larger).
**IMAGE:** Central "Prep skill" hub with plug/connector icons linking to generic agent, model, and
app blocks, blue/teal, no brand logos.
**NOTES:** Customers won't adopt a closed island. Interop = Prep becomes a component of *their* AI
future, whatever stack they run.

### Slide 7 — Why this is a Tableau advantage
**PROMPT:** Slide titled "Why This Is a Tableau Advantage." Three bullets: "Not a black box —
Prep is transparent, governable, already trusted"; "Agent gets autonomy; enterprise keeps lineage &
control"; "Extends existing Prep investment, doesn't replace it."
**NOTES:** The differentiator: our agent prepares data the way governance already approved.

### Slide 8 — What it unlocks for SEs
**PROMPT:** Slide titled "What It Unlocks for Solution Engineers." Three bullets: "A modern answer to
'how do we get AI-ready data?'"; "A demo of Tableau *doing* agentic work, not just displaying it";
"A foothold in customer AI-platform decisions."
**NOTES:** Gives SEs something to *lead* with in AI conversations, not react to.

### Slide 9 — Example use cases
**PROMPT:** Slide titled "Example Use Cases." Three cards: "On-demand dataset assembly — clean table
from scattered sources in minutes"; "Continuous refresh crawling — re-acquire & re-clean as sources
change"; "AI pipeline feedstock — clean, governed data for downstream AI." Add "[PLACEHOLDER: tie to
your vertical/customer]".
**IMAGE:** Three simple flat icons: assembling blocks, refresh cycle, funnel into a chip/AI icon.
**NOTES:** Anchor each to a customer segment you actually work.

### Slide 10 — Proof / status
**PROMPT:** Slide titled "Where We Are Today." Bullets, honest framing: "Status: [PLACEHOLDER:
prototype / pilot / GA target]"; "Validated: [PLACEHOLDER: what you've actually run]"; "Reliability:
engineered for stable, complete responses under load." Keep it credible, not hyped.
**NOTES:** SE audiences trust candor — state what's real today vs. roadmap.

### Slide 11 — The bigger picture
**PROMPT:** Statement slide titled "The Bigger Picture." Large text: "Agentic Prep is the first proof
point of a pattern — Tableau capabilities exposed as agentic skills. Prep today; more of the platform
tomorrow." Subtle, forward-looking.
**IMAGE:** Horizon / sunrise-style abstract gradient suggesting expansion, blue to teal, no text.
**NOTES:** Not one feature — a demonstration of Tableau becoming composable in the agentic era.

### Slide 12 — Call to action
**PROMPT:** Slide titled "Call to Action." Three bullets: "SEs: learn the demo, bring it to
AI-readiness conversations"; "Feedback: which customer scenarios need this most?"; "Next:
[PLACEHOLDER: enablement date / demo env link / contact]." Strong closing layout.
**NOTES:** End on the ask — what should this room do Monday morning?

---

## Optional appendix prompts

### A1 — How it fits an agent stack
**PROMPT:** Diagram slide titled "How It Fits an Agent Stack." Left-to-right flow:
Agent → (skill call) → Headless Prep → Clean, governed data → Tableau / downstream AI. Minimal labels.
**IMAGE:** Clean architecture diagram, four to five boxes with arrows, blue/teal, executive-simple.

### A2 — Governance & trust
**PROMPT:** Slide titled "Governance & Trust." Bullets: "Lineage preserved through Prep";
"Permissions honored on acquisition"; "Human-auditable, not a black box."

### A3 — FAQ
**PROMPT:** Slide titled "FAQ." Q&A pairs: "Does this replace Prep flows? — No, it invokes them.";
"Which agents work? — Any that speak the standard interop surfaces."; "Who controls the data? — Your
governance, unchanged."

---

## Design & delivery tips
- **Theme:** pick one modern Slides theme up front; regenerate slides into it for consistency.
- **Density:** executive audience — headline + ≤5 short bullets; push detail to speaker notes.
- **Placeholders:** search the deck for "[PLACEHOLDER" and fill every one before presenting.
- **Images:** AI-generated visuals are decorative — keep them abstract; avoid fake UI screenshots
  that imply features you can't demo.
- **Honesty guardrail:** metrics, customer names, and demo links must be real. If you don't have a
  number, cut the claim rather than invent one.
