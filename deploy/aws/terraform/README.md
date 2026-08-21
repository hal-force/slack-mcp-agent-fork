# AWS deployment (Terraform)

Deploys two AWS App Runner services fronting an existing Tableau site and a
Slack app:

- **tableau-mcp** — private (VPC-only) Tableau MCP server.
- **slack-agent** — public Slack + Tableau agent, with VPC egress to reach
  tableau-mcp privately.

Plus supporting infrastructure: a VPC (optional), Aurora Serverless v2
PostgreSQL, ECR repositories, Secrets Manager entries, IAM roles, and a daily
EventBridge-driven trigger for the VHA brief job.

## Prerequisites

- Terraform >= 1.6, or OpenTofu >= 1.6 (the remote-state example uses native
  S3 lockfiles, which need Terraform/OpenTofu >= 1.10 — see *Production hardening*).
- AWS CLI, authenticated to the target account
- Docker, for building the two images
- `terraform.tfvars` filled in from `terraform.tfvars.example` (never commit
  the real file)

## Order of operations

Two-phase apply is required because `aws_apprunner_service` validates the
image at create time, but the ECR repositories the images live in are also
managed by this same Terraform config.

### Phase 1 — create the ECR repos, push images

```bash
cd deploy/aws/terraform
terraform init
terraform apply \
  -target=aws_ecr_repository.tableau_mcp \
  -target=aws_ecr_repository.slack_agent

# Note the two repository_url values from the plan output, then:
aws ecr get-login-password --region <aws_region> \
  | docker login --username AWS --password-stdin <account_id>.dkr.ecr.<aws_region>.amazonaws.com

docker build --platform linux/amd64 --provenance=false --sbom=false \
  -t <tableau_mcp_repo_url>:latest ../../tableau-mcp
docker push <tableau_mcp_repo_url>:latest

docker build --platform linux/amd64 --provenance=false --sbom=false \
  -t <slack_agent_repo_url>:latest ../../..   # repo root (Dockerfile)
docker push <slack_agent_repo_url>:latest
```

> **All three build flags matter on every machine.** `--platform linux/amd64` is the
> only architecture App Runner runs; `--provenance=false --sbom=false` stop BuildKit
> from pushing an **OCI image index** (multi-manifest list) that App Runner cannot pull
> — the deploy then fails with an opaque "image not found / manifest" error. Verify with
> `docker manifest inspect <repo_url>:latest` (want `manifest.v2+json`, not `index.v1+json`).

### Phase 2 — full apply

```bash
terraform apply
```

This creates the VPC (if `create_vpc = true`), Aurora cluster, secrets, IAM
roles, both App Runner services, the VPC connector/ingress-connection pair,
and (if `enable_daily_schedule = true`) the daily EventBridge trigger.

### PUBLIC_BASE_URL chicken-and-egg

The agent needs to know its own public HTTPS URL (for Slack OAuth redirects
and the VHA daily-brief link), but App Runner only assigns that domain once
the service exists.

1. Leave `public_base_url = ""` for the first full apply.
2. Run `terraform output agent_service_url` and copy the value into
   `terraform.tfvars` as `public_base_url`.
3. Run `terraform apply` again. This updates `PUBLIC_BASE_URL` on the agent
   and — for the first time — creates the VHA daily-brief EventBridge rule
   and API destination (see below; they're intentionally skipped entirely
   until `public_base_url` is set, not just created with a broken URL).

## Wiring up Slack afterward

After `agent_service_url` is known (see above), in your Slack app
configuration set:

- **OAuth Redirect URL**: `<agent_service_url>/slack/oauthcallback`
- **Install URL** (for the install flow / "Add to Slack" button):
  `<agent_service_url>/slack/install`

Also see the `next_steps` Terraform output, which prints both URLs plus the
Tableau webhook URL pattern.

## Networking model (why it's built this way)

- `tableau-mcp` is bound to an `aws_apprunner_vpc_ingress_connection`, which
  in turn is bound to a VPC interface endpoint
  (`com.amazonaws.<region>.apprunner.requests`) in the private subnets. That
  gives the MCP service a **private DNS name** that only resolves/works from
  inside the VPC — nothing on the public internet can reach it, even though
  App Runner itself is a regional service, not something you deploy "into" a
  subnet directly.
- `slack-agent` gets **outbound** access into that same VPC via an
  `aws_apprunner_vpc_connector` (`egress_type = "VPC"`), so it can resolve
  and call the MCP's private domain. Its `TABLEAU_MCP_SERVER` env var is set
  to `https://<vpc-ingress-connection domain>/tableau-mcp`, and
  `TABLEAU_MCP_ALLOW_PRIVATE=1` is required because the agent's own SSRF
  guard (`src/assistant/urlSafety.js`) otherwise refuses to call private/
  internal hostnames by default.
- Neither service has an HTTP `/health` route, so both App Runner health
  checks are configured as `protocol = "TCP"` (port-open checks), not HTTP
  path checks.
- `DANGEROUSLY_DISABLE_OAUTH=true` on the MCP service is safe **only**
  because that service is private/VPC-only — nothing outside the VPC can
  ever open a connection to it to exploit the disabled OAuth check.

## Daily VHA brief trigger — implementation note

The spec for this stack originally called for `aws_scheduler_schedule`
(the standalone "EventBridge Scheduler" service) targeting an EventBridge
API destination. That combination does not exist: Scheduler's `target` only
supports a fixed list of templated AWS-service targets (SQS, SNS, Lambda,
Step Functions, ECS, Kinesis, Firehose, CodeBuild, CodePipeline, Inspector,
SageMaker) plus "universal" `arn:aws:scheduler:::aws-sdk:{service}:{action}`
targets — confirmed against the AWS Scheduler API reference. There is no
API-destination target type on Scheduler.

