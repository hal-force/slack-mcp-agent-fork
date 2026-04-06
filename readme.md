# slack-mcp-agent

## Overview

slack-mcp-agent is a Slack app built with the Bolt framework and Prisma for database management. It supports multi-workspace installation via OAuth and stores installation data in PostgreSQL. The assistant grounds replies in **Slack context** (via the Slack MCP server or Web API) and optional **Tableau context** from a Tableau MCP server (`TABLEAU_MCP_SERVER`).

## Features

- **Prisma + PostgreSQL**: Installations and tokens persisted with the Prisma PostgreSQL adapter.
- **Configuration**: Environment variables via dotenv (local) and config vars (e.g. Heroku).
- **Slack Bolt**: OAuth v2 install flow, installation store, **@mentions** in channels and **Assistant** threads (side panel / DM).
- **Vertex AI (Gemini)**: Replies generated with configurable model (`GEMINI_MODEL`); system prompt tuned for Slack mrkdwn, Slack/Tableau context, and canvas behavior.
- **Slack context**: Builds grounding context from the **Slack MCP** server (`mcp.slack.com`, Streamable HTTP + session) when a **user token** is present, with **Web API** fallback for channel/thread history and search. Requires MCP enabled for the Slack app under Agents & AI Apps when using MCP.
- **Tableau MCP** (optional): When `TABLEAU_MCP_SERVER` is set, injects compact tool names, can call `list-datasources`, matches user/thread intent for analytics, fetches **`get-datasource-metadata`** when a published source matches, and respects `TABLEAU_MCP_LIST_DATASOURCES` / `TABLEAU_MCP_VERBOSE_TOOLS`.
- **Slack canvases** (user token): Gemini **function calling** drives `slack_canvas_create`, `slack_canvas_read`, and `slack_canvas_update` using the installing user’s **`xoxp`** token (`canvases:read` / `canvases:write`). Supports **create**, **read** (section outline via `canvases.sections.lookup`), and **update** modes: append end, insert start, replace whole document, and **section-targeted** `insert_after` / `insert_before` / `replace_section` using `section_id` from read. Tool results include **`canvas_url`** and **`slack_mrkdwn_link_example`** (`https://app.slack.com/client/{team}/{canvas}`) so replies can use `<URL|label>` links. Canvas **delete** is not exposed.

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
   SLACK_BOT_SCOPES=app_mentions:read,chat:write,...
   SLACK_USER_SCOPES=users:read.email,...
   # Or legacy: SLACK_SCOPES=app_mentions:read,chat:write,...

   # Vertex AI (Gemini) – required for AI responses
   GOOGLE_CLOUD_PROJECT=your-gcp-project-id
   VERTEX_LOCATION=us-central1
   GEMINI_MODEL=gemini-2.5-flash

   # Tableau MCP (optional) – streamable HTTP endpoint, e.g.:
   # TABLEAU_MCP_SERVER=https://federal-tableau-mcp-81e8ca899174.herokuapp.com/tableau-mcp
   # TABLEAU_MCP_LIST_DATASOURCES=1   # always try to attach a datasource catalog sample (noisier)
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

Required **OAuth scopes** include at least: `app_mentions:read`, `chat:write`, `im:history`, `assistant:write`.  
For **Event Subscriptions**, subscribe to: `app_mention`, `message.im`, `assistant_thread_started`, `assistant_thread_context_changed`, `app_home_opened`.  
**App Home (Tableau MCP settings):** In the Slack app config, open **App Home** and enable the **Home Tab**. Per Slack’s docs, `app_home_opened` requires no additional OAuth scopes, and `views.publish` for the home tab uses your existing bot token—no `app_home:*` scopes exist.  
Under **Interactivity & Shortcuts**, turn **Interactivity** on and set the **Request URL** to the same base URL as Event Subscriptions — for this app, `https://<PUBLIC_HOST>/slack/events` (Bolt’s default). If this is missing or wrong, Home tab buttons will not reach the server and modals will never open.  
In Slack **App Settings**, enable **Agents & AI Apps** for the Assistant UI.

