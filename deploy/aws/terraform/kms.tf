############################################
# Customer-managed KMS key for Secrets Manager (opt-in)
#
# When var.create_secrets_kms_key = true we create a CMK with automatic annual
# rotation and encrypt every Secrets Manager secret with it (see secrets.tf),
# and grant each App Runner instance role kms:Decrypt on it (see iam.tf). This
# gives production control over the key policy, rotation, and per-principal
# kms:Decrypt auditing in CloudTrail.
#
# When false (the demo default) NOTHING here is created and secrets fall back
# to the AWS-managed aws/secretsmanager key — so a demo `plan` shows no change.
############################################

resource "aws_kms_key" "secrets" {
  count = var.create_secrets_kms_key ? 1 : 0

  description             = "${local.name} Secrets Manager CMK"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = local.tags
}

resource "aws_kms_alias" "secrets" {
  count = var.create_secrets_kms_key ? 1 : 0

  name          = "alias/${local.name}-secrets"
  target_key_id = aws_kms_key.secrets[0].key_id
}

locals {
  # ARN to stamp onto each secret's kms_key_id, or null to use the AWS-managed
  # key. Also consumed by iam.tf to decide whether a kms:Decrypt grant is added.
  secrets_kms_key_arn = var.create_secrets_kms_key ? aws_kms_key.secrets[0].arn : null
}
