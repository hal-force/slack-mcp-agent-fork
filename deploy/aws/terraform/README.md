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

- Terraform >= 1.6
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

docker build -t <tableau_mcp_repo_url>:latest ../../tableau-mcp
docker push <tableau_mcp_repo_url>:latest

docker build -t <slack_agent_repo_url>:latest ../../..   # repo root (Dockerfile)
docker push <slack_agent_repo_url>:latest
```

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
| `variables.tf` | All input variables. |
| `locals.tf` | Shared naming/tag locals. |
| `network.tf` | VPC (optional) + security groups. |
| `ecr.tf` | Two ECR repos + lifecycle policies (keep last 10 images). |
| `secrets.tf` | Secrets Manager secrets + versions, built from a filtered map so empty optional LLM secrets are skipped. |
| `rds.tf` | Aurora Serverless v2 PostgreSQL cluster + master password + DATABASE_URL construction. |
| `iam.tf` | Access roles (ECR pull) + instance roles (runtime AWS API calls) for both services. |
| `apprunner.tf` | Both `aws_apprunner_service` resources, the VPC connector (egress), the VPC interface endpoint + VPC ingress connection (ingress). |
| `scheduler.tf` | Daily VHA brief trigger via EventBridge rule + API destination (see note above). |
| `outputs.tf` | Service URLs, ECR URLs, RDS endpoint, and a next-steps reminder. |
| `terraform.tfvars.example` | Fully commented example vars file. |

## TLS to Aurora

The agent image ships `certs/rds-global-bundle.pem` and is configured with
`PGSSLROOTCERT=certs/rds-global-bundle.pem` so Prisma verifies the RDS CA
chain strictly. `DATABASE_URL` is intentionally a plain host-based
connection string with no `sslmode` query parameter — certificate
verification is driven by `PGSSLROOTCERT`, not the URL.

## Attribute confidence notes

See the parent task's final report for the short list of AWS attributes that
were cross-checked against the provider docs during authoring but are worth
a `terraform validate` / `plan` pass to double-confirm in your provider
version, since Terraform is not installed on the authoring machine and no
`validate`/`plan`/`apply` was run.
