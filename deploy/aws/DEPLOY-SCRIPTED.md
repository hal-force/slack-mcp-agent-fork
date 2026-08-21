# Deploy scripted (no agent) — command runbook

**Audience:** an engineer who wants to run the Tableau + Slack agent AWS deployment
**by hand**, command by command, without an AI agent driving it.
**Companion:** if you'd rather be guided conversationally, use
[`DEPLOY-WITH-AGENT.md`](DEPLOY-WITH-AGENT.md) — same stack, same result.

This is the deterministic sequence. Every step is a command you run or a value you set.
It matches the phased skill in [`SKILL.md`](SKILL.md) and the Terraform mechanics in
[`terraform/README.md`](terraform/README.md); read those for the *why*, this doc for the *what*.

> ⚠️ **This provisions real, billable AWS infrastructure** — 2× App Runner services, an
> Aurora Serverless v2 cluster, a NAT gateway, Secrets Manager entries, ECR repos, and an
> EventBridge rule. `terraform destroy` (last section) removes it. Never run `apply`
> against the wrong account — check `aws sts get-caller-identity` first.

---

## 0. Prerequisites

Confirm all of these before you start:

```bash
terraform version        # >= 1.6   (or: tofu version)
aws --version            # v2
aws sts get-caller-identity   # authenticated to the TARGET account, in the right region
docker version
node --version           # >= 20
git rev-parse --show-toplevel # you're inside this repo
```

Have ready:

- **Tableau:** site base URL (`https://….online.tableau.com`), site content-url name, and
  a **dedicated** PAT (name + secret) for the MCP server — do not reuse it for ad-hoc REST.
- **Slack:** an app with signing secret + client id/secret (create from
  [`slack-app-manifest.json`](../../slack-app-manifest.json) if needed).
- **Region + account id.**

