############################################
# Secrets Manager
#
# One secret + one secret version per NAME in local.secret_keys. `for_each`
# keys must be BOTH non-sensitive AND known at plan time, so we drive it off a
# set of plain secret-name strings — never off the secret values themselves:
#
#   - Required secrets are ALWAYS created. Their VALUES may be unknown at plan
#     time (database_url is built from the not-yet-created RDS endpoint), which
#     is fine for a resource ARGUMENT but would be fatal for a for_each KEY —
#     hence keys are static strings, values are looked up separately.
#   - The three alternative LLM-provider secrets (aws_bearer_token_bedrock,
#     llm_gateway_api_key, gcp_service_account_json) are optional; a given
#     deployment sets at most one. We include a name only when its var is
#     non-empty. That emptiness test is derived from a `sensitive` var, so we
#     wrap JUST the boolean in nonsensitive() — this discloses only WHETHER a
#     secret was provided, never its contents, and keeps the key set
#     non-sensitive so for_each accepts it. The var values are root inputs
#     (known at plan time), so the resulting key set is fully determined then.
############################################

locals {
  required_secret_keys = toset([
    "slack_signing_secret",
    "slack_client_id",
    "slack_client_secret",
    "slack_state_secret",
    "token_enc_key",
    "tableau_pat_value",
    "tableau_webhook_secret",
    "vha_daily_job_secret",
    "database_url",
  ])

  optional_secret_values = {
    aws_bearer_token_bedrock = var.aws_bearer_token_bedrock
    llm_gateway_api_key      = var.llm_gateway_api_key
    gcp_service_account_json = var.gcp_service_account_json
  }

  optional_secret_keys = toset([
    for k, v in local.optional_secret_values : k if nonsensitive(trimspace(v) != "")
  ])

  # The full set of secret NAMES to create (non-sensitive, plan-time-known).
  # Other files reference this to decide which optional secrets exist.
  secret_keys = setunion(local.required_secret_keys, local.optional_secret_keys)

  # NAME -> VALUE lookup. Values may be sensitive and/or unknown at plan time;
  # only ever consumed as the `secret_string` argument, never as a for_each key.
  secret_values = merge(
    {
      slack_signing_secret   = var.slack_signing_secret
      slack_client_id        = var.slack_client_id
      slack_client_secret    = var.slack_client_secret
      slack_state_secret     = var.slack_state_secret
      token_enc_key          = var.token_enc_key
      tableau_pat_value      = var.tableau_pat_value
      tableau_webhook_secret = var.tableau_webhook_secret
      vha_daily_job_secret   = var.vha_daily_job_secret
      database_url           = local.database_url
    },
    local.optional_secret_values,
  )
}

resource "aws_secretsmanager_secret" "this" {
  for_each = local.secret_keys

  name = "${local.name}/${each.value}"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "this" {
  for_each = local.secret_keys

  secret_id     = aws_secretsmanager_secret.this[each.value].id
  secret_string = local.secret_values[each.value]
}
