# What Changed: Prism Slack Agent vs. the Original Open-Source Project

**Audience:** Technical reviewers and technical leadership.
**Purpose:** A single reference for how this deployment differs from the open-source
project it was forked from, and why each change was made.

> **How to use this in Google Docs:** Copy everything below the line into a new Google
> Doc (Edit → Paste). The headings, tables, and lists convert cleanly. Replace any
> `[PLACEHOLDER]` values with your environment's specifics before sharing widely.

---

## Summary

This app is a fork of the open-source **`itsnaseer/slack-mcp-agent`** — a Slack assistant that
answers questions in Slack, grounded in Slack conversation history and (optionally) in a
Tableau server through the Model Context Protocol (MCP).

The original is a solid starting point. This fork turned it into a **hardened, Tableau-focused,
production-style deployment** — and then extended it from a *reactive* question-answering assistant
into one that also delivers **proactive, role-targeted briefs** and coordinates **role-specialized
agents**. Across **26 commits** (~35,800 lines added, ~700 removed, 155 files), the changes fall into
eight themes:

1. **A pluggable LLM backend** — run on AWS Bedrock (Claude), an internal gateway, or Google Vertex/Gemini.
2. **A live Tableau tool-calling loop** — the assistant actually queries Tableau mid-answer, not just from a pre-fetched snapshot.
3. **Higher-quality reports** — long-form answers become real multi-section Slack canvases, with Tableau charts embedded inline.
4. **Security hardening** — token encryption at rest, an SSRF guard, prompt-injection defenses, and per-user access scoping.
5. **A health-check framework** — automated quality gates at deploy time and on an ongoing schedule.
6. **Reliability and correctness fixes** — response truncation, datasource discovery, canvas errors, and a database-TLS outage.
7. **Proactive, localized briefs** — a scheduled/event-driven job that DMs each user only the metrics they own for their facility, with the "so-what" and the metric's Tableau chart attached.
8. **Multi-agent scaffolding** — a reusable `defineAgent` primitive, a flag-gated supervisor, and a first role-specialized **Triage Specialist** with an in-repo evaluation harness.

The reference deployment (`damp-wave-30118`) runs the **AWS Bedrock / Claude Sonnet** backend. Themes
1–6 are the hardened chat/canvas assistant; themes 7–8 (the partner package) run behind their own
env flags and triggers and do not change the baseline chat behavior.

---

## 1. Pluggable LLM backend (Claude on AWS Bedrock)

**Original:** replies were generated exclusively by **Google Vertex AI (Gemini)**.

**This fork:** a provider abstraction (`src/assistant/llmProvider.js`) fronts **three** backends
behind one call, selected by the `AI_PROVIDER` setting:

| Backend | What it is | Notes |
|---|---|---|
| **`bedrock`** | AWS Bedrock serving **Claude** natively (Converse API) | **Production default here.** Reachable from public cloud hosts; supports a long-term Bedrock API key with no session-expiry churn. |
| **`gateway`** | Any OpenAI-compatible `/v1/chat/completions` endpoint (e.g. an internal gateway serving Claude) | Used where an internal gateway is reachable. |
| **`vertex`** | Google Vertex AI / Gemini (the original backend) | Code default and the automatic fallback. |

**Why it matters:** it lets the same app run on **Claude** (the target model for this work) while
staying portable across hosting environments. A backend that is selected but incompletely
configured **safely falls back to Vertex**, so a misconfiguration can never silently break replies.

The Bedrock path also handles newer Claude models that reject the `temperature` parameter
(it strips it and retries once, with no per-model hardcoding).

---

## 2. Live Tableau tool-calling loop

**Original:** Tableau context was a **pre-fetched snapshot** attached to the prompt — the model
could see a catalog sample but could not *act* on Tableau during the reply.

**This fork:** the Bedrock path runs a real **agentic tool-use loop**. The model can call, in
sequence and as needed:

- `list-datasources` (with an optional name filter),
- `get-datasource-metadata` (to learn the exact field names before querying),
- `query-datasource` (a precise VizQL query with aggregations and filters),
- `list-views` / `get-view-image` (to render and post a dashboard image).

It keeps servicing tool calls until it produces a final answer (capped at
`BEDROCK_MAX_TOOL_ROUNDS`, default 10). Verified live against a federal Tableau server with
**223 data sources**.

**Why it matters:** the assistant can answer "what was the exact total grant award last quarter?"
by *querying the live data and citing the source*, instead of guessing from a static sample.

---

## 3. Higher-quality reports and canvases

- **Long-form reports route to a Slack canvas.** A request like "write a three-page brief on Q4
  performance" now produces a real multi-section document (executive summary + titled sections +
  interpretation), not a terse chat reply. A depth-aware system prompt closes the quality gap with
  a full chat product.
- **Tableau visualizations embed *inline* in canvases.** Rendered Tableau view images now appear as
  images inside the canvas (previously they showed as plain links, or not at all).
- **Canvases get a real title.** Each generated canvas is given a concise title as its leading
  heading.

**Why it matters:** the deliverable a business user receives is a polished, shareable document with
charts — not a wall of numbers.

---

## 4. Security hardening