Generate the crypto/path secrets (don't reuse anything):

```bash
openssl rand -base64 32   # -> token_enc_key
openssl rand -hex 32      # -> tableau_webhook_secret
openssl rand -hex 32      # -> vha_daily_job_secret
openssl rand -hex 32      # -> slack_state_secret
```

---

## 1. Fill in Terraform variables

```bash
cd deploy/aws/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
```

Fill every `REPLACE_ME`. The key groups (see the annotated example for the rest):

| Var | Value |
|---|---|
| `aws_region`, `name_prefix` | your region; a short prefix (e.g. `tableau-slack`) |
| `create_vpc` | `true` unless reusing an existing VPC (then set `vpc_id` + subnet ids) |
| `tableau_server_url`, `tableau_site_name`, `tableau_pat_name`, `tableau_pat_value` | from Tableau |
| `slack_signing_secret`, `slack_client_id`, `slack_client_secret`, `slack_state_secret` | from Slack + generated |
| `token_enc_key`, `tableau_webhook_secret`, `vha_daily_job_secret` | generated above |
| `ai_provider = "bedrock"`, `bedrock_model_id` | e.g. `us.anthropic.claude-sonnet-4-6`; leave `aws_bearer_token_bedrock = ""` to use the instance role |
| `public_base_url` | **leave `""`** for the first apply (App Runner assigns it — see step 3) |
| `enable_daily_schedule`, `daily_schedule_cron` | `true` + a UTC cron (default `cron(0 14 * * ? *)`) |

> **Never commit `terraform.tfvars`** — it holds live secrets and is already `.gitignore`d.

---

## 2. Create the ECR repos, then build & push both images

App Runner validates the image at create time, but the ECR repos are Terraform resources
too — so create just the repos first, then push images into them:

```bash
cd deploy/aws/terraform
terraform init
terraform apply \
  -target=aws_ecr_repository.tableau_mcp \
  -target=aws_ecr_repository.slack_agent
```

Note the two `repository_url` outputs, then from the **repo root** authenticate and push.
**All three build flags matter on every machine** (not just Apple silicon):
`--platform linux/amd64` is the only architecture App Runner runs, and
`--provenance=false --sbom=false` stop modern Docker/BuildKit from pushing an **OCI
image index** (a multi-manifest list) that App Runner cannot pull — which fails the
deploy with an opaque "image not found / manifest" error.

```bash
AWS_REGION=<region>; ACCOUNT=<account-id>
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"

# Slack agent (root Dockerfile)
docker build --platform linux/amd64 --provenance=false --sbom=false \
  -t <slack_agent_repo_url>:latest .
docker push <slack_agent_repo_url>:latest

# Tableau MCP (pinned upstream ref)
docker build --platform linux/amd64 --provenance=false --sbom=false \
  --build-arg TABLEAU_MCP_REF=v4.5.1 -t <tableau_mcp_repo_url>:latest deploy/tableau-mcp
docker push <tableau_mcp_repo_url>:latest
```

> Verify a good push with `docker manifest inspect <repo_url>:latest` — you want a
> single `mediaType: …manifest.v2+json`, **not** `…index.v1+json`.

---

## 3. First full apply, then the public-URL re-apply

```bash
cd deploy/aws/terraform
terraform apply          # VPC, Aurora, secrets, IAM, both App Runner services, VPC connector/ingress
```

App Runner now assigns the agent a public domain. Resolve the chicken-and-egg:

```bash
terraform output agent_service_url          # copy this value
```

1. Set `public_base_url = "https://<that-domain>"` in `terraform.tfvars`.
2. Re-apply:

   ```bash
   terraform apply
   ```

The second apply fixes the agent's `PUBLIC_BASE_URL` **and** creates the EventBridge
daily-brief rule (intentionally skipped until `public_base_url` is set — see
`scheduler.tf`). Confirm **both** services reach **Running** in the App Runner console.
The agent runs the same deploy gate as Heroku on start (`prisma migrate deploy` +
`health:configcheck`); a crash-loop means the config gate failed — read the App Runner
logs, they print exactly which var is wrong.

---

## 4. Point the Slack app at the deployment

In **api.slack.com/apps → your app**, replace every URL host with the
`agent_service_url` domain:

| Setting | Value |
|---|---|
| OAuth & Permissions → **Redirect URL** | `https://<agent>/slack/oauthcallback` |
| Event Subscriptions → **Request URL** | `https://<agent>/slack/events` |
| Interactivity & Shortcuts → **Request URL** | `https://<agent>/slack/events` |
| **Install URL** | `https://<agent>/slack/install` |

Confirm **Bot Token Scopes** include everything in `slack_bot_scopes` — the install
requests scopes from that var, **not** the manifest, so a missing scope there (e.g.
`im:write` for DMs, `files:write` for chart uploads) silently breaks those features.

Then install to the workspace via **`https://<agent>/slack/install`** — use this flow,
**not** the admin "Reinstall" button (only `/slack/install` writes to the app's install
store). Verify: `@mention` the bot in a channel, or DM it.

---

## 5. Register the Tableau refresh webhook (optional — push brief)

Only if the partner wants a brief pushed on each data-source refresh (the daily
EventBridge trigger already covers the scheduled cadence):

```
POST https://<tableau-site>/api/3.22/sites/<site-luid>/webhooks
```

with the nested body form (`webhook-source-event-datasource-refresh-succeeded`) pointing at:

```
https://<agent>/webhooks/tableau/refresh/<TABLEAU_WEBHOOK_SECRET>
```

See [`../../demo-data/vha/DAILY-BRIEF-DESIGN.md`](../../demo-data/vha/DAILY-BRIEF-DESIGN.md).

---

## 6. Native Tableau Alerts & Subscriptions (optional — separate system)

This is **not** delivered by this agent — it's Tableau's own Slack app, configured
**per Tableau site** (and it must be the *same site* whose data users alert on). Admin
runbook: [`NATIVE-TABLEAU-SLACK.md`](NATIVE-TABLEAU-SLACK.md).

---

## Verify & hand off

- **App Runner:** both services **Running**; agent logs show `11 pass` config gate and
  `[tableau-webhook] armed` / `[daily-brief] armed`.
- **Slack:** bot answers a mention and a DM; `/slack/install` completed.
- **Tableau:** ask a data question in Slack → the agent queries the private MCP and answers.
- **Daily trigger:** the `*-vha-daily` EventBridge rule is **Enabled**; its next run POSTs
  to `/jobs/vha-daily/<secret>`.

Optional post-deploy readiness check (live reachability, run by hand):

```bash
npm run health:smoke     # configcheck + "is the LLM/Tableau reachable" pings
```

---

## Multi-agent / triage surface (optional, off by default)

The triage capability is gated and ships **off**. To enable it on this deployment, add
to `extra_env` (or the App Runner env) and re-apply:

| Var | Purpose |
|---|---|
| `AGENTS_ENABLED=1` | Turn on the supervisor + specialist path (default off = exact baseline) |
| `TRIAGE_ADMISSION_SECRET=<hex>` | Arms `POST /triage/admission/<secret>`; without it the route refuses to mount |
| `TRIAGE_CHANNEL_ID=C…` | Default channel for the admission card |
| `TRIAGE_MCP_DATASOURCES={…}` | JSON `table→datasourceLUID` map to run triage tools against published Tableau sources (else local CSV fixture) |
| `AGENT_TRIAGE_MODEL_ID=…` | Pin the Bedrock model for reproducible behavior |

See [`../../docs/TRIAGE-METHODS-AND-SCORING.md`](../../docs/TRIAGE-METHODS-AND-SCORING.md).

---

## Teardown

```bash
cd deploy/aws/terraform
terraform destroy
```

Removes everything. Secrets Manager secrets keep a recovery window (default 30 days)
unless force-deleted; on the **demo** stack the Aurora cluster uses
`skip_final_snapshot = true`, so no snapshot is left behind. A **production** stack with
`db_deletion_protection = true` / `db_skip_final_snapshot = false` refuses to destroy
until protection is removed and leaves a final snapshot — intended; double-check first.

---

## Going to production

These steps stand up a **throwaway demo**. For a real deployment, stand up a **separate**
stack (own `name_prefix`, own remote state) with the opt-in hardening knobs on rather than
mutating the demo. Copy `terraform.tfvars.prod.example` instead of the plain example, then
enable: Aurora deletion protection + final snapshot + 7–35-day backup retention, a
customer-managed KMS key (`create_secrets_kms_key`), pinned image digests
(`agent_image_digest` / `mcp_image_digest`), and CloudWatch alarms (`create_alarms`). Each
defaults to the demo behavior, so turning it on is additive. Use the S3 remote-state backend
(`backend.tf.prod-example`) before the first prod apply. Full runbook: [`SKILL.md`](SKILL.md)
→ *Production deployment*; knob reference: [`terraform/README.md`](terraform/README.md) →
*Production hardening*.

---

## Troubleshooting quick reference

| Symptom | Cause / fix |
|---|---|
| App Runner service crash-loops on start | Config gate failed — read logs; a missing/malformed var is named. |
| `apply` rejects the Aurora engine version | AWS retired that point release for new clusters — set `aurora_engine_version` to one offered in your region. |
| Agent can't reach the MCP | `TABLEAU_MCP_SERVER` must be the VPC-ingress domain + `TABLEAU_MCP_ALLOW_PRIVATE=1` (the SSRF guard blocks private hosts otherwise) — the Terraform sets both. |
| Daily-brief rule never created | You skipped the second apply — `public_base_url` was still `""`. Set it and re-apply. |
| Slack DMs silently fail | `im:write` missing from `slack_bot_scopes`; add it and reinstall via `/slack/install`. |
| `docker push` rejected by App Runner | Image isn't `linux/amd64` — rebuild with `--platform linux/amd64`. |
| App Runner CREATE_FAILED with an opaque "image not found / manifest" error | BuildKit pushed an **OCI image index**, which App Runner can't pull. Rebuild with `--provenance=false --sbom=false`; verify with `docker manifest inspect` (want `manifest.v2+json`, not `index.v1+json`). |
| `slack-agent` CREATE_FAILED on the TCP health check, logs show `LLM provider FAIL … AI_PROVIDER=bedrock but config incomplete` | The instance role isn't being read as Bedrock creds — confirm the running image includes the role-aware `bedrockConfig()` (App Runner sets no static AWS keys). |
