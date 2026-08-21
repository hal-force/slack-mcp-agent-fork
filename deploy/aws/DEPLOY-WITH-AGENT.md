# Deploy with an AI agent (Claude Code + the deployment skill)

**Audience:** an operator standing up the Tableau + Slack agent stack on AWS who wants
to be *guided* through it conversationally instead of running the commands by hand.
**Companion:** if you'd rather run the raw commands yourself, use
[`DEPLOY-SCRIPTED.md`](DEPLOY-SCRIPTED.md) — same stack, no agent.

> **What "the skill" is.** [`deploy/aws/SKILL.md`](SKILL.md) is a packaged
> **agent skill** (`deploy-tableau-slack-agent-aws`). It's a set of phased
> instructions Claude Code loads and follows to walk you through the deployment,
> pausing to ask you for anything only you have (credentials, IDs) and before any
> billable or irreversible action. This document explains how to *use* that skill.

---

## Why drive it with an agent

The AWS stack is a two-phase Terraform apply with a chicken-and-egg URL step, a
Docker build/push to ECR, and Slack + Tableau wiring afterward. The agent path is
worth it when you want:

- **Guardrails.** The skill is written to **never run `terraform apply` without your
  explicit go-ahead**, and to stop and ask whenever a step needs a value only you have.
  It treats secrets as runtime-only and won't print or commit them.
- **A running explanation.** The agent narrates *why* each step exists (e.g. why the
  MCP server is private, why the first apply leaves `public_base_url` empty) so you're
  supervising, not blindly pasting.
- **Recovery help.** If an apply errors (a retired Aurora engine version, a
  crash-looping App Runner service), the agent reads the output and tells you which
  variable or log line to fix.

If you already know the stack and just want the commands, the scripted runbook is faster.

---

## Prerequisites

Same tooling and accounts as the scripted path — have these ready **before** you start
the agent, because it will ask for them:

- **On your machine:** `terraform` (or `tofu`) ≥ 1.6, `aws` CLI v2 (authenticated —
  `aws sts get-caller-identity` succeeds), `docker`, `git`, `node` ≥ 20.
- **AWS:** an account + credentials that can create VPC / App Runner / RDS / IAM /
  Secrets Manager / ECR / EventBridge resources, and a chosen region.
- **Tableau:** the site base URL, the site content-url name, and a **dedicated**
  Personal Access Token (name + secret) for the MCP server.
- **Slack:** a Slack app (the agent can help you create it from
  [`slack-app-manifest.json`](../../slack-app-manifest.json)) — you'll need its signing
  secret and client id/secret.
- **Three generated secrets** (the agent will remind you, but you can pre-generate):
  ```bash
  openssl rand -base64 32   # TOKEN_ENC_KEY
  openssl rand -hex 32      # TABLEAU_WEBHOOK_SECRET
  openssl rand -hex 32      # VHA_DAILY_JOB_SECRET  (and a SLACK_STATE_SECRET too)
  ```

> **Claude Code needs shell + file access in this repo.** The agent runs `terraform`,
> `docker`, and `aws` on *your* machine through its Bash tool and edits
> `terraform.tfvars` for you. It does not have your AWS credentials except through the
> CLI you've already authenticated.

---

## How to start it

From a Claude Code session opened in this repository:

