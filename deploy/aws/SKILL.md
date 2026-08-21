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
docker build --platform linux/amd64 --provenance=false --sbom=false \
  -t <slack_agent_repo_url>:latest .
docker push <slack_agent_repo_url>:latest

# Tableau MCP (pinned upstream build; the Dockerfile defaults to v4.5.1)
docker build --platform linux/amd64 --provenance=false --sbom=false \
  --build-arg TABLEAU_MCP_REF=v4.5.1 -t <tableau_mcp_repo_url>:latest deploy/tableau-mcp
docker push <tableau_mcp_repo_url>:latest
```

> **All three flags matter, on every machine — not just Apple silicon:**
> - `--platform linux/amd64` — the only architecture App Runner runs.
> - `--provenance=false --sbom=false` — without these, modern Docker/BuildKit
>   pushes an **OCI image index** (a multi-manifest list) instead of a plain
>   image manifest. App Runner **cannot pull an image index** and the service
>   fails to deploy with an opaque "image not found / manifest" error. Verify a
>   good push with `docker manifest inspect <repo_url>:latest` — you want a
>   single `mediaType: …manifest.v2+json`, not `…index.v1+json`.

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

> **If the first apply fails on the Aurora cluster** with an invalid
> engine-version error, AWS has retired that point release for new clusters. Pick
> a currently-offered one (`aws rds describe-db-engine-versions --engine
> aurora-postgresql --region <region> --query 'DBEngineVersions[].EngineVersion'`)
> and set `aurora_engine_version` in `terraform.tfvars`, then re-apply.
>
> **If `slack-agent` reaches CREATE_FAILED on the TCP health check** while its
> logs show `LLM provider FAIL … AI_PROVIDER=bedrock but config incomplete`, the
> instance role isn't being detected as Bedrock credentials — confirm the running
> image includes the role-aware `bedrockConfig()` (App Runner sets no static AWS
> keys; creds come from the container-credentials endpoint).

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

> **Coverage boundary — the health harness's live suites cannot verify this
> deploy from your laptop.** `npm run health:configcheck` is network-free and
> runs automatically as the in-container startup gate (the `11 pass` above), so
> it *is* validated against the real deployment. But `health:smoke`,
> `health:drift`, and `health:contextrot` run **in-process** against whatever
> environment the runner sees, and two facts make a laptop run misleading:
> 1. They'd use your **local** LLM creds/config, not the App Runner instance
>    role and Secrets Manager values — so they test your laptop, not the stack.
> 2. `smoke`/`drift` ping the Tableau MCP at `TABLEAU_MCP_SERVER`, which is a
>    **VPC-private** domain that only resolves *inside* the VPC. From outside it
>    always fails — a false negative, not a real problem.
>
> So the live suites are only meaningful **inside the running container**. App
> Runner offers no `exec`, so to get a live-reachability signal either (a) add a
> gated `GET /health/smoke` route to the agent and hit it once, or (b) accept the
> startup `configcheck` gate plus a real Slack round-trip (mention + data
> question) as the deploy proof. For a demo stack, (b) is sufficient; don't chase
> a laptop `smoke` pass — it can't succeed against a private MCP.

## Production deployment (hardening beyond the demo)

The demo defaults are deliberately throwaway. For a real deployment, **stand up a
separate stack** (own `name_prefix`, own state) rather than mutating a live demo —
then the demo stays a safe sandbox. Every production knob below defaults to the
demo's current behavior, so turning them on is additive and opt-in.

Copy `terraform.tfvars.prod.example` (not the plain one) as your starting point.

1. **Remote state first (do this before the first prod apply).** Local state on
   one laptop is the biggest operational risk — lose it and Terraform will try to
   recreate live resources. Use the S3 backend:
   - Create a versioned, private state bucket out-of-band.
   - `cp backend.tf.prod-example backend.tf` and
     `cp backend-prod.hcl.example backend-prod.hcl` (fill in real values).
   - `tofu init -backend-config=backend-prod.hcl`.
   - `backend.tf` and `backend-prod.hcl` are gitignored on purpose — activating a
     backend is per-deployment and must never land in the shared repo (it would
     force every demo `init` to a remote backend). Migrating an *existing* local
     state up is also non-destructive (`init -migrate-state`) — but prefer a fresh
     prod stack.
2. **Database durability** (`terraform.tfvars`): `db_deletion_protection = true`,
   `db_skip_final_snapshot = false`, `db_backup_retention_period = 14` (or 7-35).
   These are in-place changes on the cluster — no replacement, no downtime.
3. **Customer-managed KMS key**: `create_secrets_kms_key = true` creates a CMK with
   rotation, encrypts every secret with it, and grants each instance role
   `kms:Decrypt`. Gives you key-policy control and per-principal `kms:Decrypt`
   auditing in CloudTrail (the default AWS-managed key gives neither).
4. **Pin image digests**: after pushing, set `agent_image_digest` /
   `mcp_image_digest` to the `sha256:...` digests (see the example for the
   `aws ecr describe-images` command). A digest pin means a re-apply or auto-deploy
   can never silently pull a different/broken build the way a mutable `:latest` can.
5. **Monitoring**: `create_alarms = true` (+ `alarm_email`) creates an SNS topic and
   CloudWatch alarms for agent 5xx and Aurora CPU/connection saturation.

**Order matters; never change these on a live stack** — `name_prefix`, `vpc_cidr`,
`create_vpc`, `db_name`, `db_username`, or a major `aurora_engine_version` jump all
force resource **replacement** (they rebuild the VPC and/or destroy the database).
Safe changes are the durability/KMS/monitoring/digest knobs above.

### Application-level hardening (agent env vars)

These are agent **environment variables** (set on the App Runner service / Heroku
config, or via `TF_VAR_*` → Secrets Manager), independent of the Terraform infra
knobs above. Each defaults to the demo's current behavior, so setting them is
opt-in and non-breaking:

| Env var | Prod value | Effect |
| --- | --- | --- |
| `REQUIRE_TOKEN_ENC` | `1` | **Fail closed** on token encryption: if `TOKEN_ENC_KEY` is unset, installs are refused with a loud error instead of silently persisting OAuth tokens in plaintext. Pair with a real `TOKEN_ENC_KEY` (`openssl rand -base64 32`). |
| `LLM_REQUEST_TIMEOUT_MS` | `60000` (tune) | Per-request timeout across Bedrock/Vertex/gateway LLM calls, so a hung upstream fails the turn cleanly instead of tying up the instance. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `30` / `60000` | Per-IP cap on the secret-in-path trigger routes (Tableau refresh, daily brief, triage admission), throttling online guessing of a path secret. Generous defaults; real callers fire a handful of times a day. |
| `RATE_LIMIT_DISABLED` | unset | `1` bypasses the limiter (load tests only). |
| `TABLEAU_MCP_ALLOW_PRIVATE` | `1` here | The private-VPC MCP has an internal host, so the deployment-default URL is intentionally private; this relaxes the SSRF guard **for the env URL only**. User-supplied App-Home URLs remain blocked. |

Defensive HTTP response headers (nosniff, `X-Frame-Options: DENY`, `Referrer-Policy`,
and HSTS over TLS) are always on — no configuration, nothing to break on the JSON
routes. See `src/install-kit/httpSecurity.js`.

> **Deferred: per-user Tableau OAuth.** The MCP currently authenticates to Tableau
> with a shared PAT (`AUTH=pat`), and its HTTP endpoint is protected by network
> isolation (private VPC ingress), not a bearer token. True per-user identity
> (`AUTH=oauth`) requires a Tableau connected-app/EAS setup plus an agent-side
> token flow, and an EAS-style config can affect an entire **shared** Tableau
> server — so it belongs on a **dedicated** prod Tableau site, not a shared demo
> server. Build it there as a scoped follow-up.

## Teardown

`terraform destroy` removes everything. Secrets Manager secrets have a recovery
window (default 30 days) unless force-deleted. On the **demo** stack the Aurora
cluster uses `skip_final_snapshot = true`, so destroy leaves no snapshot behind; a
**production** stack with `db_skip_final_snapshot = false` (and/or
`db_deletion_protection = true`) will instead retain a final snapshot / refuse to
destroy until protection is removed — intended, so double-check before tearing down.
