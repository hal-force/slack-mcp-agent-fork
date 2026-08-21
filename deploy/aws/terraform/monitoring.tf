############################################
# Observability: CloudWatch alarms + SNS (opt-in)
#
# All resources here are gated on var.create_alarms, so the demo default
# (false) creates nothing and a demo `plan` shows no change. When enabled we
# create an SNS topic (optionally email-subscribed) and a small set of alarms
# covering the two failure modes worth paging on: the agent throwing 5xx and
# the database saturating (CPU or connections).
############################################

resource "aws_sns_topic" "alarms" {
  count = var.create_alarms ? 1 : 0

  name = "${local.name}-alarms"
  tags = local.tags
}

resource "aws_sns_topic_subscription" "alarms_email" {
  count = var.create_alarms && var.alarm_email != "" ? 1 : 0

  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# ---- slack-agent 5xx responses -----------------------------------------
resource "aws_cloudwatch_metric_alarm" "agent_5xx" {
  count = var.create_alarms ? 1 : 0

  alarm_name          = "${local.name}-agent-5xx"
  alarm_description   = "slack-agent App Runner service returning 5xx responses."
  namespace           = "AWS/AppRunner"
  metric_name         = "5xxStatusResponses"
  dimensions          = { ServiceName = aws_apprunner_service.slack_agent.service_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms[0].arn]
  ok_actions          = [aws_sns_topic.alarms[0].arn]
  tags                = local.tags
}

# ---- Aurora CPU saturation ---------------------------------------------
resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  count = var.create_alarms ? 1 : 0

  alarm_name          = "${local.name}-db-cpu"
  alarm_description   = "Aurora cluster CPU utilization sustained high."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBClusterIdentifier = aws_rds_cluster.this.cluster_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms[0].arn]
  ok_actions          = [aws_sns_topic.alarms[0].arn]
  tags                = local.tags
}

# ---- Aurora connection saturation --------------------------------------
resource "aws_cloudwatch_metric_alarm" "db_connections" {
  count = var.create_alarms ? 1 : 0

  alarm_name          = "${local.name}-db-connections"
  alarm_description   = "Aurora cluster database connection count unusually high."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { DBClusterIdentifier = aws_rds_cluster.this.cluster_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms[0].arn]
  ok_actions          = [aws_sns_topic.alarms[0].arn]
  tags                = local.tags
}
