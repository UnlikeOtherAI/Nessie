variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "environment" {
  type = string
}

variable "labels" {
  type = map(string)
}

variable "vpc_connector_id" {
  type = string
}

variable "api_service_account_email" {
  type = string
}

variable "worker_service_account_email" {
  type = string
}

variable "database_connection_name" {
  type = string
}

variable "redis_host" {
  type = string
}

variable "api_image" {
  description = "Container image for the API service"
  type        = string
  default     = "us-central1-docker.pkg.dev/PROJECT/nessie/api:latest"
}

variable "worker_image" {
  description = "Container image for the worker service"
  type        = string
  default     = "us-central1-docker.pkg.dev/PROJECT/nessie/worker:latest"
}

resource "google_secret_manager_secret" "auth_secret" {
  project   = var.project_id
  secret_id = "nessie-auth-secret"

  labels = var.labels

  replication {
    auto {}
  }
}

locals {
  common_env = [
    {
      name  = "NESSIE_MODE"
      value = "hosted"
    },
    {
      name  = "NODE_ENV"
      value = "production"
    },
  ]

  common_secret_env = [
    {
      name       = "NESSIE_AUTH_SECRET"
      secret_key = google_secret_manager_secret.auth_secret.secret_id
      version    = "latest"
    },
    {
      name       = "NESSIE_DB_URL"
      secret_key = "nessie-database-url"
      version    = "latest"
    },
    {
      name       = "NESSIE_MODEL_API_KEY"
      secret_key = "nessie-openai-api-key"
      version    = "latest"
    },
  ]
}

resource "google_cloud_run_v2_service" "api" {
  name     = "nessie-api-${var.environment}"
  location = var.region
  project  = var.project_id

  labels = var.labels

  template {
    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }

    vpc_access {
      connector = var.vpc_connector_id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    timeout = "300s"

    service_account = var.api_service_account_email

    containers {
      image = var.api_image

      ports {
        container_port = 5554
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "1Gi"
        }
      }

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.value.name
          value = env.value.value
        }
      }

      env {
        name  = "NESSIE_API_PORT"
        value = "5554"
      }

      env {
        name  = "NESSIE_QUEUE_PROVIDER"
        value = "pubsub"
      }

      env {
        name  = "NESSIE_QUEUE_PROJECT_ID"
        value = var.project_id
      }

      env {
        name  = "NESSIE_STORAGE_PROVIDER"
        value = "gcs"
      }

      env {
        name  = "NESSIE_REDIS_URL"
        value = "redis://${var.redis_host}:6379"
      }

      dynamic "env" {
        for_each = local.common_secret_env
        content {
          name = env.value.name
          value_source {
            secret_key_ref {
              secret  = env.value.secret_key
              version = env.value.version
            }
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [var.database_connection_name]
      }
    }
  }
}

resource "google_cloud_run_v2_service" "worker" {
  name     = "nessie-worker-${var.environment}"
  location = var.region
  project  = var.project_id

  labels = var.labels

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    vpc_access {
      connector = var.vpc_connector_id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    timeout = "900s"

    service_account = var.worker_service_account_email

    containers {
      image = var.worker_image

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
      }

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.value.name
          value = env.value.value
        }
      }

      env {
        name  = "NESSIE_QUEUE_PROVIDER"
        value = "pubsub"
      }

      env {
        name  = "NESSIE_QUEUE_PROJECT_ID"
        value = var.project_id
      }

      env {
        name  = "NESSIE_STORAGE_PROVIDER"
        value = "gcs"
      }

      env {
        name  = "NESSIE_REDIS_URL"
        value = "redis://${var.redis_host}:6379"
      }

      dynamic "env" {
        for_each = local.common_secret_env
        content {
          name = env.value.name
          value_source {
            secret_key_ref {
              secret  = env.value.secret_key
              version = env.value.version
            }
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [var.database_connection_name]
      }
    }
  }
}

# Allow unauthenticated access to the API (behind load balancer auth)
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Worker is internal only -- invoked by Pub/Sub push subscriptions
resource "google_cloud_run_v2_service_iam_member" "worker_pubsub" {
  name     = google_cloud_run_v2_service.worker.name
  location = var.region
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.worker_service_account_email}"
}

output "api_service_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "worker_service_url" {
  value = google_cloud_run_v2_service.worker.uri
}

output "api_service_name" {
  value = google_cloud_run_v2_service.api.name
}

output "worker_service_name" {
  value = google_cloud_run_v2_service.worker.name
}
