# A Cloud Run v2 service. Used twice: the API and the push relay.
#
# `cpu_idle = false` (CPU always allocated) is not a performance knob here, it
# is a correctness one for the API. The API holds a persistent Postgres LISTEN
# client and runs periodic maintenance sweeps; on a throttled idle instance the
# listener stops draining and realtime delivery stalls until the next request
# happens to wake it. That is audit finding 7.1, and it is why min_instances is
# 1 for the API rather than 0.
#
# The image and the traffic split are both ignored after create. The deploy
# workflow rolls revisions with no traffic, gates on the public endpoints and
# then shifts; a later `terraform apply` must not quietly roll that back to
# whatever tag was in the tfvars.

resource "google_cloud_run_v2_service" "this" {
  name                = var.name
  project             = var.project_id
  location            = var.region
  ingress             = var.ingress
  labels              = var.labels
  deletion_protection = false

  template {
    service_account                  = var.service_account_email
    timeout                          = "${var.request_timeout_seconds}s"
    max_instance_request_concurrency = var.concurrency
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    dynamic "vpc_access" {
      for_each = var.subnet_id == "" ? [] : [1]

      content {
        egress = "PRIVATE_RANGES_ONLY"

        network_interfaces {
          network    = var.network_id
          subnetwork = var.subnet_id
        }
      }
    }

    containers {
      image = var.image

      ports {
        container_port = var.container_port
      }

      resources {
        cpu_idle          = false
        startup_cpu_boost = true

        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      dynamic "env" {
        for_each = var.plain_env

        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env

        content {
          name = env.key

          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      # Readiness is a bare SELECT 1, deliberately: a replica that cannot reach
      # Postgres must not take traffic, and anything heavier turns a slow
      # dependency into a failed rollout.
      dynamic "startup_probe" {
        for_each = var.startup_probe_path == "" ? [] : [1]

        content {
          initial_delay_seconds = 10
          period_seconds        = 5
          timeout_seconds       = 5
          failure_threshold     = 30

          http_get {
            path = var.startup_probe_path
          }
        }
      }

      dynamic "liveness_probe" {
        for_each = var.liveness_probe_path == "" ? [] : [1]

        content {
          period_seconds    = 30
          timeout_seconds   = 5
          failure_threshold = 3

          http_get {
            path = var.liveness_probe_path
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      traffic,
      client,
      client_version,
    ]
  }
}

# Ingress is already restricted to the load balancer for the API, but the
# invoker binding is the second half: without it a Cloud Run service is private
# and the load balancer's backend answers 403.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  count = var.public_invoker ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.this.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