`scheduler.tf` instead uses a plain **EventBridge rule**
(`aws_cloudwatch_event_rule` with `schedule_expression` set directly on the
rule) whose target (`aws_cloudwatch_event_target`) is an
`aws_cloudwatch_event_api_destination`. This does support arbitrary HTTPS
targets and is the AWS-documented way to cron-trigger an HTTPS endpoint from
EventBridge.

The route it calls (`POST /jobs/vha-daily/<secret>`) authenticates via a
secret embedded in the URL **path**, not a header — see
`src/jobs/dailyBriefTrigger.js`. The `aws_cloudwatch_event_connection`'s
`auth_parameters.api_key` block is required by the API_KEY connection schema
but is a placeholder the app never inspects.

All resources in `scheduler.tf` are gated on `local.create_schedule =
var.enable_daily_schedule && public_base_url != ""`, not on
`enable_daily_schedule` alone — `invocation_endpoint` is a required,
must-be-a-valid-URL argument, and `public_base_url` is empty on the very
first full apply (see the chicken-and-egg step above), so creating these
resources before that step would fail immediately. They appear on the first
apply *after* `public_base_url` is set.

Set `enable_daily_schedule = false` to skip creating any of this permanently.

## Files

| File | Purpose |
|---|---|
| `versions.tf` | Terraform + provider version constraints. |
| `variables.tf` | All input variables (incl. the opt-in production-hardening knobs). |
| `locals.tf` | Shared naming/tag locals. |
| `network.tf` | VPC (optional) + security groups. |
| `ecr.tf` | Two ECR repos + lifecycle policies (keep last 10 images). |
| `secrets.tf` | Secrets Manager secrets + versions, built from a filtered map so empty optional LLM secrets are skipped. `kms_key_id` is the CMK when `create_secrets_kms_key = true`, else the AWS-managed key. |
| `rds.tf` | Aurora Serverless v2 PostgreSQL cluster + master password + DATABASE_URL construction. Wires the durability knobs (deletion protection, final snapshot, backup retention). |
| `iam.tf` | Access roles (ECR pull) + instance roles (runtime AWS API calls) for both services; each instance role gets a `kms:Decrypt` statement only when the CMK exists. |
| `kms.tf` | Optional customer-managed KMS key (rotation + alias), gated on `create_secrets_kms_key`. |
| `apprunner.tf` | Both `aws_apprunner_service` resources, the VPC connector (egress), the VPC interface endpoint + VPC ingress connection (ingress). Uses `repo@sha256:…` when an image digest is pinned, else `repo:tag`. |
| `monitoring.tf` | Optional SNS topic + CloudWatch alarms (App Runner 5xx, Aurora CPU/connections), gated on `create_alarms`. |
| `scheduler.tf` | Daily VHA brief trigger via EventBridge rule + API destination (see note above). |
| `outputs.tf` | Service URLs, ECR URLs, RDS endpoint, and a next-steps reminder. |
| `terraform.tfvars.example` | Fully commented example vars file (demo defaults). |
| `terraform.tfvars.prod.example` | Same, with every production-hardening knob turned on. |
| `backend.tf.prod-example` / `backend-prod.hcl.example` | Remote S3 state scaffolding (inert until copied to `backend.tf` / `backend-prod.hcl`, which are gitignored). |

## TLS to Aurora

The agent image ships `certs/rds-global-bundle.pem` and is configured with
`PGSSLROOTCERT=certs/rds-global-bundle.pem` so Prisma verifies the RDS CA
chain strictly. `DATABASE_URL` is intentionally a plain host-based
connection string with no `sslmode` query parameter — certificate
verification is driven by `PGSSLROOTCERT`, not the URL.

## Production hardening (opt-in knobs)

The defaults above stand up a **throwaway demo** stack. Every production knob
defaults to that demo behavior, so turning it on is purely additive — a demo
`plan` that omits them is unchanged. For a real deployment, stand up a
**separate** stack (own `name_prefix`, own remote state) rather than mutating a
live demo; copy `terraform.tfvars.prod.example` as your starting point. See
[`../SKILL.md`](../SKILL.md) → *Production deployment* for the full runbook.

| Knob | Default (demo) | Production |
|---|---|---|
| `db_deletion_protection` | `false` | `true` — blocks accidental cluster deletion |
| `db_skip_final_snapshot` | `true` | `false` — keeps a recoverable snapshot on destroy |
| `db_backup_retention_period` | `1` | `7`–`35` days |
| `create_secrets_kms_key` | `false` (AWS-managed key) | `true` — customer-managed CMK with rotation + per-principal `kms:Decrypt` auditing |
| `agent_image_digest` / `mcp_image_digest` | `""` (mutable tag) | `sha256:…` — pins the exact image so a re-apply can't silently pull a different build |
| `create_alarms` (+ `alarm_email`) | `false` | `true` — SNS topic + CloudWatch alarms |
| Remote state (`backend.tf`) | local state | S3 backend via `backend-prod.hcl` |

**Never change these on a live stack** — `name_prefix`, `vpc_cidr`, `create_vpc`,
`db_name`, `db_username`, or a major `aurora_engine_version` jump all force
resource **replacement** (they rebuild the VPC and/or destroy the database). The
durability/KMS/monitoring/digest knobs above are all safe in-place changes.

> Enabling `create_secrets_kms_key` on an **already-deployed** stack only re-keys
> *future* secret versions; existing values stay under the AWS-managed key until
> each secret is next rewritten. Prefer enabling it on a fresh stack.