**Slack MCP must be turned on for your app** (separate from the Assistant UI toggle): open [Your Apps](https://api.slack.com/apps) → select this app → **Agents & AI Apps** (or **Assistant**) → enable **Model Context Protocol** / Slack MCP server access. If MCP is off, `mcp.slack.com` returns HTTP 400 with *“App is not enabled for Slack MCP server access”* and the app falls back to the Web API only for Slack context. The error response includes a direct link to `https://api.slack.com/apps/YOUR_APP_ID/app-assistant`.

AI is powered by **Vertex AI (Gemini)**. Configure `GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION`, and optionally `GEMINI_MODEL` in `.env`; see above. To change the system prompt or model settings, edit `src/assistant/respond.js`.

**Slack context (Slack MCP server):** The assistant uses Slack as context when answering. For @mentions it fetches recent channel/thread messages and optional search results; for Assistant threads it runs search from the user’s message. This is implemented in `src/assistant/slackContext.js` using the Slack MCP server at `https://mcp.slack.com/mcp` when a user token is present (Streamable HTTP: initialize, `Mcp-Session-Id`, then `tools/list` / `tools/call`), else the Slack Web API ([Slack MCP server](https://docs.slack.dev/ai/mcp-server)). Ensure the app has scopes such as `channels:history`, `groups:history`, `im:history`, `mpim:history`, and `search:read.public` (and other `search:read.*`) for full context. Set `SLACK_MCP_DEBUG=1` (or `SLACK_CONTEXT_DEBUG=1`) to log Slack MCP failures instead of failing silently.

**Tableau context:** Implemented in `src/assistant/tableauMcpClient.js` — same Streamable HTTP pattern. It injects a compact tool name list, calls `list-datasources` when the message (or recent Assistant thread) looks analytics-related, and when a published source name matches the user text it calls `get-datasource-metadata` so the model sees real field captions. Set `TABLEAU_MCP_SERVER` to your deployment’s default MCP base URL (example: `https://federal-tableau-mcp-81e8ca899174.herokuapp.com/tableau-mcp`). Each user can override that default from the app **Home** → **Settings** → **Set URL**; overrides are stored in Postgres (`UserPreference`). Optional: `TABLEAU_MCP_VERBOSE_TOOLS=1` for long per-tool descriptions in context. If neither the host default nor a user override is set, Tableau context and Tableau Gemini tools are disabled for that user.

**Slack canvases (create / read / update):** Gemini function calling in `src/assistant/respond.js` can invoke `slack_canvas_create`, `slack_canvas_read`, and `slack_canvas_update` in `src/canvas/userCanvasActions.js`. All canvas calls use the **installing user’s OAuth token** (`xoxp-`), not the bot token. The model decides when to call tools from the user’s message. **User token scopes** must include `canvases:read` and `canvases:write`. Default `channel_id` for new canvases is the current conversation (channel @mention or Assistant channel/DM). Tool results include `canvas_url` (`https://app.slack.com/client/{team_id}/{canvas_id}`) and `slack_mrkdwn_link_example`; the system prompt instructs the model to share canvases as Slack mrkdwn `<URL|label>` links, not raw `<F…>` IDs. Slack’s read API returns **section outlines** (heading section IDs), not a full markdown export; updates support **append end**, **insert start**, **replace entire document**, and **section-scoped** edits (**insert_after**, **insert_before**, **replace_section** using `section_id` from read) — no canvas delete.

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
- Adjust the schema in `prisma/schema.prisma` and add migrations as needed.

## Deploying to Heroku

### 1. Create the app and add Postgres

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
| `GOOGLE_CLOUD_PROJECT` | Yes | GCP project ID for Vertex AI |
| `VERTEX_LOCATION` | Yes | e.g. `us-central1` |
| `GEMINI_MODEL` | No | Default `gemini-2.5-flash` |
| `TABLEAU_MCP_SERVER` | No | Tableau MCP streamable HTTP URL when you want Tableau context |
| `TABLEAU_MCP_LIST_DATASOURCES` | No | Set `1` to always attach a datasource list sample (more API load) |
| `TABLEAU_MCP_VERBOSE_TOOLS` | No | Set `1` to include long Tableau tool descriptions in context (default is names only) |
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

The `release` phase runs `npm run deploy:migrate` (`prisma migrate deploy`) **before** the new `web` dyno starts. If a migration fails, the release fails and the previous release keeps running—fix the migration or DB, then redeploy. **Commit every file under `prisma/migrations/`** so production applies the same schema as your repo.

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

## References

- [Slack Bolt](https://slack.dev/bolt)
- [Prisma](https://www.prisma.io/)
- [Slack MCP server](https://docs.slack.dev/ai/mcp-server)
