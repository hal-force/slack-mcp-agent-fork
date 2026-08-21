#!/usr/bin/env bash
#
# Secret-injecting wrapper for the parallel AWS stack.
#
# Contains NO secret values. It reads every secret at RUNTIME from:
#   - .secrets-scratch/*.txt              (freshly generated: token_enc_key,
#                                          state secret, webhook/daily/triage)
#   - .secrets-scratch/app-create-response.json  (new Slack app's client id /
#                                          client secret / signing secret)
#   - Heroku (live)                       (reused Tableau PAT — never on disk)
# and exports them as TF_VAR_* so Terraform/OpenTofu never sees them in a file.
#
# terraform.tfvars holds only NON-secret values. Precedence: TF_VAR_* env is
# LOWER than *.tfvars, but the secret vars are ABSENT from tfvars, so the env
# values win uncontested.
#
# Usage (run from deploy/aws/terraform):
#   ./apply.sh plan
#   ./apply.sh apply -target=aws_ecr_repository.tableau_mcp -target=aws_ecr_repository.slack_agent
#   ./apply.sh apply
#   PUBLIC_BASE_URL=https://xxxx.us-west-2.awsapprunner.com ./apply.sh apply   # phase-3 re-apply
#
set -euo pipefail

TF="${TF_BIN:-tofu}"                       # OpenTofu stands in for terraform
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(cd "$HERE/../../../.secrets-scratch" && pwd)"
RESP="$SCRATCH/app-create-response.json"

die() { echo "apply.sh: $*" >&2; exit 1; }

# ---- preconditions -------------------------------------------------------
command -v "$TF"  >/dev/null || die "'$TF' not found (set TF_BIN=terraform if you use terraform)"
command -v jq     >/dev/null || die "jq not found"
command -v heroku >/dev/null || die "heroku CLI not found (needed to read the reused Tableau PAT)"
[ -f "$RESP" ] || die "missing $RESP (create the Slack app first)"
for f in token_enc_key.txt slack_state_secret.txt tableau_webhook_secret.txt vha_daily_job_secret.txt triage_admission_secret.txt; do
  [ -s "$SCRATCH/$f" ] || die "missing/empty scratch secret: $f"
done

# ---- Slack app credentials (from the create response) --------------------
export TF_VAR_slack_client_id="$(jq -r '.credentials.client_id'     "$RESP")"
export TF_VAR_slack_client_secret="$(jq -r '.credentials.client_secret' "$RESP")"
export TF_VAR_slack_signing_secret="$(jq -r '.credentials.signing_secret' "$RESP")"
[ -n "$TF_VAR_slack_client_id" ] && [ "$TF_VAR_slack_client_id" != "null" ] || die "no client_id in $RESP"

# ---- Generated app secrets (from scratch files) --------------------------
export TF_VAR_slack_state_secret="$(cat "$SCRATCH/slack_state_secret.txt")"
export TF_VAR_token_enc_key="$(cat "$SCRATCH/token_enc_key.txt")"
export TF_VAR_tableau_webhook_secret="$(cat "$SCRATCH/tableau_webhook_secret.txt")"
export TF_VAR_vha_daily_job_secret="$(cat "$SCRATCH/vha_daily_job_secret.txt")"
TRIAGE_ADMISSION_SECRET="$(cat "$SCRATCH/triage_admission_secret.txt")"

# ---- Reused Tableau PAT (live from Heroku; never written to disk) --------
export TF_VAR_tableau_pat_value="$(heroku config:get PAT_VALUE --app federal-tableau-mcp)"
[ -n "$TF_VAR_tableau_pat_value" ] || die "empty Tableau PAT from Heroku (federal-tableau-mcp PAT_VALUE)"

# ---- extra_env map (non-secret triage config + the one secret) -----------
DS_MAP='{"patients":"7175a4b8-12da-4841-a086-1f7a8d23d097","nurses":"23cfb818-5f16-43e7-9330-2ffec52fb0a4","nurse_skills":"e20a25b2-4ca4-4907-95df-39449511197d","patient_required_skills":"6700aefa-a97a-4bc8-8ddb-b7053d91ff7f","assignments":"2f55fca8-b0ef-4b56-84fe-502164b8aaaa","unit_snapshots":"ccb0608b-c9d5-4edc-917b-1a4c94089052","clinical_notes":"adc9f76f-0f48-44d6-bda5-e4c677838abd","skills_reference":"4cece611-c264-44b4-9af4-1d12efeacc0c"}'
export TF_VAR_extra_env="$(jq -nc \
  --arg triage "$TRIAGE_ADMISSION_SECRET" \
  --arg dsmap "$DS_MAP" \
  '{
     AGENTS_ENABLED: "1",
     TRIAGE_CHANNEL_ID: "C0BREK3616E",
     TRIAGE_ADMISSION_SECRET: $triage,
     TRIAGE_MCP_DATASOURCES: $dsmap,
     TABLEAU_MCP_DATASOURCE_LIST_LIMIT: "250",
     TABLEAU_MCP_LIST_DATA_SOURCES: "1",
     LLM_MAX_OUTPUT_TOKENS: "64000"
   }')"

# ---- Optional PUBLIC_BASE_URL override for the phase-3 re-apply ----------
if [ -n "${PUBLIC_BASE_URL:-}" ]; then
  export TF_VAR_public_base_url="$PUBLIC_BASE_URL"
fi

cd "$HERE"
exec "$TF" "$@"
