############################################
# IAM
#
# Every App Runner service needs two distinct roles:
#   - an "access role" (trusted by build.apprunner.amazonaws.com) that App
#     Runner uses at deploy time to pull the container image from ECR. This
#     is what AuthenticationConfiguration.access_role_arn points at.
#   - an "instance role" (trusted by tasks.apprunner.amazonaws.com) that the
#     RUNNING application assumes to call other AWS APIs (Secrets Manager,
#     Bedrock, ...). This is InstanceConfiguration.instance_role_arn.
# These are never the same role: one is a build-time pull credential, the
# other is a runtime application credential.
############################################

data "aws_partition" "current" {}

# ---- Trust policies ---------------------------------------------------

data "aws_iam_policy_document" "apprunner_build_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["build.apprunner.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "apprunner_tasks_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["tasks.apprunner.amazonaws.com"]
    }
  }
}

# ---- Which secrets each service's instance role may read --------------

locals {
  mcp_secret_keys = ["tableau_pat_value"]

  # Base secrets every agent deployment needs, plus whichever single LLM
  # secret ended up existing in local.secrets (secrets.tf drops the other
  # two automatically when their vars are empty).
  agent_secret_keys = concat(
    [
      "slack_signing_secret",
      "slack_client_id",
      "slack_client_secret",
      "slack_state_secret",
      "token_enc_key",
      "database_url",
      "tableau_webhook_secret",
      "vha_daily_job_secret",
    ],
    [for k in ["aws_bearer_token_bedrock", "llm_gateway_api_key", "gcp_service_account_json"] : k if contains(local.secret_keys, k)]
  )

  mcp_secret_arns   = [for k in local.mcp_secret_keys : aws_secretsmanager_secret.this[k].arn]
  agent_secret_arns = [for k in local.agent_secret_keys : aws_secretsmanager_secret.this[k].arn]
}

############################################
# tableau-mcp roles
############################################

resource "aws_iam_role" "mcp_access" {
  name               = "${local.name}-mcp-access"
  assume_role_policy = data.aws_iam_policy_document.apprunner_build_trust.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "mcp_access_ecr" {
  role       = aws_iam_role.mcp_access.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

resource "aws_iam_role" "mcp_instance" {
  name               = "${local.name}-mcp-instance"
  assume_role_policy = data.aws_iam_policy_document.apprunner_tasks_trust.json
  tags               = local.tags
}

data "aws_iam_policy_document" "mcp_instance_secrets" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.mcp_secret_arns
  }

  # Reading a CMK-encrypted secret also requires kms:Decrypt on that key. Added
  # only when the CMK exists (var.create_secrets_kms_key); with the AWS-managed
  # key, Secrets Manager handles decryption implicitly and no grant is needed.
  dynamic "statement" {
    for_each = local.secrets_kms_key_arn == null ? [] : [local.secrets_kms_key_arn]
    content {
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "mcp_instance_secrets" {
  name   = "${local.name}-mcp-instance-secrets"
  role   = aws_iam_role.mcp_instance.id
  policy = data.aws_iam_policy_document.mcp_instance_secrets.json
}

############################################
# slack-agent roles
############################################

resource "aws_iam_role" "agent_access" {
  name               = "${local.name}-agent-access"
  assume_role_policy = data.aws_iam_policy_document.apprunner_build_trust.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "agent_access_ecr" {
  role       = aws_iam_role.agent_access.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

resource "aws_iam_role" "agent_instance" {
  name               = "${local.name}-agent-instance"
  assume_role_policy = data.aws_iam_policy_document.apprunner_tasks_trust.json
  tags               = local.tags
}

data "aws_iam_policy_document" "agent_instance_secrets" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.agent_secret_arns
  }

  # Bedrock: the agent authenticates to Bedrock via THIS role rather than a
  # static AWS_BEARER_TOKEN_BEDROCK secret whenever possible — the AWS SDK's
  # default credential provider chain picks up the App Runner instance role
  # automatically, so no credential material needs to be issued or rotated.
  # Scoped to "*" because Bedrock model invocation is not resource-scopable
  # to a single model ARN in a useful way (model ids vary by region/version).
  dynamic "statement" {
    for_each = var.ai_provider == "bedrock" ? [1] : []
    content {
      effect = "Allow"
      actions = [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
      ]
      resources = ["*"]
    }
  }

  # kms:Decrypt for the secrets CMK, mirroring mcp_instance_secrets above.
  # Only present when var.create_secrets_kms_key = true.
  dynamic "statement" {
    for_each = local.secrets_kms_key_arn == null ? [] : [local.secrets_kms_key_arn]
    content {
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "agent_instance_secrets" {
  name   = "${local.name}-agent-instance-secrets"
  role   = aws_iam_role.agent_instance.id
  policy = data.aws_iam_policy_document.agent_instance_secrets.json
}
