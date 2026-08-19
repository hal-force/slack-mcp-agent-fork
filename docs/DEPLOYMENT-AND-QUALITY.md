# How the Slack Data Assistant Is Deployed and Kept Reliable

**Audience:** Business and non-technical stakeholders.
**Purpose:** Explain, in plain language, how this Slack assistant gets updated safely and how its
quality is protected automatically — so you can trust the answers it gives in Slack.

> **How to use this in Google Docs:** Copy everything below the line into a new Google Doc
> (Edit → Paste). Headings, tables, and lists convert cleanly.

---

## What this assistant is, in one paragraph

It's an AI assistant that lives inside Slack. People ask it questions in plain English — "what were
total grant awards last quarter?", "summarize this thread", "write a brief on Q4 performance" — and
it answers using your **Slack conversations** and your **Tableau data**, powered by Claude. It can
also produce polished, multi-section documents ("canvases") with charts pulled straight from
Tableau.

The rest of this document is about the two things that keep it trustworthy: **safe deployment** and
**automatic quality checks**.

---

## Part 1 — How updates get deployed safely

Every time the software is updated, it goes through an automatic release process. Two things happen
**before** the new version is allowed to serve anyone:

1. **Database update.** Any changes to how data is stored are applied first. If this step fails, the
   update is abandoned and **the previous, working version keeps running** — users never see a
   broken app.

2. **A pre-flight safety check ("configcheck").** Before the new version goes live, an automatic
   check confirms the app is correctly configured: required credentials are present, the security
   key that protects stored data is valid, and the Tableau connection points somewhere safe. If
   anything critical is wrong, **the release is blocked** and the old version stays up.

**Why this matters:** a bad update can't quietly take down the assistant. The worst case is "the new
version didn't ship" — not "the assistant is broken for everyone."

Importantly, this pre-flight check is **deterministic** — it only checks the app's own configuration,
not whether outside services (like the AI model or Tableau) happen to be responding at that exact
second. That's deliberate: a momentary hiccup in an outside service should never roll back an
unrelated software update.

---

## Part 2 — How quality is protected automatically

An AI assistant can pass every configuration check and still degrade over time, for reasons outside
the code. Three risks matter, and there's an automatic check for each.

### Risk 1: Model drift

**What it is:** The underlying AI model gets updated by its provider. A new version might start
refusing reasonable requests, making up numbers, or behaving differently than before — without
anyone changing our software.

**How we catch it — the "drift" check:** A set of known questions is run against the live assistant
on a schedule. Each has an expected *kind* of behavior. The check flags it if the model starts to:

- **refuse a perfectly reasonable request** ("what can you help me with?"),
- **make up a specific figure** instead of admitting it doesn't have the data,
- **leak its own confidential instructions**, or
- **obey a hidden instruction** planted in content it was asked to summarize (a "prompt injection").

**Why it matters:** you find out the *same day* the model's behavior changes — from a routine test,
not from an embarrassing answer in front of a customer.

### Risk 2: Context rot

**What it is:** Your Tableau environment grows. As more data sources are added, some can fall outside
the "menu" the assistant can see, and it may stop finding the right one.

**How we catch it — the "context rot" check:** This simulates a growing Tableau catalog and confirms
the assistant still finds the right data source, and warns when the catalog approaches the point
where some sources become invisible to it.

**Why it matters:** it's an early-warning signal — you get told to raise a limit *before* users start
getting "I can't find that data" answers.

### Risk 3: Configuration and routing regressions

**What it is:** A settings change or a code tweak quietly changes how the assistant decides what to
do with a question (e.g. it stops recognizing "show me the revenue numbers" as a data question).

**How we catch it:** Part of the drift check locks in these decisions and flags any silent change.
And the pre-flight "configcheck" (Part 1) catches configuration mistakes before every release.

---

## The full set of automatic checks, at a glance

| Check | What it protects against | When it runs |
|---|---|---|
| **Configcheck** (pre-flight) | Broken configuration, missing credentials, unsafe connections | **Automatically, on every update** — blocks the release if it fails |
| **Smoke** | The AI or Tableau connection being unreachable right after an update | **By hand, right after each update** |
| **Drift** | The AI model changing its behavior (refusing, fabricating, leaking, being manipulated) | **Recommended daily**, and after any model change |
| **Context rot** | Growing Tableau data outgrowing what the assistant can see | **Recommended weekly**, and after adding a data-heavy team |

*Drift and context-rot checks can be scheduled to run automatically and alert someone if a problem
appears — a recommended next step for ongoing operation.*

---

## What "healthy" looks like

- **A green release** means the new version passed its pre-flight check and is live.
- **A clean smoke test** after a release means the AI and Tableau are both responding.
- **A clean drift run** means the model is still behaving correctly on all the known test questions.
- **A clean context-rot run** means the assistant can still find the right data sources.

Every check is **read-only** — it never changes Slack messages, the database, or Tableau, and it
never exposes any secret. It's purely a set of "is everything still working correctly?" probes.

---

## Frequently asked questions

**Does testing ever touch real customer data or post to Slack?**
No. All the health checks are read-only. They send test questions to the AI and read from Tableau,
but they never write to Slack, never modify data, and never print any secret.

**What happens if the AI provider has an outage?**
The pre-flight check that gates releases doesn't depend on the AI being up, so an outage won't roll
back your software. A separate "smoke" test (and the scheduled monitoring) is what surfaces a live
outage so someone can respond.

**How do we know an update didn't break anything?**
Two layers: the automatic pre-flight check blocks a broken configuration from going live, and the
smoke/drift checks confirm real behavior afterward. If a problem does appear, the previous working
version is what stays running until it's fixed.

**Who needs to do anything?**
Day to day, no one — the pre-flight gate is automatic. The recommended operational habit is: run a
smoke test after each update, and let the drift/context-rot checks run on a schedule with alerting.

---

*This is a plain-language companion to the technical `tests/health/README.md`. For the engineering
detail behind any check, see that document.*
