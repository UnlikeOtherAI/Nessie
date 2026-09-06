# The worker.
#
# A Cloud Run **worker pool**, not a Service. This is the one design decision
# in the tree that is worth the paragraph.
#
# The worker binds no port. It polls `queue_jobs` in Postgres and takes no
# ingress at all. A Cloud Run Service requires its container to answer on
# $PORT before the revision is considered ready, so the retired tree's HTTP
# worker Service could never have become ready — audit finding 7.2, and the
# reason "just make it a Service with internal ingress" is not the smaller
# change it looks like. A worker pool has no ingress, no port and no request
# lifecycle; CPU is always allocated, which the polling loop needs.
#
# It also has a drain the worker can actually use. Cloud Run *services* send
# SIGTERM and SIGKILL ten seconds later, and that grace is not configurable —
# too short for the worker's sixty-second checkpoint budget
# (docs/standards/horizontal-scaling.md invariant 6). Worker pools do not
# impose the ten-second ceiling.
#
# UNVALIDATED: `google_cloud_run_v2_worker_pool` has not been planned against a
# real project from this tree — terraform is not installed on the machine this
# was written on. Run `terraform plan` before the first apply, and if worker
# pools are unavailable in the chosen region, the documented fallback is a GKE
# Autopilot Deployment (docs/deployment/gcloud.md), NOT a Cloud Run Service.

resource "google_cloud_run_v2_worker_pool" "this" {
  provider = google-beta

  name                = var.name
  project             = var.project_id
  location            = var.region
  labels              = var.labels
  launch_stage        = "BETA"
  deletion_protection = false

  template {
    service_account = var.service_account_email

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = var.network_id
        subnetwork = var.subnet_id
      }
    }

    containers {
      image = var.image

      # One image, selected by command. `nessie-app`'s CMD is the API; the
      # worker is the same build with a different entrypoint, which is the
      # whole reason the pipeline builds one image and not two (audit 7.5).
      command = var.command
      args    = var.args

      resources {
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
    }
  }

  scaling {
    manual_instance_count = var.instance_count
  }

  # Only the image, deliberately: every other attribute this resource might
  # carry is unverified here, and ignore_changes on an attribute that does not
  # exist is itself a validation error.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
    ]
  }
}
