# The migrate-and-reconcile job.
#
# Same image as the API, a command override, and the gate every rollout passes
# through. It runs, in order:
#
#   1. the RESOLVABLE_FAILED_MIGRATIONS repair that redeploy.sh carries,
#   2. `prisma migrate deploy`,
#   3. the App Store catalogue seeds,
#   4. `pnpm --filter @nessie/api reconcile`.
#
# Step 1 is the reason this is a script and not a bare command. Prisma stops at
# the first failed migration and refuses every later one with P3009, so one
# migration that died mid-deploy parks the whole installation until somebody
# clears it by hand — production sat un-deployable for a day that way. The
# script is at infrastructure/gcloud/migrate-entrypoint.sh and ships inside the
# image, and NESSIE_MIGRATE_RESOLVE_ROLLED_BACK is the operator's escape hatch:
# a comma-separated list of migrations to mark rolled back on this execution
# only, so clearing a newly parked migration is a job override rather than a
# code change and a rebuild.
#
# Step 4 is not optional. Boot connects and listens and nothing else
# (docs/standards/horizontal-scaling.md invariant 5), so policy seeding, the
# protected-grant backfill, Personal Assistant default grants and the
# credential sweep only ever happen here.

resource "google_cloud_run_v2_job" "migrate" {
  name                = var.name
  project             = var.project_id
  location            = var.region
  labels              = var.labels
  deletion_protection = false

  template {
    # One task, never parallel: two concurrent `migrate deploy` runs against one
    # database is the failure mode this job exists to avoid.
    task_count  = 1
    parallelism = 1

    template {
      service_account = var.service_account_email

      # One retry. A migration that fails for a transient reason (a Cloud SQL
      # failover mid-apply) is worth retrying; one that fails on its SQL fails
      # identically the second time and the deploy should stop.
      max_retries = 1
      timeout     = "${var.timeout_seconds}s"

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"

        network_interfaces {
          network    = var.network_id
          subnetwork = var.subnet_id
        }
      }

      containers {
        image   = var.image
        command = ["bash"]
        args    = ["/app/infrastructure/gcloud/migrate-entrypoint.sh"]

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
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }
}
