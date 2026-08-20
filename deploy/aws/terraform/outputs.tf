output "agent_service_url" {
  description = "Public HTTPS domain App Runner assigned to the slack-agent service."
  value       = "https://${aws_apprunner_service.slack_agent.service_url}"
}

output "mcp_ingress_domain" {
  description = "Private domain (VPC-only) for the tableau-mcp service, reachable only from inside the VPC via the VPC Ingress Connection."
  value       = aws_apprunner_vpc_ingress_connection.mcp.domain_name
}

output "tableau_mcp_server_url" {
  description = "Full private URL the agent uses for TABLEAU_MCP_SERVER."
  value       = local.tableau_mcp_server_url
}

output "ecr_tableau_mcp_repository_url" {
  description = "ECR repository URL to push the tableau-mcp image to."
  value       = aws_ecr_repository.tableau_mcp.repository_url
}

output "ecr_slack_agent_repository_url" {
  description = "ECR repository URL to push the slack-agent image to."
  value       = aws_ecr_repository.slack_agent.repository_url
}

output "rds_cluster_endpoint" {
  description = "Aurora cluster writer endpoint (host only, no port/scheme)."
  value       = aws_rds_cluster.this.endpoint
}

output "next_steps" {
  description = "Reminder of the manual steps required after apply."
  value       = <<-EOT
    1. If public_base_url was empty on this apply, copy agent_service_url above
       into terraform.tfvars as public_base_url and run `terraform apply` again
       (this fixes PUBLIC_BASE_URL on the agent and the VHA daily webhook URL).
    2. In the Slack app config, set:
         - Redirect URL:  https://${aws_apprunner_service.slack_agent.service_url}/slack/oauthcallback
         - Install URL:   https://${aws_apprunner_service.slack_agent.service_url}/slack/install
    3. Tableau webhook URL pattern (register in Tableau, using the
       tableau_webhook_secret value from Secrets Manager):
         https://${aws_apprunner_service.slack_agent.service_url}/webhooks/tableau/refresh/<tableau_webhook_secret>
  EOT
}
