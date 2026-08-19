#!/usr/bin/env bash
# One-shot publisher for the VHA Localized Metric Review demo sources.
#
# WHY THIS SCRIPT EXISTS
#   The Tableau PAT secret must never be written to disk or appear on a
#   command line / shell history (standing rule for this project). This
#   script reads the secret from a SILENT prompt (read -s), exports it only
#   into the child process environment for the single publish call, then the
#   process exits and the variable is gone. Nothing is persisted.
#
#   NOTE: the secret stored in the macOS Keychain from a prior session is
#   STALE — a sign-in with it returns "401001: the personal access token you
#   provided is invalid" (Tableau PATs expire after ~15 days idle or on
#   rotation). Mint/regenerate the "Prep Agent key" PAT in usfederaldemos (My
#   Account Settings -> Personal Access Tokens) and paste the fresh secret. We
#   set the secret in the environment, which the skill's credential discovery
#   prefers over the Keychain — so the stale Keychain value is bypassed, not
#   relied on. (Non-secret routing below happens to match the Keychain too.)
#
# WHAT IT DOES
#   Runs the tableau-prep-etl skill's run_loop with --publish against the
#   VHA spec. On a Tableau Cloud site the skill uploads the built .hyper
#   extracts as published data sources (Cloud backgrounder can't reach the
#   local CSVs) into the "VA | Veterans Affairs" project, applying each
#   source's description/metadata, so the Slack agent's Tableau MCP on
#   usfederaldemos gets queryable, legible data.
#
# USAGE
#   bash demo-data/vha/publish.sh
#   (paste the "Prep Agent key" PAT secret when prompted — it will not echo)
#
#   Override any non-secret value by exporting it first, e.g. a different
#   token name:  TABLEAU_SERVER_PAT_NAME="MyToken" bash demo-data/vha/publish.sh
#
# The PAT name ("Claude"), site ("usfederaldemos"), pod URL, and target
# project are NOT secrets and are set below.

set -euo pipefail

SKILL_DIR="$HOME/claude-projects/tableau-prep-etl-skill"
SPEC="$HOME/claude-projects/heroku-slack/slack-mcp-agent/demo-data/vha/spec.json"
RUN_DIR="$HOME/claude-projects/heroku-slack/slack-mcp-agent/demo-data/vha/.prep-run"

# --- Non-secret routing (safe to hard-code; overridable via env) ---
export TABLEAU_SERVER_URL="${TABLEAU_SERVER_URL:-https://prod-useast-a.online.tableau.com}"
export TABLEAU_SERVER_SITE="${TABLEAU_SERVER_SITE:-usfederaldemos}"
export TABLEAU_SERVER_PAT_NAME="${TABLEAU_SERVER_PAT_NAME:-Prep Agent key}"

# --- Secret: read silently, never stored, never echoed ---
if [[ -z "${TABLEAU_SERVER_PAT_SECRET:-}" ]]; then
  printf 'Paste the fresh "%s" PAT secret for %s (input hidden): ' \
    "${TABLEAU_SERVER_PAT_NAME}" "${TABLEAU_SERVER_SITE}" >&2
  read -rs TABLEAU_SERVER_PAT_SECRET
  printf '\n' >&2
  export TABLEAU_SERVER_PAT_SECRET
fi

if [[ -z "${TABLEAU_SERVER_PAT_SECRET}" ]]; then
  echo "No PAT secret provided — aborting." >&2
  exit 1
fi

echo "Publishing to site '${TABLEAU_SERVER_SITE}' at ${TABLEAU_SERVER_URL} ..." >&2
echo "(PAT name: ${TABLEAU_SERVER_PAT_NAME}; secret: [hidden]; project: 'VA | Veterans Affairs')" >&2

# NOTE: no --auto-create-project. The "VA | Veterans Affairs" project already
# exists; if the spec's project name doesn't match exactly, the skill bounces
# back as needs_user_decision rather than creating a duplicate folder.
cd "$SKILL_DIR"
exec python3 -m skill.scripts.run_loop \
  --spec "$SPEC" \
  --flow-name vha_localized_metrics \
  --run-dir "$RUN_DIR" \
  --skip-scan \
  --publish
