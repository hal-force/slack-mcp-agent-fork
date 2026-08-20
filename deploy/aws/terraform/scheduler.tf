############################################
# Daily VHA brief trigger
#
# Goal: an EventBridge-managed daily cron that does an HTTPS POST to
# https://<agent-domain>/jobs/vha-daily/<vha_daily_job_secret> (the route is
# path-secret-authenticated — see src/jobs/dailyBriefTrigger.js — so no bearer
# token or signature is checked by the app itself).
#
# IMPORTANT DEVIATION FROM A COMMON ASSUMPTION: this does NOT use
# `aws_scheduler_schedule` (the standalone "EventBridge Scheduler" service).
# Scheduler's Target type only supports a fixed list of templated targets
# (SQS, SNS, Lambda, Step Functions, ECS, Kinesis, Firehose, CodeBuild,
# CodePipeline, Inspector, SageMaker) plus "universal" aws-sdk targets
# (arn:aws:scheduler:::aws-sdk:{service}:{action}) — confirmed against the
# AWS Scheduler API reference and User Guide. There is no API-destination
# target type on Scheduler, so `target { arn = <api_destination_arn> }` on an
# aws_scheduler_schedule would pass `terraform validate` (arn is just a
# string) but fail at apply/runtime with a ValidationException.
#
# What DOES support calling an arbitrary HTTPS endpoint on a cron is a plain
# EventBridge RULE: aws_cloudwatch_event_rule supports `schedule_expression`
# directly (no separate Scheduler resource needed), and
# aws_cloudwatch_event_target supports an API destination as its target via
# `arn = aws_cloudwatch_event_api_destination.*.arn` + `http_target` +
# `role_arn`. That's what's built below.
#
# Path-secret auth note: the connection's `auth_parameters.api_key` block is
# REQUIRED by the resource schema for API_KEY connections, but our actual
# auth is the secret embedded in the URL path, which the target ignores as
# far as headers go. The header below is a required-but-functionally-unused
# placeholder — the app never inspects it.
#
# Apply-order note: aws_cloudwatch_event_api_destination.invocation_endpoint
# is a Required string and AWS rejects it at apply time unless it's a valid
# absolute https:// URL. var.public_base_url is "" on the documented first
# full apply (see README's chicken-and-egg step), so every resource in this
# file is additionally gated on public_base_url being non-empty via
# local.create_schedule below — NOT on var.enable_daily_schedule alone.
# Otherwise phase 2's first apply would fail trying to create an API
# destination pointed at "/jobs/vha-daily/<secret>" (no scheme/host).
############################################

locals {
  create_schedule = var.enable_daily_schedule && trimspace(var.public_base_url) != ""
}

resource "aws_cloudwatch_event_connection" "vha_daily" {
  count = local.create_schedule ? 1 : 0

  name               = "${local.name}-vha-daily"
  description        = "Placeholder connection for the VHA daily brief API destination (real auth is the path secret, not this header)"
  authorization_type = "API_KEY"

  auth_parameters {
    api_key {
      # Required by the API_KEY connection schema; the app does not check
      # this header. Real auth is the secret in the URL path below.
      key   = "X-Ignored-Placeholder-Auth"
      value = "unused"
    }
  }
}

resource "aws_cloudwatch_event_api_destination" "vha_daily" {
  count = local.create_schedule ? 1 : 0

  name                = "${local.name}-vha-daily"
  description         = "Daily VHA brief trigger on the slack-agent service"
  invocation_endpoint = "${var.public_base_url}/jobs/vha-daily/${var.vha_daily_job_secret}"
  http_method         = "POST"
  connection_arn      = aws_cloudwatch_event_connection.vha_daily[0].arn

  # Safe to interpolate var.public_base_url directly here: local.create_schedule
  # (above) already guarantees this resource only gets created once
  # public_base_url is non-empty, i.e. after the agent's first apply and the
  # public_base_url re-apply step described in README.md.
}

# Execution role EventBridge assumes to invoke the API destination target.
data "aws_iam_policy_document" "events_trust" {
  count = local.create_schedule ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "vha_daily_events" {
  count = local.create_schedule ? 1 : 0

  name               = "${local.name}-vha-daily-events"
  assume_role_policy = data.aws_iam_policy_document.events_trust[0].json
  tags               = local.tags
}

data "aws_iam_policy_document" "vha_daily_invoke" {
  count = local.create_schedule ? 1 : 0

  statement {
    effect    = "Allow"
    actions   = ["events:InvokeApiDestination"]
    resources = [aws_cloudwatch_event_api_destination.vha_daily[0].arn]
  }
}

resource "aws_iam_role_policy" "vha_daily_invoke" {
  count = local.create_schedule ? 1 : 0

  name   = "${local.name}-vha-daily-invoke"
  role   = aws_iam_role.vha_daily_events[0].id
  policy = data.aws_iam_policy_document.vha_daily_invoke[0].json
}

resource "aws_cloudwatch_event_rule" "vha_daily" {
  count = local.create_schedule ? 1 : 0

  name                = "${local.name}-vha-daily"
  description         = "Daily trigger for the VHA localized brief job"
  schedule_expression = var.daily_schedule_cron
  state               = "ENABLED"

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "vha_daily" {
  count = local.create_schedule ? 1 : 0

  rule     = aws_cloudwatch_event_rule.vha_daily[0].name
  arn      = aws_cloudwatch_event_api_destination.vha_daily[0].arn
  role_arn = aws_iam_role.vha_daily_events[0].arn

  http_target {
    header_parameters = {}
  }
}
