variable "project_id" {
  type = string
}

variable "environment" {
  type = string
}

variable "labels" {
  type = map(string)
}

variable "worker_service_url" {
  description = "Cloud Run worker service URL for push subscriptions"
  type        = string
}

locals {
  topics = {
    "nessie-run-requested" = {
      ordering_key = "threadId"
    }
    "nessie-step-requested" = {
      ordering_key = "runId"
    }
    "nessie-tool-call-requested" = {
      ordering_key = null
    }
    "nessie-approval-requested" = {
      ordering_key = null
    }
    "nessie-approval-sweep" = {
      ordering_key = null
    }
    "nessie-audit-emit" = {
      ordering_key = null
    }
    "nessie-token-ledger-emit" = {
      ordering_key = null
    }
  }
}

# Dead-letter topics
resource "google_pubsub_topic" "dead_letter" {
  for_each = local.topics

  name    = "${each.key}-dlq-${var.environment}"
  project = var.project_id
  labels  = var.labels
}

# Primary topics
resource "google_pubsub_topic" "main" {
  for_each = local.topics

  name    = "${each.key}-${var.environment}"
  project = var.project_id
  labels  = var.labels

  # Enable message ordering when the topic has an ordering key
  dynamic "message_storage_policy" {
    for_each = each.value.ordering_key != null ? [1] : []
    content {
      allowed_persistence_regions = ["us-central1"]
    }
  }
}

# Push subscriptions to Cloud Run worker
resource "google_pubsub_subscription" "worker" {
  for_each = local.topics

  name    = "${each.key}-worker-${var.environment}"
  project = var.project_id
  topic   = google_pubsub_topic.main[each.key].id
  labels  = var.labels

  ack_deadline_seconds       = 600
  message_retention_duration = "604800s"
  enable_message_ordering    = each.value.ordering_key != null

  push_config {
    push_endpoint = "${var.worker_service_url}/queue/${each.key}"

    oidc_token {
      service_account_email = "nessie-worker@${var.project_id}.iam.gserviceaccount.com"
    }

    attributes = {
      x-goog-version = "v1"
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter[each.key].id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  expiration_policy {
    ttl = ""
  }
}

# Dead-letter subscriptions (for monitoring/reprocessing)
resource "google_pubsub_subscription" "dead_letter" {
  for_each = local.topics

  name    = "${each.key}-dlq-monitor-${var.environment}"
  project = var.project_id
  topic   = google_pubsub_topic.dead_letter[each.key].id
  labels  = var.labels

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }
}

output "topic_ids" {
  value = { for k, v in google_pubsub_topic.main : k => v.id }
}

output "subscription_ids" {
  value = { for k, v in google_pubsub_subscription.worker : k => v.id }
}

output "dead_letter_topic_ids" {
  value = { for k, v in google_pubsub_topic.dead_letter : k => v.id }
}