A security/efficiency audit and a follow-up code review were remediated in this fork:

| Area | Hardening |
|---|---|
| **Tokens at rest** | Slack OAuth tokens (`xoxb`/`xoxp`) are **encrypted with AES-256-GCM** (`TOKEN_ENC_KEY`). A leaked database, backup, or export no longer exposes usable tokens. A *malformed* key **fails loud** rather than silently downgrading to plaintext. |
| **SSRF guard** | The Tableau MCP URL is user-settable from App Home. An SSRF guard (`src/assistant/urlSafety.js`) blocks non-HTTPS schemes, loopback/private/link-local IPs, and the cloud metadata endpoint — closing the classic "make the server fetch an internal target" attack. |
| **Prompt-injection fencing** | Untrusted content (Slack/Tableau/web) is fenced and labeled as data. Thread history from *other* users is treated as untrusted rather than replayed as authoritative instructions, so a planted message in a shared thread can't hijack the assistant. |
| **Per-user / per-tenant scoping** | Each authorizing user gets their own stored token; the user-name cache is scoped per tenant so a colliding Slack user id can't leak another workspace's data. |

**Why it matters:** this is the difference between a demo and something you can point at real
workspace data.

---

## 5. Health-check framework (automated quality)

**Original:** no test/health framework.

**This fork:** a single harness (`tests/health/`) with two jobs — a deploy-time gate and ongoing
monitoring — plus a full offline unit-test suite. In plain terms:

- **`configcheck`** — a fast, network-free check wired into the **Heroku release phase**. It
  **blocks a bad deploy** on a real misconfiguration (missing secret, malformed encryption key,
  unsafe Tableau URL, silent backend fallback). It deliberately does *not* depend on external
  services being up, so a transient outage can't roll back an unrelated deploy.
- **`smoke`** — configcheck plus live "is the LLM reachable / is Tableau reachable" pings; run by
  hand after a deploy.
- **`drift`** — catches **model drift**: a new model version that starts refusing benign requests,
  fabricating figures, leaking the system prompt, or obeying injected instructions.
- **`contextrot`** — catches **context rot**: as a Tableau site grows, the check flags when data
  sources start falling outside what the model can see.

The framework's own judgement logic is unit-tested, so the rules that decide "is this healthy?"
can't silently drift either. Full detail: [`tests/health/README.md`](../tests/health/README.md).

**Why it matters:** quality is protected automatically — at deploy time and continuously — rather
than discovered through user complaints.

---

## 6. Reliability and correctness fixes

| Fix | Symptom it resolved |
|---|---|
| **MCP response de-truncation** | Large Tableau/Slack tool results were parsed incorrectly when split across network chunks, silently dropping context. Added bounded retries on transient errors. |
| **Datasource discovery (v4 shape)** | The Tableau server's response format changed; the app parsed **0** of 223 data sources, so named sources like "OTF Grants Enriched" couldn't be found. Fixed the parser and made the catalog far more token-efficient. |
| **Discovery truncation → wrong source** | A 32 KB cap could hide the authoritative grant dataset, causing answers grounded in a *secondary* dataset. Added a name filter and a self-correcting warning to the model. |
| **Slack message truncation** | Long reports were silently cut off at Slack's 50-block limit. Now packed to fit, with a **visible** "message truncated — open the canvas" notice on genuine overflow. |
| **Canvas "invalid canvas_id"** | A fiscal-year code like "FY2024Q1" was mistaken for a canvas id, breaking report requests. Tightened the id pattern. |
| **Database TLS outage** | Strict DB certificate verification against Amazon Aurora failed (its CA isn't in the default trust store), and **the whole agent went unresponsive** — every login lookup failed. Resolved with a two-tier pattern: ship the RDS CA bundle in production (`PGSSLROOTCERT`); use a reversible escape hatch (`DATABASE_SSL_NO_VERIFY=1`) for the demo. See [`certs/README.md`](../certs/README.md). |

---

## 7. Proactive, localized VHA brief (scheduled + event-driven)

**Original:** the assistant was purely **reactive** — it answered when asked. Nothing reached out.

**This fork:** a proactive briefing job (`src/jobs/vhaDailyBrief.js`) that delivers each user a DM
containing **only the metrics they own, for their facility**, with a short "so-what" and the metric's
Tableau chart attached. Every brief is a function of three independently-resolved inputs:

- **TRIGGER — what fired.** Either a scheduled **daily scan** of flagged metrics (Heroku Scheduler)
  or a reactive **datasource-refresh webhook** — Tableau Cloud pushes the app the moment new snapshot
  data lands, which is the natural instant to (re)brief. A third path handles an inbound alert naming
  a specific metric.
- **POSITION — which metrics the user owns.** The user's Slack role/title maps to the metric
  registry's owning functions, so a Quality Manager gets mortality + length-of-stay, an Access
  Manager gets capacity, and a Director gets the whole facility. This is what turns a metric *dump*
  into a role-relevant nudge.
- **LOCATION — which facility.** Inferred from Slack timezone + identity (with an explicit binding
  override for named users).

**Per-metric Tableau views** (newest): each flagged metric section carries its own
"Metric Target Select" view from a published Tableau workbook — an always-present *"Open in Tableau"*
deep link plus a **rendered PNG** fetched via the `get-view-image` MCP tool and uploaded in a thread
beneath the DM. View resolution is sequential (single-PAT-safe) and non-fatal: if a chart can't be
rendered, the text brief and link still deliver. A single facility-filter hook (`viewFiltersForFacility`)
is the one place to extend when the views gain a per-facility parameter.

**Reliability details that make it safe to run unattended:**

- **Durable, per-metric dedupe.** A Postgres ledger (`BriefDelivery`) records what was delivered.
  A metric is re-sent only when it's **new or has worsened** (a content signature over its status /
  value / change changed); an unchanged metric is suppressed. Rows are marked sent **only after a
  successful DM**, so a failed post retries next run. It survives dyno restarts and is **fail-open**
  — if the database is unavailable, briefs still deliver.
