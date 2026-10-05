# Skeleton for running the platform on AWS: the ingestion Lambda behind SQS with
# a dead-letter queue, and scheduled Lambdas for rollups, marketplace reporting
# and the monthly invoice run. MongoDB (Atlas or self-managed) is outside this
# module; its connection string comes from SSM Parameter Store.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}

provider "aws" {
  region = var.region
}

locals {
  name = "usage-billing-${var.environment}"
  env = {
    MONGO_URL = data.aws_ssm_parameter.mongo_url.value
    MONGO_DB  = "billing"
  }
}

data "aws_ssm_parameter" "mongo_url" {
  name = var.mongo_url_parameter
}

# --- Queues ---------------------------------------------------------------

resource "aws_sqs_queue" "usage_dlq" {
  name                      = "${local.name}-usage-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "usage" {
  name                       = "${local.name}-usage"
  visibility_timeout_seconds = 6 * var.ingest_timeout_seconds
  message_retention_seconds  = 345600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.usage_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${local.name}-usage-dlq-not-empty"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.usage_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
}

# --- IAM ------------------------------------------------------------------

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name}-lambda"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "lambda" {
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.usage.arn]
  }
  statement {
    actions   = ["aws-marketplace:BatchMeterUsage"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lambda" {
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

# --- Functions ------------------------------------------------------------

resource "aws_lambda_function" "ingest" {
  function_name                  = "${local.name}-ingest"
  role                           = aws_iam_role.lambda.arn
  runtime                        = "nodejs22.x"
  handler                        = "handlers.ingestUsage"
  filename                       = var.lambda_zip
  source_code_hash               = filebase64sha256(var.lambda_zip)
  timeout                        = var.ingest_timeout_seconds
  memory_size                    = 1024
  reserved_concurrent_executions = var.ingest_concurrency
  environment { variables = local.env }
}

resource "aws_lambda_event_source_mapping" "ingest" {
  event_source_arn                   = aws_sqs_queue.usage.arn
  function_name                      = aws_lambda_function.ingest.arn
  batch_size                         = 100
  maximum_batching_window_in_seconds = 5
  function_response_types            = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = var.ingest_concurrency
  }
}

locals {
  scheduled = {
    aggregate   = { handler = "handlers.aggregateRollups", schedule = "rate(1 minute)", timeout = 60, concurrency = 1 }
    marketplace = { handler = "handlers.reportMarketplaceUsage", schedule = "cron(5 * * * ? *)", timeout = 300, concurrency = 1 }
    invoices    = { handler = "handlers.monthlyInvoiceRun", schedule = "cron(0 4 1 * ? *)", timeout = 900, concurrency = 1 }
  }
}

# Each scheduled job runs one at a time (reserved concurrency 1); all of them are safe to re-run.
resource "aws_lambda_function" "scheduled" {
  for_each                       = local.scheduled
  function_name                  = "${local.name}-${each.key}"
  role                           = aws_iam_role.lambda.arn
  runtime                        = "nodejs22.x"
  handler                        = each.value.handler
  filename                       = var.lambda_zip
  source_code_hash               = filebase64sha256(var.lambda_zip)
  timeout                        = each.value.timeout
  memory_size                    = 1024
  reserved_concurrent_executions = each.value.concurrency
  environment { variables = local.env }
}

resource "aws_cloudwatch_event_rule" "scheduled" {
  for_each            = local.scheduled
  name                = "${local.name}-${each.key}"
  schedule_expression = each.value.schedule
}

resource "aws_cloudwatch_event_target" "scheduled" {
  for_each = local.scheduled
  rule     = aws_cloudwatch_event_rule.scheduled[each.key].name
  arn      = aws_lambda_function.scheduled[each.key].arn
}

resource "aws_lambda_permission" "scheduled" {
  for_each      = local.scheduled
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scheduled[each.key].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scheduled[each.key].arn
}
