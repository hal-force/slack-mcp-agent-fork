############################################
# App Runner: tableau-mcp (private) + slack-agent (public)
#
# Networking recap (see also network.tf):
#   - tableau-mcp gets INBOUND privacy via an aws_apprunner_vpc_ingress_connection,
#     which itself is bound to a VPC interface endpoint
#     (com.amazonaws.<region>.apprunner.requests) sitting in the private
#     subnets. That gives the MCP service a private DNS name reachable only
#     from inside the VPC.
#   - slack-agent gets OUTBOUND access into that VPC via an
#     aws_apprunner_vpc_connector (egress_type = "VPC"), using the same
#     private subnets + the agent security group.
#   - Neither MCP nor the agent expose an HTTP /health route, so both health
#     checks are TCP (port-open) checks, not HTTP path checks.
############################################

# ---- VPC interface endpoint backing the MCP's VPC ingress connection ----

resource "aws_security_group" "apprunner_vpce" {
  name        = "${local.name}-apprunner-vpce"
  description = "SG for the App Runner (apprunner.requests) VPC interface endpoint"
  vpc_id      = local.vpc_id

  ingress {
    description     = "Agent -> App Runner PrivateLink endpoint"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.agent_egress.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${local.name}-apprunner-vpce" })
}

resource "aws_vpc_endpoint" "apprunner" {
  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.apprunner.requests"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.private_subnet_ids
  security_group_ids  = [aws_security_group.apprunner_vpce.id]
  private_dns_enabled = true

  tags = merge(local.tags, { Name = "${local.name}-apprunner-vpce" })
}

# ---- Egress VPC connector, used by the slack-agent service --------------

resource "aws_apprunner_vpc_connector" "agent_egress" {
  vpc_connector_name = "${local.name}-agent-egress"
  subnets            = local.private_subnet_ids
  security_groups    = [aws_security_group.agent_egress.id]

  tags = local.tags
}

############################################
# tableau-mcp service (private)
############################################

resource "aws_apprunner_service" "tableau_mcp" {
  service_name = "${local.name}-tableau-mcp"

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.mcp_access.arn
    }

    image_repository {
      image_identifier      = "${aws_ecr_repository.tableau_mcp.repository_url}:${var.mcp_image_tag}"
      image_repository_type = "ECR"

      image_configuration {
        port = "3927"

        runtime_environment_variables = {
          TRANSPORT = "http"
          PORT      = "3927"
          AUTH      = "pat"
          SERVER    = var.tableau_server_url
          SITE_NAME = var.tableau_site_name
          PAT_NAME  = var.tableau_pat_name
          # Safe ONLY because this service is private/VPC-only (see
          # network_configuration.ingress_configuration below) — OAuth is
          # disabled because nothing outside the VPC can ever reach it.
          DANGEROUSLY_DISABLE_OAUTH = "true"
        }

        runtime_environment_secrets = {
          PAT_VALUE = aws_secretsmanager_secret.this["tableau_pat_value"].arn
        }
      }
    }
  }

  instance_configuration {
    cpu               = "1024"
    memory            = "2048"
    instance_role_arn = aws_iam_role.mcp_instance.arn
  }

  # No HTTP /health route exists on this server (only POST/GET/DELETE
  # /tableau-mcp), so the health check must be a plain TCP (port-open) probe.
  health_check_configuration {
    protocol = "TCP"
  }

  network_configuration {
    ingress_configuration {
      is_publicly_accessible = false
    }
    egress_configuration {
      egress_type = "DEFAULT"
    }
  }

  tags = local.tags
}

# Binds the private MCP service to the VPC interface endpoint, giving it a
# private DNS name that only resolves/works from inside the VPC.
resource "aws_apprunner_vpc_ingress_connection" "mcp" {
  name        = "${local.name}-mcp-ingress"
  service_arn = aws_apprunner_service.tableau_mcp.arn

  ingress_vpc_configuration {
    vpc_id          = local.vpc_id
    vpc_endpoint_id = aws_vpc_endpoint.apprunner.id
  }

  tags = local.tags
}

