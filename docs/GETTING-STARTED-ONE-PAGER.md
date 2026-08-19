# Meet Your Slack Data Assistant — Getting Started

**A one-page guide for everyone.** No setup, no new tool to learn — it lives in Slack.

> **How to use this in Google Docs:** Copy everything below the line into a new Google Doc
> (Edit → Paste). It's designed to fit on roughly one to two pages.

---

## What it is

An AI assistant, powered by Claude, that answers questions **inside Slack** using your team's
**Slack conversations** and your **Tableau data**. Ask in plain English — it finds the data, runs the
query, and answers with real numbers. It can also write polished, multi-section reports ("canvases")
with Tableau charts embedded right in them.

## Why it helps

- **Answers from real data, not guesses.** It queries live Tableau and tells you which data source it
  used — so you can trust the number.
- **No dashboards to hunt through.** Ask the question; get the answer (and a chart if you want one).
- **Turns questions into documents.** "Write me a brief on this" produces a shareable, sectioned
  report — in seconds, not an afternoon.
- **Catches you up.** "Summarize this thread" or "find where we discussed the outage" without
  scrolling.

---

## Three ways to use it

1. **Mention it in a channel** — type `@` and the assistant's name with your question. It replies in
   the thread, so the whole channel benefits.
2. **Open it as an Assistant (side panel / direct message)** — a private space to ask questions and
   iterate, just for you.
3. **Use it in a Workflow (the "Ask AI" step)** — bake it into an automated Slack workflow so it
   answers or drafts on a trigger, no typing required.

---

## Try these prompts

**Ask for a number (it queries Tableau live):**
- "What were total sales and profit by region?" *(Superstore sample data)*
- "What's the total value of grants awarded? Which data source did you use?" *(OTF Grants)*
- "How much has the Army obligated in contract spending, and to which top vendors?" *(Army Spending)*
- "Show me pipeline incident counts by state." *(PHMSA Pipeline Incidents)*
- "Compare planned vs. actual business travel cost and show the variance." *(Business Travel Cost)*

**Ask for a picture:**
- "Show me a chart of wildfire activity and post it here." *(US Wildfires)*
- "Pull up the dashboard for cyber incidents over the last decade and drop the image in this thread."

**Ask for a document (it writes a canvas):**
- "Write a two-page executive brief on grant program performance this quarter, with sections and a
  summary."
- "Draft an analysis of Russian equipment losses over time and put it in a canvas."

**Catch up on Slack:**
- "Summarize this thread in five bullets."
- "Find messages where someone mentioned the budget freeze."

*Tip: if several data sources could match, it will ask you which one you mean — or you can name it
directly ("use the OTF Grants Enriched source").*

---

## Data sources it works especially well with

These published Tableau sources have clean, readable field names, so the assistant queries them
reliably. (Your administrator can point it at others.)

| Data source | Good for asking about |
|---|---|
| **Sample – Superstore** | Sales, profit, discount by region/category (great for a demo) |
| **OTF Grants Enriched** | Grant awards, amounts applied and approved |
| **Army Spending Data** | Federal contract obligations, vendors, agencies |
| **PHMSA Pipeline Incidents** | Pipeline safety incidents, locations, counts |
| **Business Travel Cost Analysis** | Planned vs. actual travel spend and variance |
| **US Wildfires (EOC Enriched)** | Wildfire activity, geography, response |
| **Russian Equipment Losses** | Equipment-loss trends over time |
| **Cyber Incidents 2014–2024** | Cyber incident counts by type and category |

---

## Good to know

- **It tells you its source.** For data questions it names the Tableau data source it used — ask it
  to, if it doesn't.
- **It respects your access.** It answers from the Slack context and Tableau connection you're
  entitled to; it doesn't invent figures when it lacks the data — it says so.
- **Reports go to canvases.** Long answers become a proper document you can share and edit, with
  charts embedded — not a wall of text in the chat.
- **Be specific for best results.** Include the metric, the time range, and the data source if you
  know it ("total *approved* grant amount for *last quarter* from *OTF Grants Enriched*").

---

## Getting access

If you can't see the assistant yet, you may need to **install/authorize it** so it can act on your
behalf (this is what lets it read the channels you're in and create canvases as you). Ask your Slack
workspace admin, or use the install link they provide.

*Questions or ideas for new data sources to connect? Contact [PLACEHOLDER: your team/owner].*
