variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "environment" {
  type    = string
  default = "staging"
}

variable "lambda_zip" {
  description = "Bundled handlers (src/lambda/handlers.ts built to handlers.js)"
  type        = string
}

variable "mongo_url_parameter" {
  description = "SSM SecureString parameter holding the MongoDB connection string"
  type        = string
  default     = "/usage-billing/mongo-url"
}

variable "ingest_timeout_seconds" {
  type    = number
  default = 30
}

variable "ingest_concurrency" {
  description = "Caps parallel ingestion so MongoDB is not overrun during a backlog"
  type        = number
  default     = 10
}

variable "alarm_topic_arn" {
  type    = string
  default = null
}