1. **Invoke the skill by name:**

   ```
   /deploy-tableau-slack-agent-aws
   ```

   (or just ask in plain language: *"Deploy this Tableau + Slack agent stack to my AWS
   account using the deployment skill."*) The skill's phased instructions load into the
   turn and the agent takes it from there.

2. **Answer its prerequisite questions.** It will confirm your tooling, region, Tableau
   details, and Slack app, and ask you to generate/paste the secrets above. Provide
   secrets when asked — they go into `terraform.tfvars` (git-ignored), never into a
   committed file or the chat transcript.

3. **Approve each billable/irreversible step explicitly.** The agent will *plan* and
   then wait. You'll see a permission prompt for each `terraform apply`, `docker push`,
   etc. Read the plan, then approve or decline.

---

## What the agent will do (the six phases)

The skill drives these phases in order; the authoritative step detail lives in
[`SKILL.md`](SKILL.md). At a glance, the agent will:

| Phase | What the agent does | What it will ask you for |
|---|---|---|
| **1. Terraform vars** | Copy `terraform.tfvars.example` → `terraform.tfvars` and fill it in with you | Tableau/Slack/AWS values + the generated secrets |
| **2. ECR + images** | `terraform apply -target` the two ECR repos, then build & push both images (agent + Tableau MCP) | Go-ahead to create the repos and push |
| **3. Full apply + URL re-apply** | First full `apply`; then copy the assigned `agent_service_url` into `public_base_url` and `apply` again (fixes OAuth URL **and** arms the daily-brief schedule) | Go-ahead for each apply |
| **4. Slack wiring** | Tell you the exact Redirect / Event / Interactivity URLs to set, and to install via `/slack/install` | You perform the Slack-console edits (agent can't) |
| **5. Tableau refresh webhook** *(optional)* | Give you the REST call to register a refresh-driven brief | Go-ahead; the webhook secret |
| **6. Native Tableau Alerts & Subscriptions** *(optional, separate)* | Point you at [`NATIVE-TABLEAU-SLACK.md`](NATIVE-TABLEAU-SLACK.md) — delivered by Tableau's own Slack app, not this agent | Admin action on the Tableau site |

Design decisions the agent **won't re-litigate** (they're baked into the Terraform):
the MCP server is private (`DANGEROUSLY_DISABLE_OAUTH=true` is safe *only* because
there's no public ingress), secrets live in Secrets Manager, and Bedrock uses the App
Runner instance role by default (no static AWS key to rotate).

---

## Your responsibilities vs. the agent's

**The agent cannot:**
- Click around the Slack admin console or the AWS console for you — it gives you the
  exact values/URLs and you apply them.
- Invent credentials or IDs — it stops and asks.
- Apply infrastructure without your explicit approval.

**You should:**
- Read each `terraform plan` before approving the `apply`.
- Confirm both App Runner services reach **Running** in the console.
- Keep `terraform.tfvars` out of git (it's already `.gitignore`d — don't override that).

---

## Verifying the result

Ask the agent to verify, or check yourself (this mirrors the scripted doc's checklist):

- **App Runner:** both services **Running**; agent logs show the `11 pass` config gate
  and `[tableau-webhook] armed` / `[daily-brief] armed`.
- **Slack:** the bot answers an `@mention` and a DM; `/slack/install` completed.
- **Tableau:** ask the agent a data question in Slack — it should query the private MCP
  and answer with real numbers, citing the source.
- **Daily trigger:** in EventBridge, the `*-vha-daily` rule is **Enabled**.

---

## Going to production

The stack this skill deploys uses **throwaway demo defaults**. When you're ready for a
real deployment, don't mutate the demo stack — stand up a **separate** one (its own
`name_prefix` and remote state) with the opt-in hardening knobs turned on: Aurora
deletion protection + final snapshots + longer backup retention, a customer-managed KMS
key for secrets, pinned image digests, and CloudWatch alarms. All of them default to the
demo behavior, so they're purely additive. See [`SKILL.md`](SKILL.md) → *Production
deployment* and [`terraform/README.md`](terraform/README.md) → *Production hardening*
(start from `terraform.tfvars.prod.example`).

## Teardown

Ask the agent to tear down, or run `terraform destroy` yourself. It removes everything;
Secrets Manager entries keep a recovery window (default 30 days) unless force-deleted.
On the **demo** stack the Aurora cluster uses `skip_final_snapshot = true` (no leftover
snapshot). A **production** stack with `db_deletion_protection = true` /
`db_skip_final_snapshot = false` will refuse to destroy until protection is removed and
will leave a final snapshot behind — intended, so double-check before tearing down.

---

## Where the detail lives

- **The skill itself (phase-by-phase):** [`SKILL.md`](SKILL.md)
- **Terraform mechanics & networking model:** [`terraform/README.md`](terraform/README.md)
- **The Tableau MCP image:** [`../tableau-mcp/README.md`](../tableau-mcp/README.md)
- **Native Tableau Alerts & Subscriptions (admin):** [`NATIVE-TABLEAU-SLACK.md`](NATIVE-TABLEAU-SLACK.md)
- **The no-agent command runbook:** [`DEPLOY-SCRIPTED.md`](DEPLOY-SCRIPTED.md)
