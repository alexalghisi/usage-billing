output "usage_queue_url" {
  value = aws_sqs_queue.usage.url
}

output "usage_dlq_url" {
  value = aws_sqs_queue.usage_dlq.url
}
