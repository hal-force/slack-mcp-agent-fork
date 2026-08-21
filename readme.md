# slack-mcp-agent

## Overview

slack-mcp-agent is a Slack app built with the Bolt framework and Prisma for database management. It supports multi-workspace installation via OAuth and stores installation data in PostgreSQL. The assistant grounds replies in **Slack context** (via the Slack MCP server or Web API) and optional **Tableau context** from a Tableau MCP server (`TABLEAU_MCP_SERVER`).

> **This fork.** This repository is a hardened, Tableau-focused fork of
> [`itsnaseer/slack-mcp-agent`](https://github.com/itsnaseer/slack-mcp-agent). It adds a
> **pluggable LLM backend** (AWS Bedrock / Claude, an OpenAI-compatible gateway, or Vertex/Gemini),
> a **live Tableau MCP tool-calling loop**, **Slack canvas reports** with embedded Tableau
> visualizations, **security hardening** (token encryption at rest, an SSRF guard, prompt-injection
> fencing, per-user token scoping), and a **health-check framework** with a deterministic
> release-phase gate. See [`docs/CHANGES-VS-UPSTREAM.md`](docs/CHANGES-VS-UPSTREAM.md) for the full
> list of differences. The reference deployment (`damp-wave-30118`) runs **AWS Bedrock / Claude
> Sonnet** as its LLM backend.

### Production architecture (reference deployment)

| Layer | What the reference deployment runs |
|---|---|
| **LLM backend** | AWS **Bedrock / Claude Sonnet** (`AI_PROVIDER=bedrock`). The provider layer (`src/assistant/llmProvider.js`) also supports an OpenAI-compatible **gateway** and **Vertex/Gemini**; an incomplete non-Vertex config safely falls back to Vertex. |
| **Analytics** | **Tableau MCP** over Streamable HTTP, with a real agentic **tool-calling loop** (`list-datasources`, `get-datasource-metadata`, `query-datasource`, `list-views`, `get-view-image`). |
| **Deliverables** | Slack **canvases** (multi-section documents) with **inline Tableau view images**, driven by the installing user's OAuth token. |
| **Security** | OAuth **tokens encrypted at rest** (AES-256-GCM), **SSRF guard** on outbound MCP URLs, **prompt-injection fencing** of untrusted context, **per-user token scoping**. |
| **Quality gates** | A network-free **`configcheck`** health suite runs in the Heroku **release phase** and fails the deploy on a real misconfiguration; **smoke / drift / contextrot** suites run by hand and on a schedule. |
| **Database** | Amazon Aurora/RDS Postgres via the Prisma `pg` adapter, TLS-encrypted. See [Database TLS](#database-tls-rdsaurora) below. |
| **Proactive briefs** | A scheduled + webhook-driven job DMs each user only the metrics they own for their facility, with the "so-what" and the metric's Tableau chart attached. Behind its own env config. See [Proactive & multi-agent capabilities](#proactive--multi-agent-capabilities-partner-package). |
| **Multi-agent** | A reusable `defineAgent` primitive + flag-gated supervisor, with a first role-specialized **Triage Specialist** and an in-repo evaluation harness. Off by default (`AGENTS_ENABLED`). |

## Features

- **Prisma + PostgreSQL**: Installations and tokens persisted with the Prisma PostgreSQL adapter.
- **Configuration**: Environment variables via dotenv (local) and config vars (e.g. Heroku).
- **Slack Bolt**: OAuth v2 install flow, installation store, **@mentions** in channels and **Assistant** threads (side panel / DM), and a **Workflow Builder** custom step **Ask AI** (default callback id `9dec78` in code; override with env) that returns a Slack mrkdwn string for downstream steps.
- **Pluggable LLM backend** (`src/assistant/llmProvider.js`): one `generateReply()` call fronts three backends — **`bedrock`** (AWS Bedrock / Claude, the production default on the reference deployment), **`gateway`** (any OpenAI-compatible `/v1/chat/completions` endpoint), and **`vertex`** (Vertex AI / Gemini). Select with `AI_PROVIDER`; an incomplete gateway/bedrock config falls back to Vertex so a misconfiguration never silently breaks replies. The Bedrock path runs a real agentic **tool-calling loop** (Converse API) so the model can call Tableau MCP tools mid-reply. System prompt tuned for Slack mrkdwn, Slack/Tableau context, report depth, and canvas behavior.
- **Security hardening**: OAuth tokens **encrypted at rest** (AES-256-GCM, `src/install-kit/tokenCrypto.js`; optional **fail-closed** enforcement via `REQUIRE_TOKEN_ENC`), an **SSRF guard** on the user-settable Tableau MCP URL (`src/assistant/urlSafety.js`), **prompt-injection fencing** of untrusted Slack/Tableau/web context, **per-user token scoping** in the installation store, defensive **HTTP security headers** and **per-IP rate limiting** on the secret-in-path trigger routes (`src/install-kit/httpSecurity.js`), and **bounded LLM request timeouts**.
- **Health-check framework** (`tests/health/`): a `configcheck` deterministic gate (wired into the Heroku release phase), plus `smoke` / `drift` / `contextrot` suites for post-deploy readiness and ongoing model-drift / context-rot monitoring. See [`tests/health/README.md`](tests/health/README.md).
- **Slack context**: Builds grounding context from the **Slack MCP** server (`mcp.slack.com`, Streamable HTTP + session) when a **user token** is present, with **Web API** fallback for channel/thread history and search. Requires MCP enabled for the Slack app under Agents & AI Apps when using MCP.
- **Tableau MCP** (optional): When `TABLEAU_MCP_SERVER` is set, injects compact tool names, can call `list-datasources`, matches user/thread intent for analytics, fetches **`get-datasource-metadata`** when a published source matches, and respects `TABLEAU_MCP_LIST_DATASOURCES` / `TABLEAU_MCP_VERBOSE_TOOLS`.
- **Slack canvases** (user token): Gemini **function calling** drives `slack_canvas_create`, `slack_canvas_read`, and `slack_canvas_update` using the installing user’s **`xoxp`** token (`canvases:read` / `canvases:write`). Supports **create**, **read** (section outline via `canvases.sections.lookup`), and **update** modes: append end, insert start, replace whole document, and **section-targeted** `insert_after` / `insert_before` / `replace_section` using `section_id` from read. Tool results include **`canvas_url`** and **`slack_mrkdwn_link_example`** (`https://app.slack.com/client/{team}/{canvas}`) so replies can use `<URL|label>` links. Canvas **delete** is not exposed.
- **Model routing**: Routes conversational queries to a faster model (`GEMINI_FAST_MODEL`) and tool-heavy or analytics queries to the full model (`GEMINI_MODEL`), balancing speed and reasoning quality per request.

### Agent Skills

The assistant exposes the following skills via the model's tool/function calling (Bedrock Converse tools on the production path; Gemini function calling on the Vertex path):

| Skill | Tools | When used |
|---|---|---|
| **Slack canvas — create** | `slack_canvas_create` | User asks to create a new canvas or doc |
| **Slack canvas — read** | `slack_canvas_read` | User asks to inspect, list sections, or locate a canvas |
| **Slack canvas — update** | `slack_canvas_update` | User asks to edit, append, or rewrite a canvas section |
| **Tableau datasource list** | `tableau_list_datasources` | Message or thread looks analytics-related; returns published source names and LUIDs |
| **Tableau datasource metadata** | `tableau_get_datasource_metadata` | A datasource name matches the user’s message; returns exact field captions for queries |
| **Tableau view list** | `tableau_list_views` | User asks for a dashboard, chart, or visual; supports REST filter on name/workbook |
| **Tableau view image** | `tableau_get_view_image` | After locating a view; renders a PNG/SVG snapshot uploaded to the Slack thread |
| **Tableau data query** | `tableau_query_datasource` | User asks for precise numbers; executes a VizQL query with aggregations and filters |

Canvas skills require a user OAuth token (`xoxp`). Tableau skills require `TABLEAU_MCP_SERVER` to be configured. The model selects and chains tools automatically across multiple rounds per message (Bedrock: up to `BEDROCK_MAX_TOOL_ROUNDS`, default 10, after which it is asked for a final answer with tools disabled).

### Proactive & multi-agent capabilities (partner package)

Beyond the reactive chat/canvas assistant above, this fork adds two opt-in capability sets that run behind their own env flags and triggers. They **do not change the baseline @mention / Assistant / Workflow behavior** — when their flags/triggers are unset, the app behaves exactly as documented above.

**Proactive localized brief** (`src/jobs/vhaDailyBrief.js`). A job that DMs each user only the metrics they own, for their facility, with a short "so-what" and the metric's Tableau chart attached. Each brief is a function of three independently-resolved inputs:

- **TRIGGER** — a scheduled daily **scan** (Heroku Scheduler), a Tableau **datasource-refresh webhook** (`POST /webhooks/tableau/refresh/:secret`, `src/jobs/tableauWebhook.js` — fires the moment new data lands), or an inbound **alert** naming a metric.
- **POSITION** — the user's Slack role/title → the metric registry's owning functions (a Quality Manager sees mortality/LOS; a Director sees the whole facility). Turns a metric dump into a role-relevant nudge.
- **LOCATION** — the facility, from Slack timezone + identity, with an explicit `VHA_BRIEF_BINDINGS` override for named users.

Each flagged metric section carries its Tableau view (`src/jobs/vhaMetricViews.js`): an always-present *"Open in Tableau"* deep link plus a rendered PNG (via the `get-view-image` MCP tool) uploaded in a thread beneath the DM. View resolution is **non-fatal** — the text brief and link still deliver if a chart can't render. Delivery is **deduped durably** per metric via a Postgres `BriefDelivery` ledger: a metric re-posts only when it's new or has worsened; the ledger is fail-open (briefs still deliver if the DB is down). See [`demo-data/vha/DAILY-BRIEF-DESIGN.md`](demo-data/vha/DAILY-BRIEF-DESIGN.md). Requires `im:write` (DM) and `files:write` (chart upload) bot scopes.

**Multi-agent scaffolding** (`src/agents/`). A reusable `defineAgent` primitive and a lightweight supervisor, **flag-gated by `AGENTS_ENABLED` (default off)**. The first role-specialized agent is a **Triage Specialist** that produces a ranked, workload-aware nurse recommendation (with a deterministic "why this pick" rationale) as a Slack card, behind a secret-gated trigger. Its analytical quality is measured by an in-repo evaluation harness (`tests/eval/triage/`) against a fixture whose answer key is **structurally quarantined** from the agent under test. See [`docs/MULTI-AGENT-TRIAGE-DESIGN.md`](docs/MULTI-AGENT-TRIAGE-DESIGN.md).

---

### Prerequisites

- Node.js 20.x
- PostgreSQL (running)
- A Slack app in the [Slack API](https://api.slack.com/apps) dashboard

### Database setup

1. Create a database:
   ```bash
   createdb slack-mcp-agent
   ```
   Or with psql:
   ```sql
   CREATE DATABASE "slack-mcp-agent";
   ```
2. Set `DATABASE_URL` in `.env` to point to this database.

### Installation

1. Clone and enter the repo:
   ```bash
   git clone <repository-url>
   cd slack-mcp-agent
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure `.env` with:
   ```plaintext
   DATABASE_URL=your_database_url
   SLACK_SIGNING_SECRET=your_slack_signing_secret
   SLACK_CLIENT_ID=your_slack_client_id
   SLACK_CLIENT_SECRET=your_slack_client_secret
   SLACK_STATE_SECRET=your_slack_state_secret
   # Scopes: use separate bot/user or legacy single list
   SLACK_BOT_SCOPES=app_mentions:read,chat:write,files:write,...
   SLACK_USER_SCOPES=users:read.email,...
   # Or legacy: SLACK_SCOPES=app_mentions:read,chat:write,...

   # LLM backend – pick ONE (see "LLM backends" below). Falls back to vertex if incomplete.
   AI_PROVIDER=bedrock            # bedrock | gateway | vertex (unset = vertex)

   # bedrock (production default on the reference deployment)
   BEDROCK_MODEL_ID=your-claude-sonnet-model-id
   BEDROCK_REGION=us-west-2
   AWS_BEARER_TOKEN_BEDROCK=ABSK...   # long-term Bedrock API key (or use AWS_ACCESS_KEY_ID/_SECRET/_SESSION)

   # vertex (code default / fallback) – required if AI_PROVIDER is unset
   GOOGLE_CLOUD_PROJECT=your-gcp-project-id
   VERTEX_LOCATION=us-central1
   GEMINI_MODEL=gemini-2.5-flash

   # Security (recommended in any shared/prod environment)
   TOKEN_ENC_KEY=            # `openssl rand -base64 32` – encrypts OAuth tokens at rest
   # REQUIRE_TOKEN_ENC=1     # fail closed: refuse installs if TOKEN_ENC_KEY is unset (prod)

   # Tableau MCP (optional) – streamable HTTP endpoint, e.g.:
   # TABLEAU_MCP_SERVER=https://<your-tableau-mcp-host>/tableau-mcp
   # TABLEAU_MCP_LIST_DATASOURCES=1   # always try to attach a datasource catalog sample (noisier)
   # TABLEAU_DATASOURCE_BROWSE_URL_TEMPLATE=https://your-server/#/site/SiteName/datasources/{luid}
   ```
   Use the **unversioned** model ID (`gemini-2.5-flash`), not `gemini-2.5-flash-001`. Location can be `VERTEX_LOCATION` or `GOOGLE_CLOUD_LOCATION`.
   **Google auth**: Use [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials). Local: `gcloud auth application-default login`. Production: set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key path. Enable the [Vertex AI API](https://console.cloud.google.com/flows/enableapi?apiid=aiplatform.googleapis.com) and ensure billing is on.

### Running the app

- Development:
  ```bash
  npm run dev
  ```
- Production:
  ```bash
  npm start
  ```

### Prisma

- Generate client:
  ```bash
  npm run prisma:generate
  ```
- Run migrations:
  ```bash
  npm run prisma:migrate
  ```

## AI assistant behaviour

- **@mentions**: When someone @mentions the app in a channel, slack-mcp-agent replies in that thread.
- **Assistant thread**: When users open the app in the Assistant (side panel / DM), slack-mcp-agent greets them and responds to messages in the thread.

Required **OAuth scopes** include at least: `app_mentions:read`, `chat:write`, `im:history`, `assistant:write`, and **`files:write`** (so Tableau view snapshots from `tableau_get_view_image` can be uploaded with `files.uploadV2` into the thread or channel).  
For **Event Subscriptions**, subscribe to: `app_mention`, `message.im`, `assistant_thread_started`, `assistant_thread_context_changed`, `app_home_opened`, and **`function_executed`** if you use the Workflow Builder **Ask AI** step.  
**App Home (Tableau MCP settings):** In the Slack app config, open **App Home** and enable the **Home Tab**. Per Slack’s docs, `app_home_opened` requires no additional OAuth scopes, and `views.publish` for the home tab uses your existing bot token—no `app_home:*` scopes exist.  
Under **Interactivity & Shortcuts**, turn **Interactivity** on and set the **Request URL** to the same base URL as Event Subscriptions — for this app, `https://<PUBLIC_HOST>/slack/events` (Bolt’s default). If this is missing or wrong, Home tab buttons will not reach the server and modals will never open.  
In Slack **App Settings**, enable **Agents & AI Apps** for the Assistant UI.

**Slack MCP must be turned on for your app** (separate from the Assistant UI toggle): open [Your Apps](https://api.slack.com/apps) → select this app → **Agents & AI Apps** (or **Assistant**) → enable **Model Context Protocol** / Slack MCP server access. If MCP is off, `mcp.slack.com` returns HTTP 400 with *“App is not enabled for Slack MCP server access”* and the app falls back to the Web API only for Slack context. The error response includes a direct link to `https://api.slack.com/apps/YOUR_APP_ID/app-assistant`.

### LLM backends

AI is generated through a single provider abstraction (`src/assistant/llmProvider.js`) selected by **`AI_PROVIDER`**. If the vars for the selected backend are incomplete, the app **falls back to Vertex** so a misconfiguration never silently breaks replies. To change the system prompt or model settings, edit `src/assistant/respond.js`.

**`bedrock` — AWS Bedrock / Claude (production default on the reference deployment).** Set `AI_PROVIDER=bedrock`, `BEDROCK_MODEL_ID` (e.g. a Claude Sonnet model id), and a region (`BEDROCK_REGION` / `AWS_REGION`). Credentials resolve from the AWS SDK's default chain: either a long-term **Bedrock API key** in `AWS_BEARER_TOKEN_BEDROCK` (the SDK auto-selects bearer auth — no STS expiry churn) or classic SigV4 keys (`AWS_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_SESSION_TOKEN`). The Bedrock path runs a real **Converse tool-use loop**, so the model can call the Tableau MCP tools mid-answer (capped at `BEDROCK_MAX_TOOL_ROUNDS`, default 10). Newer Claude models that reject the `temperature` parameter are handled automatically (stripped and retried once).

**`gateway` — OpenAI-compatible endpoint (Claude via an internal gateway).** Set `AI_PROVIDER=gateway` plus `LLM_GATEWAY_URL`, `LLM_GATEWAY_API_KEY`, and `LLM_GATEWAY_MODEL` to route replies through an OpenAI-compatible `/v1/chat/completions` gateway. Note: the internal gateway is typically **not reachable from public Heroku dynos** — that is why the reference deployment uses `bedrock` (a public AWS endpoint) instead.

**`vertex` — Vertex AI / Gemini (code default, and the fallback).** Configure `GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION`, and optionally `GEMINI_MODEL`; see the `.env` section above. This is the backend used when `AI_PROVIDER` is unset or a non-Vertex backend is incompletely configured.

**Caveat (non-Vertex backends):** Google Search grounding is a Gemini-only tool, so the *Internet Search* toggle has no effect under `gateway` or `bedrock` — the model answers from Slack/Tableau context and its own knowledge only.

**Slack context (Slack MCP server):** The assistant uses Slack as context when answering. For @mentions it fetches recent channel/thread messages and optional search results; for Assistant threads it runs search from the user’s message. This is implemented in `src/assistant/slackContext.js` using the Slack MCP server at `https://mcp.slack.com/mcp` when a user token is present (Streamable HTTP: initialize, `Mcp-Session-Id`, then `tools/list` / `tools/call`), else the Slack Web API ([Slack MCP server](https://docs.slack.dev/ai/mcp-server)). Ensure the app has scopes such as `channels:history`, `groups:history`, `im:history`, `mpim:history`, and `search:read.public` (and other `search:read.*`) for full context. Set `SLACK_MCP_DEBUG=1` (or `SLACK_CONTEXT_DEBUG=1`) to log Slack MCP failures instead of failing silently.

**Tableau context:** Implemented in `src/assistant/tableauMcpClient.js` — same Streamable HTTP pattern. It injects a compact tool name list, calls `list-datasources` when the message (or recent Assistant thread) looks analytics-related, and when a published source name matches the user text it calls `get-datasource-metadata` so the model sees real field captions. **`buildTableauContext`** returns `{ context, datasourceUrls }` so replies can include browse links keyed by data source LUID when the MCP catalog exposes `webpageUrl` / `contentUrl`. Gemini tools also include **`tableau_list_views`** and **`tableau_get_view_image`**; snapshots are uploaded via **`files.uploadV2`** after the text message (requires **`files:write`**). Set `TABLEAU_MCP_SERVER` to your deployment’s default MCP base URL (example: `https://<your-tableau-mcp-host>/tableau-mcp`). Each user can override that default from the app **Home** → **Settings** → **Set URL**; overrides are stored in Postgres (`UserPreference`). Optional: `TABLEAU_MCP_VERBOSE_TOOLS=1` for long per-tool descriptions in context. If neither the host default nor a user override is set, Tableau context and Tableau Gemini tools are disabled for that user. If MCP list/metadata responses omit browse URLs, set **`TABLEAU_DATASOURCE_BROWSE_URL_TEMPLATE`** to your site’s pattern with a literal `{luid}` placeholder so query/metadata tool results can still expose **source_url** for Slack links (pattern varies by Tableau Cloud / Server—confirm in your environment).

Replies use **Slack mrkdwn** only: pipe-style “markdown tables” are avoided in the system prompt because Slack does not render them.

**Slack canvases (create / read / update):** Gemini function calling in `src/assistant/respond.js` can invoke `slack_canvas_create`, `slack_canvas_read`, and `slack_canvas_update` in `src/canvas/userCanvasActions.js`. All canvas calls use the **installing user’s OAuth token** (`xoxp-`), not the bot token. The model decides when to call tools from the user’s message. **User token scopes** must include `canvases:read` and `canvases:write`. Default `channel_id` for new canvases is the current conversation (channel @mention or Assistant channel/DM). Tool results include `canvas_url` (`https://app.slack.com/client/{team_id}/{canvas_id}`) and `slack_mrkdwn_link_example`; the system prompt instructs the model to share canvases as Slack mrkdwn `<URL|label>` links, not raw `<F…>` IDs. Slack’s read API returns **section outlines** (heading section IDs), not a full markdown export; updates support **append end**, **insert start**, **replace entire document**, and **section-scoped** edits (**insert_after**, **insert_before**, **replace_section** using `section_id` from read) — no canvas delete.

### Workflow Builder (Ask AI step)

The app registers a [custom workflow step](https://docs.slack.dev/tools/bolt-js/concepts/custom-steps) in [`src/slack/workflowAskAi.js`](src/slack/workflowAskAi.js). Default Slack manifest ids (opaque keys from Workflow Steps UI) are **callback `9dec78`**, prompt input **`afd46a`**, optional post channel **`b504c1`**, output **`8f09f2`** — they must match your live manifest. It uses the **same** LLM backend (`AI_PROVIDER`), **system prompt**, **tool calling** (Tableau MCP, canvas tools when the install has a user `xoxp` token), and the same style of **Slack + Tableau context** prep as `@mentions` and Assistant threads (no Assistant **thread history**—there is no thread in `function_executed`).

**Environment overrides** (when Slack regenerates ids or you use another app): `SLACK_WORKFLOW_ASK_AI_CALLBACK_ID`, `SLACK_WORKFLOW_ASK_AI_PROMPT_INPUT`, `SLACK_WORKFLOW_ASK_AI_RESPONSE_OUTPUT`, `SLACK_WORKFLOW_ASK_AI_POST_CHANNEL_INPUT` (optional channel field `name`, default `b504c1`), `SLACK_WORKFLOW_ASK_AI_POST_CHANNEL_ID` (fixed `C…` to always post Block Kit mrkdwn there without manifest field).

**Manifest:** Merge [slack/ask-ai-workflow-manifest.partial.json](slack/ask-ai-workflow-manifest.partial.json) into your Slack app manifest (or equivalent UI): set `settings.function_runtime` to **`remote`**, add the `functions.9dec78` block (or align the fragment with your app’s actual `functions` key), redeploy the app config, and reinstall if Slack requires it. If you use **manifest schema v2**, translate the same fields into `input_parameters.properties` / `output_parameters.properties` and `required` arrays per [Slack’s app manifest reference](https://docs.slack.dev/reference/app-manifest#functions).

**Events:** Add the **`function_executed`** bot event so Slack can deliver step executions to your existing Events request URL (`https://<PUBLIC_HOST>/slack/events`).

**HTTP ack:** Slack expects the Events API request to be acknowledged quickly. For `function_executed`, Bolt otherwise defers `ack()` until after other middleware; this app acknowledges in the first global `app.use` in `src/index.js` and sets **`autoAcknowledge: false`** on the Ask AI `app.function` so Gemini can run after the HTTP 200 is sent.

**Inputs**

- **Prompt** (required): **Long rich text** (`slack#/types/expanded_rich_text` in the manifest)—instructions plus any data you want in one field. Authors can format in the Workflow Builder editor and use the variable picker to insert outputs from prior steps. The app converts Slack rich text to a Slack mrkdwn-style string before calling the model (sections, bullets, bold, links, mentions where supported).
- **Optional: post formatted reply here** (`slack#/types/channel`, default manifest id `b504c1`): If set, the app calls `chat.postMessage` with Block Kit **section** blocks whose `text` objects are **`type: mrkdwn`** (same path as @mention replies). That is what makes `*bold*` and `<#C…|name>` render. Workflow Builder’s default **rich-text** “Send a message” body treats the `ai_response` string as plain characters, so markup shows literally—use this channel, configure the send step for mrkdwn, or strip formatting downstream.

**Output**

- **`ai_response`**: Still one **Slack mrkdwn** string for variables and steps that interpret mrkdwn correctly. It is not Block Kit JSON; the optional channel post above is how you get rendered blocks without relying on rich-text composers.
- **IDs in output:** Before `complete()`, the app resolves bare `<#C…>` to `<#C…|channel-name>` via the Web API. Bare `<@U…>` is replaced with the user’s display/real name by default (readable in plain-text workflow steps). Set **`SLACK_WORKFLOW_ASK_AI_PLAIN_USER_NAMES=0`** to keep `<@U…>` for steps that post **mrkdwn** and rely on Slack mention rendering.

**Chat vs workflow (parity)**

| Capability | @mention / Assistant | Workflow Ask AI step (`9dec78` default) |
|------------|----------------------|-------------------------|
| Slack context (history, search, channel refs) | Yes (when user token + bot scopes allow) | **Same `buildSlackContext` path:** optional **post channel** or first `<#C…>` in the prompt anchors “current” channel history; search enabled; user token from the **workflow runner’s** install row when available. |
| Tableau MCP tools & catalog context | Yes, when configured | **Same** `buildTableauContext` + Gemini tools when `TABLEAU_MCP_SERVER` / per-user URL is configured |
| Canvas create/read/update tools | Yes, with user `xoxp` | **Same** tools when the runner’s installation includes a user token |
| LLM backend (Bedrock/gateway/Vertex) | Same `.env` (`AI_PROVIDER`) | Same `.env` |
| Reply formatting in app UI | mrkdwn → Block Kit (`mrkdwnStringToBlocks`) | Optional channel input or `SLACK_WORKFLOW_ASK_AI_POST_CHANNEL_ID`: same section+mrkdwn blocks via `chat.postMessage` |

**Failure behavior**

- **`fail()`** (step shows as failed in Slack): Empty **Prompt** after trimming, missing AI configuration when the model is first created (for example `GOOGLE_CLOUD_PROJECT`), or an unexpected exception in the handler.
- **`complete()`** with **`ai_response`**: Normal text replies, model safety refusals, and other user-facing messages returned by Gemini handling (for example “I can’t generate a response for that” or Vertex misconfiguration explained in plain language). Workflows keep running so authors can branch or post the string to a channel.

**Timeouts:** Slack enforces a maximum runtime for custom steps. Tool rounds (Tableau/canvas) and long generations can hit that limit faster than a single chat reply—keep prompts focused.

## Suggested Cursor / Codex skills (Slack + Tableau)

These skills help humans and agents work consistently across chat and analytics:

1. **Tableau data catalog** — Your approved data source names, LUIDs, certified projects, and field naming conventions so answers align with published workbooks and MCP tool usage.
2. **Slack → Tableau workflow** — How to triage questions asked in Slack (clarify metric definitions, time range, grain) before interpreting Tableau MCP output or asking for queries.
3. **Slack Block Kit / mrkdwn** — Patterns for richer bot messages (sections, context blocks) if you extend beyond plain text replies.
4. **Incident + metrics bridge** — Template for correlating thread timelines in Slack with dashboard metrics (when to cite Slack vs Tableau context, escalation paths).
5. **MCP extension playbook** — How to add another MCP (auth headers, session handling, tool selection) next to `tableauMcpClient.js` and `slackMcpClient.js`.

## Customization

- Add app logic and Slack handlers in `src/index.js`.
- AI response logic and canvas tools: `src/assistant/respond.js`, `src/canvas/userCanvasActions.js`.
- Workflow Builder Ask AI step: `src/slack/workflowAskAi.js`; manifest fragment: [slack/ask-ai-workflow-manifest.partial.json](slack/ask-ai-workflow-manifest.partial.json).
- Adjust the schema in `prisma/schema.prisma` and add migrations as needed.

## Deploying

Two supported targets:

- **Heroku** (the reference deployment, `damp-wave-30118`) — a public web dyno + Heroku
  Postgres, with the MCP server hosted separately. Steps below.
- **AWS App Runner** (partner package) — a private Tableau MCP + public agent, Aurora
  Serverless v2, Secrets Manager, and a daily EventBridge trigger, all via Terraform.
  Two ways in, same stack: drive it conversationally with Claude Code
  ([`deploy/aws/DEPLOY-WITH-AGENT.md`](deploy/aws/DEPLOY-WITH-AGENT.md)) or run the
  commands by hand ([`deploy/aws/DEPLOY-SCRIPTED.md`](deploy/aws/DEPLOY-SCRIPTED.md)).
  The infrastructure detail is in [`deploy/aws/terraform/README.md`](deploy/aws/terraform/README.md).

### Heroku — 1. Create the app and add Postgres

In the [Heroku Dashboard](https://dashboard.heroku.com/):

1. **New** → **Create new app** → name it (e.g. `slack-mcp-agent-prod`)
2. **Resources** → **Add-ons** → search **Heroku Postgres** → add (e.g. Mini plan)
3. Heroku sets `DATABASE_URL` automatically

### 2. Connect to GitHub

1. **Deploy** tab → **Deployment method** → **Connect to GitHub**
2. Authorize Heroku, select your repo, connect
3. Enable **Automatic deploys** (optional) or use **Manual deploy** → **Deploy Branch**

### 3. Config vars (Settings → Config Vars)

Add these in the dashboard (or via CLI). **Do not commit secrets to git.**

| Variable | Required | Notes |
|----------|----------|-------|
| `SLACK_CLIENT_ID` | Yes | From [Slack API](https://api.slack.com/apps) → Basic Information |
| `SLACK_CLIENT_SECRET` | Yes | Same |
| `SLACK_SIGNING_SECRET` | Yes | Same |
| `SLACK_STATE_SECRET` | Yes | Random string (e.g. `openssl rand -hex 32`) |
| `SLACK_BOT_SCOPES` | Yes | Comma-separated, e.g. `app_mentions:read,chat:write,im:history,...` |
| `SLACK_USER_SCOPES` | Yes | Comma-separated, e.g. `channels:read,channels:history,...` |
| `AI_PROVIDER` | No | `vertex` (default) / `gateway` / `bedrock`. Selects the LLM backend; an incompletely-configured non-Vertex backend falls back to `vertex`. The reference deployment uses `bedrock`. |
| `BEDROCK_MODEL_ID` | For bedrock | Claude model id on Bedrock (e.g. a Claude Sonnet id) |
| `BEDROCK_REGION` | For bedrock | AWS region (or `AWS_REGION` / `AWS_DEFAULT_REGION`), e.g. `us-west-2` |
| `AWS_BEARER_TOKEN_BEDROCK` | For bedrock | Long-term Bedrock API key (`ABSK…`). SDK auto-selects bearer auth — no STS expiry. Alternatively use `AWS_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_SESSION_TOKEN`. **Secret.** |
| `BEDROCK_MAX_TOOL_ROUNDS` | No | Max agentic tool-use rounds on the Bedrock path (default `10`) |
| `GOOGLE_CLOUD_PROJECT` | For vertex | GCP project ID for Vertex AI |
| `VERTEX_LOCATION` | For vertex | e.g. `us-central1` |
| `GEMINI_MODEL` | No | Default `gemini-2.5-flash` |
| `LLM_GATEWAY_URL` | For gateway | Full `/v1/chat/completions` URL of the gateway |
| `LLM_GATEWAY_API_KEY` | For gateway | Bearer token for the gateway. **Secret.** |
| `LLM_GATEWAY_MODEL` | For gateway | Model id, e.g. `claude-sonnet-4-6` |
| `TOKEN_ENC_KEY` | Recommended | 32-byte key (base64/hex) that encrypts OAuth tokens at rest (AES-256-GCM). Generate with `openssl rand -base64 32`. Unset = plaintext + one-time warning; **malformed = fail loud** (fix or unset). **Secret.** |
| `REQUIRE_TOKEN_ENC` | Prod hardening | `1`/`true`/`yes` makes a missing `TOKEN_ENC_KEY` **fail closed**: installs are refused with a loud error instead of silently storing tokens in plaintext. Also flips the `TOKEN_ENC_KEY` configcheck from a warning to a hard fail. Default off preserves the local/dev no-key path. |
| `PGSSLROOTCERT` | Prod DB | Path to the RDS CA bundle (`certs/rds-global-bundle.pem`) so DB TLS verification stays on against Aurora/RDS. See [Database TLS](#database-tls-rdsaurora). |
| `DATABASE_SSL_NO_VERIFY` | Demo only | `1` skips DB TLS **issuer verification** (TLS stays encrypted). Escape hatch for a demo tier where shipping the CA bundle isn't warranted; do **not** use in production. |
| `LLM_MAX_OUTPUT_TOKENS` | No | Max reply tokens (default `4096`). Applies to both backends; replies that still hit the cap are flagged as truncated rather than cut silently. |
| `LLM_REQUEST_TIMEOUT_MS` | No | Per-request timeout for LLM calls across all backends — Bedrock Converse, Vertex/Gemini, and the gateway `fetch` (default `60000`). Bounds a hung upstream so a turn fails cleanly instead of hanging the dyno. |
| `MCP_HTTP_MAX_ATTEMPTS` | No | MCP HTTP retry attempts on transient 5xx/429/network errors (default `3`) |
| `MCP_HTTP_RETRY_BASE_MS` | No | Base backoff between MCP retries in ms (default `300`, linear) |
| `RATE_LIMIT_MAX` | No | Per-IP request cap per window on the secret-in-path trigger routes (Tableau refresh, daily brief, triage admission) — default `30`. Throttles online guessing of a path secret; real callers (EventBridge/Tableau) fire a handful a day. |
| `RATE_LIMIT_WINDOW_MS` | No | Rate-limit window length in ms (default `60000`). |
| `RATE_LIMIT_DISABLED` | No | `1` bypasses the trigger-route rate limiter entirely (e.g. a load test). |
| `TABLEAU_MCP_SERVER` | No | Tableau MCP streamable HTTP URL when you want Tableau context |
| `TABLEAU_MCP_ALLOW_PRIVATE` | No | `1` lets the **deployment-default** Tableau MCP URL point at a private/internal host (SSRF guard is relaxed for the env URL only). User-supplied App-Home URLs are still blocked. Use only when the MCP server is network-isolated. |
| `TABLEAU_MCP_LIST_DATASOURCES` | No | Set `1` to always attach a datasource list sample (more API load) |
| `TABLEAU_MCP_VERBOSE_TOOLS` | No | Set `1` to include long Tableau tool descriptions in context (default is names only) |
| `TABLEAU_DATASOURCE_BROWSE_URL_TEMPLATE` | No | Optional `https://…/{luid}` pattern so **source_url** is filled when MCP JSON omits browse URLs (site-specific) |
| `SLACK_MCP_DEBUG` | No | Set `1` to log Slack MCP errors (same as `SLACK_CONTEXT_DEBUG` for this path) |
| `PORT` | No | Heroku sets this automatically |
| `GCP_SERVICE_ACCOUNT_JSON` | For Vertex AI | Full JSON key content (alternative to `GOOGLE_APPLICATION_CREDENTIALS`) |
| `SLACK_CONTEXT_DEBUG` | No | Set to `1` to log installation/userToken lookup for channel access debugging |
| `PUBLIC_BASE_URL` | No | `https://<your-app>.herokuapp.com` (no trailing slash). Used for OAuth install links in prompts and the App Home **Re-install** button. |

**Google auth in production:** Add `GCP_SERVICE_ACCOUNT_JSON` with the full contents of your service account JSON key. The app writes it to a temp file at startup. Or set `GOOGLE_APPLICATION_CREDENTIALS` to a file path if using a buildpack.

### 4. Slack app configuration

Update your Slack app to use the Heroku URL:

1. **Slack API** → **OAuth & Permissions** → **Redirect URL**:  
   `https://<your-app>.herokuapp.com/slack/oauthcallback`
2. **Event Subscriptions** → **Request URL**:  
   `https://<your-app>.herokuapp.com/slack/events`
3. **Interactivity & Shortcuts** → **Request URL** (if used):  
   `https://<your-app>.herokuapp.com/slack/events`
4. **Install URL** for users:  
   `https://<your-app>.herokuapp.com/slack/install`

### 5. Deploy

- **Automatic:** Push to the connected branch; Heroku builds and deploys.
- **Manual:** **Deploy** tab → **Deploy Branch**.

The `release` phase runs **`npm run deploy:migrate && npm run health:configcheck`** (see `Procfile`) **before** the new `web` dyno starts:

1. **`deploy:migrate`** (`prisma migrate deploy`) applies pending migrations. If a migration fails, the release fails and the previous release keeps running — fix the migration or DB, then redeploy. **Commit every file under `prisma/migrations/`** so production applies the same schema as your repo.
2. **`health:configcheck`** is a deterministic, **network-free** gate: it validates required config, the `TOKEN_ENC_KEY` shape, the SSRF guard, the Tableau URL, and provider-fallback detection. A real misconfiguration (missing secret, malformed key, private/non-https Tableau URL) **fails the release before it takes traffic** — without coupling the deploy to whether an external LLM/Tableau endpoint happens to be up this second. Live reachability lives in the `smoke` suite (run by hand) and the scheduled monitor. See [`tests/health/README.md`](tests/health/README.md).

### Database TLS (RDS/Aurora)

The app connects to Postgres via the Prisma `pg` adapter (`src/install-kit/prisma.js`). TLS is always on in a deployed environment; the choice is whether to **verify the server certificate's issuer**:

- **Production tier — verify (recommended):** Amazon Aurora/RDS presents a certificate whose CA is **not** in Node's default trust store, so strict verification fails with `unable to get local issuer certificate` unless you supply the CA. Set **`PGSSLROOTCERT=certs/rds-global-bundle.pem`** (the public Amazon RDS global CA bundle, committed under `certs/`) to keep `rejectUnauthorized: true` **and** validate. See [`certs/README.md`](certs/README.md).
- **Demo tier — escape hatch:** set **`DATABASE_SSL_NO_VERIFY=1`** to skip issuer verification (TLS stays encrypted). Fast and reversible for a demo, but do **not** ship this posture to a real production app.

> **History:** enabling strict DB TLS verification against Aurora without shipping the CA bundle caused a demo outage — every installation lookup 401'd. The two-tier pattern above (CA bundle in prod, `DATABASE_SSL_NO_VERIFY=1` in demo) is the resolution; no code fork is needed since `prisma.js` branches on these env vars.

### 6. Debugging channel access on Heroku

If slack-mcp-agent says it can't access channel messages, add `SLACK_CONTEXT_DEBUG=1` to Heroku Config Vars and redeploy. Check logs for:

```
[slack-mcp-agent] installQuery: {...} found: true userToken: true
[slackContext] userToken: true requestedIds: ['C...'] ...
[slackContext] addChannelById error: C... not_in_channel
```

- **found: false** → Installation lookup failed (wrong team/enterprise ID in payload)
- **userToken: false** → Reinstall the app so OAuth requests user scopes
- **addChannelById error: not_in_channel** → The user who installed (owns the token) is not in that channel. Have them join the channel, or reinstall from an account that is.

**Inspect the installation store:**
```bash
heroku run node scripts/check-installation.js           # list all
heroku run node scripts/check-installation.js E081KQN1U7N   # by enterprise ID
```

**Per-user tokens:** The installation store keeps one org-level record (bot only) and one per-user record per authorizing user (`E:enterpriseId:userId`). Each user who needs channel access must authorize the app (open it or reinstall) so their user token is stored.

**Migrate existing installs:** If you had installs before per-user support, run once:
```bash
heroku run node scripts/migrate-to-per-user.js -a slack-mcp-agent
```
This creates per-user records from org-level rows that have `userToken` and `installerUser`.

### 7. Google Cloud credentials (Vertex AI)

1. In GCP Console: **IAM & Admin** → **Service Accounts** → create one with **Vertex AI User** role
2. Create a JSON key and download it
3. In Heroku **Config Vars**, add `GCP_SERVICE_ACCOUNT_JSON` and paste the **entire** JSON (minify to one line if needed)
4. The app writes this to a temp file at startup; Vertex AI will use it automatically

## Testing & health checks

- **Unit tests** — `npm test` runs the full offline suite (`node --test`), including the health framework's own judgement logic, the SSE-transport regression, token-crypto loud-fail, SSRF classification, tenant-cache isolation, prompt-injection fencing, canvas/title helpers, and Tableau parse-shape guards.
- **Deploy gate** — `npm run health:configcheck` (network-free) runs automatically in the Heroku release phase.
- **Post-deploy readiness** — `npm run health:smoke` adds live LLM + Tableau MCP pings on top of configcheck. Run it by hand after a deploy.
- **Ongoing monitoring** — `npm run health:drift` (model-drift golden prompts + offline routing goldens) and `npm run health:contextrot` (datasource-catalog growth). Recommended cadence and what each check protects against are documented in [`tests/health/README.md`](tests/health/README.md). Two business-facing companion docs live in `docs/` — see below.

## Additional documentation

- [`docs/CHANGES-VS-UPSTREAM.md`](docs/CHANGES-VS-UPSTREAM.md) — what this fork changed vs. `itsnaseer/slack-mcp-agent` (for technical + leadership review).
- [`docs/DEPLOYMENT-AND-QUALITY.md`](docs/DEPLOYMENT-AND-QUALITY.md) — plain-language guide to how the app is deployed and how quality is protected automatically.
- [`docs/GETTING-STARTED-ONE-PAGER.md`](docs/GETTING-STARTED-ONE-PAGER.md) — business-user one-pager: what the connector does, how to use it in Slack, and example prompts.
- [`docs/MULTI-AGENT-TRIAGE-DESIGN.md`](docs/MULTI-AGENT-TRIAGE-DESIGN.md) — design rationale for the multi-agent scaffolding + Triage Specialist.
- [`docs/TRIAGE-METHODS-AND-SCORING.md`](docs/TRIAGE-METHODS-AND-SCORING.md) — reviewer's guide to the triage flow, methods, and the evaluation/scoring harness.
- **AWS App Runner deployment** — [`deploy/aws/DEPLOY-WITH-AGENT.md`](deploy/aws/DEPLOY-WITH-AGENT.md) (agent-guided) and [`deploy/aws/DEPLOY-SCRIPTED.md`](deploy/aws/DEPLOY-SCRIPTED.md) (by-hand command runbook); infra detail in [`deploy/aws/terraform/README.md`](deploy/aws/terraform/README.md).
- [`tests/health/README.md`](tests/health/README.md) — the health-check framework in detail.
- [`certs/README.md`](certs/README.md) — the RDS CA bundle and the two-tier DB TLS setup.

## References

- [Slack Bolt](https://slack.dev/bolt)
- [Prisma](https://www.prisma.io/)
- [Slack MCP server](https://docs.slack.dev/ai/mcp-server)
