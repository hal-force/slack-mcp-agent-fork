<<<<<<< HEAD
# LivChat

## Overview
LivChat is a Slack app built with the Bolt framework and Prisma for database management. It supports multi-workspace installation via OAuth and stores installation data in PostgreSQL.

## Features
- **Prisma + PostgreSQL**: Database interactions with the Prisma PostgreSQL adapter.
- **Environment configuration**: Environment variables via dotenv.
- **Slack Bolt**: Slack app framework with OAuth install flow and installation store.


---

<<<<<<< HEAD
### Prerequisites
- Node.js 20.x
- PostgreSQL (running)
- A Slack app in the [Slack API](https://api.slack.com/apps) dashboard

### Database setup
1. Create a database:
   ```bash
   createdb livchat
   ```
   Or with psql:
   ```sql
   CREATE DATABASE livchat;
   ```
2. Set `DATABASE_URL` in `.env` to point to this database.

### Installation
1. Clone and enter the repo:
   ```bash
   git clone <repository-url>
   cd livchat
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
- **@mentions**: When someone @mentions the app in a channel, LivChat replies in that thread.
- **Assistant thread**: When users open the app in the Assistant (side panel / DM), LivChat greets them and responds to messages in the thread.

Required **OAuth scopes** include at least: `app_mentions:read`, `chat:write`, `im:history`, `assistant:write`.  
For **Event Subscriptions**, subscribe to: `app_mention`, `message.im`, `assistant_thread_started`, `assistant_thread_context_changed`.  
In Slack **App Settings**, enable **Agents & AI Apps** for the Assistant UI.

AI is powered by **Vertex AI (Gemini)**. Configure `GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION`, and optionally `GEMINI_MODEL` in `.env`; see above. To change the system prompt or model settings, edit `src/assistant/respond.js`.

**Slack context (Slack MCP server):** The assistant uses Slack as context when answering. For @mentions it fetches recent channel/thread messages and optional search results; for Assistant threads it runs search from the user’s message. This is implemented in `src/assistant/slackContext.js` using the Slack MCP server at mcp.slack.com when a user token is present, else the Slack Web API ( [Slack MCP server](https://docs.slack.dev/ai/mcp-server)). Ensure the app has scopes such as `channels:history`, `groups:history`, `im:history`, `mpim:history`, and `search:read.public` (and other `search:read.*`) for full context.

## Customization
- Add app logic and Slack handlers in `src/index.js`.
- AI response logic: `src/assistant/respond.js`.
- Adjust the schema in `prisma/schema.prisma` and add migrations as needed.

## Deploying to Heroku

### 1. Create the app and add Postgres

In the [Heroku Dashboard](https://dashboard.heroku.com/):

1. **New** → **Create new app** → name it (e.g. `livchat-prod`)
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
| `PORT` | No | Heroku sets this automatically |
| `GCP_SERVICE_ACCOUNT_JSON` | For Vertex AI | Full JSON key content (alternative to `GOOGLE_APPLICATION_CREDENTIALS`) |
| `SLACK_CONTEXT_DEBUG` | No | Set to `1` to log installation/userToken lookup for channel access debugging |

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

The `release` phase runs `prisma migrate deploy` before each release. Migrations run automatically.

### 6. Debugging channel access on Heroku

If LivChat says it can't access channel messages, add `SLACK_CONTEXT_DEBUG=1` to Heroku Config Vars and redeploy. Check logs for:

```
[LivChat] installQuery: {...} found: true userToken: true
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

### 7. Google Cloud credentials (Vertex AI)

1. In GCP Console: **IAM & Admin** → **Service Accounts** → create one with **Vertex AI User** role
2. Create a JSON key and download it
3. In Heroku **Config Vars**, add `GCP_SERVICE_ACCOUNT_JSON` and paste the **entire** JSON (minify to one line if needed)
4. The app writes this to a temp file at startup; Vertex AI will use it automatically

## References
- [Slack Bolt](https://slack.dev/bolt)
- [Prisma](https://www.prisma.io/)
=======
## Key Features

- OAuth v2 installation flow using Slack Bolt + ExpressReceiver  
- Enterprise Grid–ready (supports org-wide installs)  
- Per-installation token storage (no global bot tokens)  
- Prisma-backed persistence for install metadata and tokens  
- Modular “install kit” designed for reuse across apps  
- One-click install entry point (within Slack’s admin constraints)

---

## Architecture Overview

Slackbrix is intentionally split into two concerns:

### Installation & Auth (`install-kit/`)
Responsible for:
- OAuth install and callback handling
- Installation persistence
- Token resolution per request
- Enterprise vs workspace install resolution

### App Logic (`index.js`)
Responsible for:
- Slack events, messages, and commands
- Using the Slack client injected by Bolt
- Automatically operating with the correct token per install

>>>>>>> parent of e539b6b (Removed references to the source project for easier templating. Updated readme.md to reflect the new project details.)
