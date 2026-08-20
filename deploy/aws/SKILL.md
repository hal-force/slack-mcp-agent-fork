---
name: deploy-tableau-slack-agent-aws
description: >
  Deploy the Tableau + Slack agent stack to AWS from scratch: a private Tableau
  MCP server and a public Slack agent on App Runner, backed by Aurora Postgres,
  Secrets Manager, and an EventBridge daily trigger — all via Terraform. Then
  wire it into an existing Tableau Server/Cloud site and Slack workspace,
  including Tableau's native Alerts & Subscriptions in Slack.
---

# Deploy the Tableau + Slack agent to AWS

You are guiding a **partner** through standing up this stack on **their** AWS
account, against **their** existing Tableau and Slack. Follow these phases in
order. Stop and ask the operator whenever a step needs a value only they have
(credentials, IDs) or an irreversible/billable action.

This skill deploys real, billable AWS infrastructure (App Runner ×2, an Aurora
Serverless v2 cluster, a NAT gateway, Secrets Manager entries). Never run
`terraform apply` without the operator's explicit go-ahead.

## What gets deployed

```
                    Internet
                       │  (HTTPS: Slack events, OAuth, webhooks)
                       ▼
        ┌──────────────────────────────┐
        │  App Runner: slack-agent      │  public, :3000
        │  (this repo's image)          │
        └───────────────┬───────────────┘
          VPC egress     │  Bedrock (via IAM role), Slack API, LLM
          connector      │
        ┌────────────────▼──────────────┐   ┌───────────────────────────┐
        │  App Runner: tableau-mcp       │   │  Aurora Serverless v2      │
        │  PRIVATE (VPC ingress only)    │   │  PostgreSQL (private)      │
        │  github.com/tableau/tableau-mcp│   │  install store + dedupe    │
        └───────────────┬────────────────┘  └───────────────────────────┘
                        │  Tableau REST/Metadata (PAT)
                        ▼
             Partner's Tableau Cloud/Server site

  EventBridge rule ──(daily cron, HTTPS)──▶ slack-agent /jobs/vha-daily/<secret>
```