############################################
# slack-agent service (public)
############################################

locals {
  tableau_mcp_server_url = "https://${aws_apprunner_vpc_ingress_connection.mcp.domain_name}/tableau-mcp"

  agent_plain_env = merge(
    {
      AI_PROVIDER        = var.ai_provider
      BEDROCK_MODEL_ID   = var.bedrock_model_id
      AWS_REGION         = var.aws_region
      TABLEAU_MCP_SERVER = local.tableau_mcp_server_url
      # The MCP's VPC-ingress domain is a private hostname by design; this
      # flag opts the agent's outbound SSRF guard (src/assistant/urlSafety.js)
      # back in for that one destination.
      TABLEAU_MCP_ALLOW_PRIVATE = "1"
      PUBLIC_BASE_URL           = var.public_base_url
      SLACK_BOT_SCOPES          = var.slack_bot_scopes
      SLACK_TEAM_ID             = var.slack_team_id
      PGSSLROOTCERT             = "certs/rds-global-bundle.pem"
      BRIEF_HOUR_LOCAL          = var.brief_hour_local
      LLM_GATEWAY_URL           = var.llm_gateway_url
      LLM_GATEWAY_MODEL         = var.llm_gateway_model
    },
    var.extra_env,
  )

  agent_secret_env = merge(
    {
      SLACK_SIGNING_SECRET   = aws_secretsmanager_secret.this["slack_signing_secret"].arn
      SLACK_CLIENT_ID        = aws_secretsmanager_secret.this["slack_client_id"].arn
      SLACK_CLIENT_SECRET    = aws_secretsmanager_secret.this["slack_client_secret"].arn
      SLACK_STATE_SECRET     = aws_secretsmanager_secret.this["slack_state_secret"].arn
      TOKEN_ENC_KEY          = aws_secretsmanager_secret.this["token_enc_key"].arn
      DATABASE_URL           = aws_secretsmanager_secret.this["database_url"].arn
      TABLEAU_WEBHOOK_SECRET = aws_secretsmanager_secret.this["tableau_webhook_secret"].arn
      VHA_DAILY_JOB_SECRET   = aws_secretsmanager_secret.this["vha_daily_job_secret"].arn
    },
    contains(local.secret_keys, "aws_bearer_token_bedrock") ? { AWS_BEARER_TOKEN_BEDROCK = aws_secretsmanager_secret.this["aws_bearer_token_bedrock"].arn } : {},
    contains(local.secret_keys, "llm_gateway_api_key") ? { LLM_GATEWAY_API_KEY = aws_secretsmanager_secret.this["llm_gateway_api_key"].arn } : {},
    contains(local.secret_keys, "gcp_service_account_json") ? { GCP_SERVICE_ACCOUNT_JSON = aws_secretsmanager_secret.this["gcp_service_account_json"].arn } : {},
  )
}

resource "aws_apprunner_service" "slack_agent" {
  service_name = "${local.name}-slack-agent"

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.agent_access.arn
    }

    image_repository {
      image_identifier      = "${aws_ecr_repository.slack_agent.repository_url}:${var.agent_image_tag}"
      image_repository_type = "ECR"

      image_configuration {
        port = "3000"

        runtime_environment_variables = local.agent_plain_env
        runtime_environment_secrets   = local.agent_secret_env
      }
    }
  }

  instance_configuration {
    cpu               = "1024"
    memory            = "2048"
    instance_role_arn = aws_iam_role.agent_instance.arn
  }

  # No HTTP /health route exists (see docker-entrypoint.sh / src/index.js),
  # so the health check must be a plain TCP (port-open) probe.
  health_check_configuration {
    protocol = "TCP"
  }

  network_configuration {
    ingress_configuration {
      is_publicly_accessible = true
    }
    egress_configuration {
      egress_type       = "VPC"
      vpc_connector_arn = aws_apprunner_vpc_connector.agent_egress.arn
    }
  }

  tags = local.tags

  depends_on = [aws_apprunner_vpc_ingress_connection.mcp]
}