- **Injection fencing carried through.** Untrusted action-plan free text stays inside the same
  injection-fenced context path as the chat assistant, so a planted instruction in a plan note can't
  hijack the brief.

**Why it matters:** this is the shift from "ask and receive" to "the right person is told the one
thing that changed, in their lane, with the chart — automatically."

---

## 8. Multi-agent scaffolding + Triage Specialist (evaluation-backed)

**Original:** a single reasoning call answered every message.

**This fork:** a reusable **`defineAgent`** primitive and a lightweight **supervisor**
(`src/agents/`), both **flag-gated (`AGENTS_ENABLED`, default off)** so the baseline single-call path
is untouched when the flag is off. The first role-specialized agent built on it is a **Triage
Specialist**: given a newly-admitted (synthetic) patient, it produces a ranked nurse recommendation
justified by skill fit and current workload, with a deterministic "why this pick" rationale, posted
as a Slack card into an operations channel behind a secret-gated trigger.

What makes this more than a demo is that its **analytical** quality is **objectively measured**. A
self-contained evaluation harness (`tests/eval/triage/`) grades the specialist against a fixture with
a **quarantined answer key** — the agent under test structurally never sees the ground truth (planted
effects, magnitudes, and rubric live in a separate directory read only by the scorer). This is the
concrete first step of a broader role-specialized-agent roadmap; the same primitive is intended to be
reused by later specialists.

**Why it matters:** it establishes a pattern for adding specialized, *measurable* agent capabilities
without destabilizing the general assistant — new behavior ships behind a flag and is proven against a
known answer key before it's trusted.

---

## Commit-level appendix (for engineers)

Fork point: upstream `95e2829`. Newest first.

| Commit | Summary |
|---|---|
| `e7986c5` | VHA brief: attach per-metric Tableau views (deep link + rendered PNG) |
| `418ac51` | Triage card: deterministic "why this pick" rationale on the recommendation |
| `f3c970f` | Triage specialist (M4): repointed onto published Tableau datasources via MCP |
| `e3dc103` | Triage (M3): admission → operations-channel recommendation card, secret-gated trigger |
| `f5a1c7b` | Multi-agent (M2): triage specialist (analysis + recommendation) + eval harness |
| `8cadaaf` | Multi-agent (M1): `defineAgent` primitive + flag-gated supervisor (baseline-neutral) |
| `33c2d60` | AWS partner package: containerized deploy + Terraform + daily-brief trigger |
| `a64e1c3` | Bedrock tool-loop safety-valve fix + `--daily` scheduler entry point |
| `1d944c6` | VHA localized brief: (trigger × position × location) + refresh webhook + durable dedupe |
| `7c31219` | Remove dead root `installationStore.js`; add RDS CA bundle for prod TLS |
| `5106adb` | Surface reply preview on drift-check failures (adjudication aid) |
| `711633d` | Fix two negation-blind golden drift checks (false positives) |
| `99e44b9` | Add deterministic `configcheck` gate to the release phase |
| `12f3b4b` | Security hardening (audit + review) + health-check framework |
| `6d84f0a` | Fix silent Slack message truncation at the 50-block ceiling |
| `e17da23` | Extract `titledCanvasMarkdown` helper for deterministic testing |
| `0dd1b18` | Fix canvas image rendering + auto-title canvases |
| `1b94b87` | Fix datasource-discovery truncation + embed Tableau images into canvases |
| `46e1e87` | Fix Canvas "invalid canvas_id" error on report requests |
| `43e0432` | Fix Sonnet temperature rejection + narrow the credential error |
| `9b66ee3` | Long-form reports: route to Canvas + depth-aware system prompt |
| `e7d0c67` | Enable live Tableau MCP tool calling on the Bedrock path |
| `ac65cd1` | Fix Tableau datasource discovery: parse v4 catalog shape + shrink context |
| `c13e0a2` | Fix Tableau MCP gating: fall back to host default when no per-user override |
| `cf33333` | Add AWS Bedrock (Claude) as a third LLM backend |
| `ea31311` | Fix MCP response truncation/flakiness; add Claude-via-gateway backend |

*Generated as part of a documentation refresh. Verify the deployment specifics
(`[PLACEHOLDER]` app name, model id) against your environment before external distribution.*