Key design points (already baked into the Terraform — don't re-litigate them):
- **The Tableau MCP server is private.** It runs with `DANGEROUSLY_DISABLE_OAUTH=true`,
  which is safe **only** because it has no public ingress — it's reachable solely
  from the agent through a VPC connector + PrivateLink endpoint. Never make this
  service public without first configuring OAuth on it.
- **Secrets live in AWS Secrets Manager**, injected into App Runner as
  `runtime_environment_secrets` ARNs. Nothing sensitive is a plain env var.
- **Bedrock uses the agent's IAM instance role** by default — no static AWS key
  to issue or rotate. Leave `aws_bearer_token_bedrock` empty unless you must.

## Prerequisites (check these first)

Ask the operator to confirm each, and verify what you can:

1. **Tooling on the deployer's machine:** `terraform` (or `tofu`) ≥ 1.6, `aws` CLI
   v2 (authenticated: `aws sts get-caller-identity`), `docker`, `git`, `node` ≥ 20.
2. **AWS:** an account + credentials with permission to create VPC/App Runner/
   RDS/IAM/Secrets Manager/ECR/EventBridge resources, and a chosen region.
3. **Tableau:** the site's base URL + site content-url name, and a **dedicated
   Personal Access Token** (name + secret) for the MCP server. (One PAT can't hold
   two concurrent sessions — give the MCP its own; don't reuse it for ad-hoc REST.)
4. **Slack:** a Slack app (see Phase 4 — you can create it from the manifest in
   `slack-app-manifest.json`). You'll need its signing secret, client id/secret.
5. **Generate three path/crypto secrets** (don't reuse anything):
   ```bash
   openssl rand -base64 32   # TOKEN_ENC_KEY
   openssl rand -hex 32      # TABLEAU_WEBHOOK_SECRET
   openssl rand -hex 32      # VHA_DAILY_JOB_SECRET  (and a SLACK_STATE_SECRET too)
   ```

## Phase 1 — Fill in Terraform variables

1. `cd deploy/aws/terraform`
2. `cp terraform.tfvars.example terraform.tfvars`
3. Fill every `REPLACE_ME`. Group by concern; the file is commented. Leave
   `public_base_url = ""` for now (App Runner assigns the domain on first apply).
4. **Never commit `terraform.tfvars`** — it holds live secrets (`.gitignore`
   already excludes it).

## Phase 2 — Create the ECR repos, then build & push both images

The container images must exist in ECR before App Runner can pull them, but the
ECR repos are themselves Terraform resources — so create just those first:

```bash
terraform init
terraform apply -target=aws_ecr_repository.tableau_mcp -target=aws_ecr_repository.slack_agent
```

Note the two `repository_url` values from the output, then from the **repo root**:

```bash
AWS_REGION=<region>; ACCOUNT=<your-account-id>
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com

# Slack agent (root Dockerfile)
docker build -t <slack_agent_repo_url>:latest .
docker push <slack_agent_repo_url>:latest

# Tableau MCP (pinned upstream build)
docker build --build-arg TABLEAU_MCP_REF=v4.5.1 -t <tableau_mcp_repo_url>:latest deploy/tableau-mcp
docker push <tableau_mcp_repo_url>:latest
```

> App Runner images must be **linux/amd64**. On an Apple-silicon machine add
> `--platform linux/amd64` to both `docker build` commands (or use `docker buildx`).

## Phase 3 — First full apply, then the public-URL re-apply

```bash
cd deploy/aws/terraform
terraform apply          # creates VPC, Aurora, secrets, both App Runner services
```

App Runner now assigns the agent a public domain. Resolve the chicken-and-egg:

1. Copy the `agent_service_url` output.
2. Set `public_base_url = "https://<that-domain>"` in `terraform.tfvars`.
3. `terraform apply` again. This fixes the agent's `PUBLIC_BASE_URL` **and**
   creates the EventBridge daily-brief rule (which is intentionally skipped until
   `public_base_url` is set — see `scheduler.tf`).

Confirm both services reach **Running** in the App Runner console. The agent runs
the same deploy gate as Heroku on start (`prisma migrate deploy` +
`health:configcheck`); if it crash-loops, read its App Runner logs — a failed
config gate prints exactly which var is wrong.

## Phase 4 — Point the Slack app at the deployment

In **api.slack.com/apps** → your app (create from `slack-app-manifest.json` if you
haven't). Replace every URL host with the agent's domain from `agent_service_url`:

- **OAuth & Permissions → Redirect URL:** `https://<agent>/slack/oauthcallback`
- **Event Subscriptions → Request URL:** `https://<agent>/slack/events`
- **Interactivity & Shortcuts → Request URL:** `https://<agent>/slack/events`
- Confirm **Bot Token Scopes** include everything in `slack_bot_scopes` (the
  install requests scopes from that var, **not** the manifest — a missing scope
  there, e.g. `im:write`, silently breaks DMs).

Then install to the workspace via **`https://<agent>/slack/install`** (use this
flow, not the admin "Reinstall" button — only `/slack/install` writes to the
app's install store). Verify: `@mention` the bot in a channel, or DM it.

## Phase 5 — Register the Tableau refresh webhook (optional, push-brief)

If the partner's data source refreshes on a schedule and they want a brief pushed
on each refresh, register a webhook on their Tableau site pointing at:

```
https://<agent>/webhooks/tableau/refresh/<TABLEAU_WEBHOOK_SECRET>
```

`POST /api/3.22/sites/<site-luid>/webhooks` with the nested body form
(`webhook-source-event-datasource-refresh-succeeded`). The daily EventBridge
trigger already covers the scheduled cadence, so this is only for
refresh-driven pushes. See `docs/` and `demo-data/vha/DAILY-BRIEF-DESIGN.md`.

## Phase 6 — Tableau native Alerts & Subscriptions in Slack (admin runbook)

**This is separate from everything above.** Native Alerts & Subscriptions are
delivered by **Tableau's own Slack app**, not by this agent — the agent can
neither send nor see them. See `deploy/aws/NATIVE-TABLEAU-SLACK.md` for the
admin steps. The one gotcha to flag up front: the Tableau Slack integration is
configured **per Tableau site**, and it must be the **same site** whose data the
users are alerting on — a subscription on the wrong site never fires.

## Verify & hand off

- App Runner: both services **Running**; agent logs show `11 pass` config gate and
  `[tableau-webhook] armed` / `[daily-brief] armed`.
- Slack: bot answers a mention and a DM; `/slack/install` completed.
- Tableau: ask the agent a data question in Slack — it should query the private
  MCP and answer.
- Daily trigger: in EventBridge, the `*-vha-daily` rule is **Enabled**; its next
  run posts to `/jobs/vha-daily/<secret>`.

## Teardown

`terraform destroy` removes everything. Secrets Manager secrets have a recovery
window (default 30 days) unless force-deleted. The Aurora cluster is created with
`skip_final_snapshot = true`, so destroy will not leave a snapshot behind.
