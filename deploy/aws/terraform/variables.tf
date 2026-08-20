############################################
# Global / naming
############################################

variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Short prefix applied to every resource name (e.g. \"tableau-slack\")."
  type        = string
  default     = "tableau-slack"
}

############################################
# Networking
############################################

variable "create_vpc" {
  description = "If true, create a new VPC (2 public + 2 private subnets, IGW, single NAT gateway). If false, supply vpc_id/private_subnet_ids/public_subnet_ids for an existing VPC."
  type        = bool
  default     = true
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC created when create_vpc = true."
  type        = string
  default     = "10.20.0.0/16"
}

variable "vpc_id" {
  description = "Existing VPC id to use when create_vpc = false. Ignored when create_vpc = true."
  type        = string
  default     = ""
}

variable "private_subnet_ids" {
  description = "Existing private subnet ids to use when create_vpc = false (used for RDS, the App Runner VPC connector, and the VPC interface endpoint). Ignored when create_vpc = true."
  type        = list(string)
  default     = []
}

variable "public_subnet_ids" {
  description = "Existing public subnet ids to use when create_vpc = false (used for the NAT gateway / general egress path, if any). Ignored when create_vpc = true."
  type        = list(string)
  default     = []
}

############################################
# Tableau
############################################

variable "tableau_server_url" {
  description = "Tableau Server/Cloud base URL, e.g. https://prod-useast-a.online.tableau.com"
  type        = string
}

variable "tableau_site_name" {
  description = "Tableau site content-url (site name)."
  type        = string
}

variable "tableau_pat_name" {
  description = "Name of the Tableau Personal Access Token (PAT). Not sensitive on its own."
  type        = string
}

variable "tableau_pat_value" {
  description = "Tableau PAT secret value. Stored in Secrets Manager; never has a default."
  type        = string
  sensitive   = true
}

############################################
# Slack
############################################

variable "slack_signing_secret" {
  description = "Slack app signing secret."
  type        = string
  sensitive   = true
}

variable "slack_client_id" {
  description = "Slack app client id (OAuth). Not secret by nature, but handled as one for consistency."
  type        = string
  sensitive   = true
}

variable "slack_client_secret" {
  description = "Slack app client secret (OAuth)."
  type        = string
  sensitive   = true
}

variable "slack_state_secret" {
  description = "Secret used to sign/verify Slack OAuth state parameters."
  type        = string
  sensitive   = true
}

variable "slack_bot_scopes" {
  description = "Comma-separated list of Slack bot OAuth scopes requested at install time."
  type        = string
  default     = "im:write,chat:write,app_mentions:read,channels:history,groups:history,mpim:write,commands,canvases:write,files:write,users:read"
}

variable "slack_team_id" {
  description = "Optional Slack team (workspace) id, used by scheduled/broadcast jobs that need a default team context."
  type        = string
  default     = ""
}

############################################
# App secrets (non-Slack, non-Tableau)
############################################

variable "token_enc_key" {
  description = "Symmetric key used to encrypt stored Slack installation tokens at rest."
  type        = string
  sensitive   = true
}

variable "tableau_webhook_secret" {
  description = "Path secret for the Tableau webhook receiver: POST /webhooks/tableau/refresh/<secret>."
  type        = string
  sensitive   = true
}

variable "vha_daily_job_secret" {
  description = "Path secret for the scheduled daily-brief trigger: POST /jobs/vha-daily/<secret>."
  type        = string
  sensitive   = true
}

############################################
# LLM provider
############################################

variable "ai_provider" {
  description = "Which LLM backend the agent uses: \"bedrock\", \"gateway\", or \"vertex\"."
  type        = string
  default     = "bedrock"
}

variable "bedrock_model_id" {
  description = "Bedrock model id used when ai_provider = \"bedrock\"."
  type        = string
  default     = "us.anthropic.claude-sonnet-4-6"
}

variable "aws_bearer_token_bedrock" {
  description = "Optional long-term Bedrock API key. Leave empty to authenticate via the App Runner instance role instead (recommended; see iam.tf)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "llm_gateway_url" {
  description = "Optional OpenAI-compatible LLM gateway base URL, used when ai_provider = \"gateway\"."
  type        = string
  default     = ""
}

variable "llm_gateway_model" {
  description = "Model name to request from the LLM gateway, used when ai_provider = \"gateway\"."
  type        = string
  default     = ""
}

variable "llm_gateway_api_key" {
  description = "Optional LLM gateway API key, used when ai_provider = \"gateway\"."
  type        = string
  sensitive   = true
  default     = ""
}

variable "gcp_service_account_json" {
  description = "Optional GCP service account JSON (Vertex/Gemini), used when ai_provider = \"vertex\"."
  type        = string
  sensitive   = true
  default     = ""
}

############################################
# Database
############################################

variable "db_name" {
  description = "Initial database name created on the Aurora cluster."
  type        = string
  default     = "slackagent"
}

variable "db_username" {
  description = "Master username for the Aurora cluster."
  type        = string
  default     = "slackagent"
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL engine version. AWS retires specific point releases for NEW-cluster creation over time; if apply reports an invalid engine version, pick one currently offered in your region via: aws rds describe-db-engine-versions --engine aurora-postgresql --query 'DBEngineVersions[].EngineVersion' --output text"
  type        = string
  default     = "16.6"
}

############################################
# Agent runtime
############################################

variable "public_base_url" {
  description = "The agent's own public HTTPS base URL (no trailing slash), e.g. https://xxxx.us-east-1.awsapprunner.com. Unknown on the very first apply — App Runner assigns this domain. Leave \"\" for the first apply, then set it to the agent_service_url output and re-apply."
  type        = string
  default     = ""
}

variable "brief_hour_local" {
  description = "Local hour (0-23) at which the daily brief job considers itself \"due\" for a given user's timezone."
  type        = string
  default     = "7"
}

variable "extra_env" {
  description = "Arbitrary additional PLAIN (non-secret) environment variables merged into the slack-agent service, e.g. VHA_BRIEF_BINDINGS."
  type        = map(string)
  default     = {}
}

############################################
# Scheduler (daily VHA brief trigger)
############################################

variable "enable_daily_schedule" {
  description = "Whether to create the EventBridge rule that triggers the daily VHA brief job. Note: the rule/API-destination resources are only actually created once public_base_url is also non-empty (see scheduler.tf); setting this true alone is not enough on the very first apply."
  type        = bool
  default     = true
}

variable "daily_schedule_cron" {
  description = "EventBridge cron expression for the daily brief trigger (UTC), set directly on the aws_cloudwatch_event_rule's schedule_expression."
  type        = string
  default     = "cron(0 14 * * ? *)"
}

############################################
# Images
############################################

variable "agent_image_tag" {
  description = "Image tag to deploy for the slack-agent ECR repository."
  type        = string
  default     = "latest"
}

variable "mcp_image_tag" {
  description = "Image tag to deploy for the tableau-mcp ECR repository."
  type        = string
  default     = "latest"
}
