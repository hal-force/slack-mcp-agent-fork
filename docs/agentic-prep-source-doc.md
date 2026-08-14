# Agentic Prep: Headless, Agent-Driven Data Acquisition for Tableau

**Source document for deck generation.**
Audience: Internal Tableau Solution Engineering (executive / non-technical framing).
Purpose: Paste this into a Google Doc, then use the companion prompt pack in Google Slides
(Gemini → "Help me create," referencing this Doc) to generate the deck.

> How to use: Each numbered section below maps to one slide. Keep the section headers as
> slide titles. Replace every `[PLACEHOLDER]` with your own metric, link, or screenshot before
> presenting. Speaker-note guidance is in the *Talk track* lines.

---

## 1. Title — Agentic Prep

**Agentic Prep: Tableau Prep as a Headless, Agentic Data-Acquisition Skill**

Subtitle: Turning data preparation into a capability agents can call — and a building block for the AI-integrated future of analytics.

*Talk track:* This is not a new UI. It's a new way to *invoke* something SEs already know and trust — Tableau Prep — so that AI agents can prepare data on demand, without a human driving the canvas.

---

## 2. The one-sentence idea

We made Tableau Prep **headless and agent-callable**: an AI agent can now crawl, acquire, clean, and shape data through Prep — programmatically, on demand, with no analyst clicking through the flow.

*Talk track:* If a human can build a Prep flow, an agent can now trigger and compose that same power as a "skill." That's the whole story — everything else is why it matters.

---

## 3. Why this matters now (the shift)

- Analytics is moving from *humans operating tools* to *agents orchestrating capabilities*.
- The bottleneck in most AI-for-analytics efforts isn't the model — it's **getting clean, trustworthy data to the model**.
- Prep is Tableau's proven answer to data shaping. Making it **headless + agentic** turns our biggest strength into an AI-native capability.

*Talk track:* Every customer AI conversation eventually hits the same wall: "the data isn't ready." Agentic Prep is how Tableau shows up as the answer to that wall, not a bystander.

---

## 4. What "headless" and "agentic" mean (plain language)

- **Headless:** Prep runs without its visual interface — invoked by code or by an agent, returning results to whatever called it.
- **Agentic:** An AI agent decides *what* data to pull, *how* to join and clean it, and *when* it's good enough — then acts, checking its own work.
- **Together:** Prep becomes a *skill in an agent's toolbox*, not a destination a person visits.

*Talk track:* Think of Prep going from "an app you open" to "a service your AI can ask for help." Same engine, new front door.

---

## 5. The capability, illustrated

**Agentic crawling & acquisition:** point the agent at a goal ("assemble a clean revenue-by-region table from these sources"), and it:
1. **Crawls** available sources to find relevant data,
2. **Acquires** and combines it through Prep,
3. **Cleans & shapes** it to a fit-for-analysis state,
4. **Verifies** the result and hands back something Tableau can use immediately.

*Talk track:* The agent does the legwork a person would otherwise do manually across a dozen sources. Walk through the [PLACEHOLDER: live demo or recorded GIF] here.

---

## 6. Interoperability — the strategic key

Agentic Prep is built to *plug in*, not stand alone:

- **Callable as an agentic skill** — any compliant AI agent can invoke it as one of its tools.
- **Programmatically composable** — it chains with other steps (retrieval, analysis, visualization) in larger AI workflows.
- **Open interop surfaces** — works over standard model/agent interfaces (e.g., LLM gateways and the Model Context Protocol pattern), so it fits whatever agent stack a customer runs.

*Talk track:* This is the slide that matters for SE. Customers won't adopt a closed island. Interop means Prep becomes a *component of their AI future*, regardless of which model or platform they bet on.

---

## 7. Why this is a Tableau advantage

- We're not asking customers to trust a black box to touch their data — Prep is **transparent, governable, and already trusted**.
- The agent gets **speed and autonomy**; the enterprise keeps **lineage, governance, and control**.
- It extends existing Prep investment instead of replacing it.

*Talk track:* The differentiator isn't "we have an agent too." It's "our agent prepares data the way your governance team already approved."

---

## 8. What it unlocks for Solution Engineers

- A crisp, modern story for the "how do we get AI-ready data?" objection.
- A demo that shows Tableau *doing agentic work*, not just displaying results.
- A foothold in customer AI-platform decisions — Prep as infrastructure, not just an ETL tool.

*Talk track:* This gives you something to lead with in AI conversations instead of reacting to them.

---

## 9. Example use cases (pick 2–3 to show)

- **On-demand dataset assembly:** an agent builds a fit-for-purpose table from scattered sources in minutes.
- **Continuous refresh crawling:** the agent re-acquires and re-cleans as sources change.
- **AI pipeline feedstock:** Prep supplies clean, governed data to downstream AI/analytics steps.

*Talk track:* Tie each to a customer segment you actually work: [PLACEHOLDER: name the vertical/customer type].

---

## 10. Proof / status

- Current state: [PLACEHOLDER: prototype / internal pilot / GA target].
- Validated so far: [PLACEHOLDER: what you've actually run — e.g., headless flow invoked by an agent through the gateway].
- Reliability: engineered for stable, complete responses under load (early integration work resolved response-truncation issues in the agent transport layer).

*Talk track:* Be honest about maturity — SE audiences trust candor. State what's real today vs. roadmap.

---

## 11. The bigger picture — future AI integration

Agentic Prep is the first proof point of a pattern: **Tableau capabilities exposed as agentic skills.** Prep today; the same interoperability model extends to more of the platform tomorrow.

*Talk track:* We're not shipping one feature. We're demonstrating how Tableau becomes composable inside the agentic era.

---

## 12. Call to action

- **SEs:** learn the demo, bring it to AI-readiness conversations.
- **Feedback:** tell us which customer scenarios need this most.
- **Next:** [PLACEHOLDER: enablement session date / demo environment link / point of contact].

*Talk track:* End on the ask. What do you want this room to *do* Monday morning?

---

### Appendix (optional slides)
- **A1. How it fits an agent stack** — simple diagram: Agent → (skill call) → Headless Prep → clean data → Tableau/AI downstream.
- **A2. Governance & trust** — where lineage, permissions, and control live.
- **A3. FAQ** — "Does this replace Prep flows?" (No — it invokes them.) "Which agents work?" (Any that speak the standard interop surfaces.)
