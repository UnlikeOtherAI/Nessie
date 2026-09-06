# Service accounts and the bindings that make each one useless outside its own
# job.
#
# Four runtime identities, not one: the gateway must not be able to read the
# database URL, and the migrate job is the only thing that ever needs to write
# schema. The fifth identity — the one that owns the GCS interoperability HMAC
# key — lives in the storage module beside the bucket it is scoped to, because
# that key is a bearer credential sitting in the API's and worker's
# environment and what it can reach is its whole blast radius.
#
# No roles/cloudsql.client anywhere: the services reach Cloud SQL over a
# private address with password authentication, which is a network path, not an
# IAM one. Adding the Cloud SQL Auth Proxy or IAM database authentication is
# what would need that role.

locals {
  runtime_accounts = {
    api     = "API service"
    worker  = "Worker pool"
    migrate = "Migrate and reconcile job"
    gateway = "Push relay"
  }

  backend_accounts = ["api", "worker", "migrate"]

  backend_secret_bindings = {
    for pair in setproduct(local.backend_accounts, var.backend_secret_ids) :
    "${pair[0]}:${pair[1]}" => {
      account = pair[0]
      secret  = pair[1]
    }
  }

  gateway_secret_bindings = {
    for secret in var.gateway_secret_ids :
    secret => secret
  }
}

resource "google_service_account" "runtime" {
  for_each = local.runtime_accounts

  project      = var.project_id
  account_id   = "${var.name_prefix}-${each.key}"
  display_name = "Nessie ${var.environment} ${each.value}"
}

# Cloud Run writes request logs as the revision's service account, so a custom
# account with no logWriter produces a service whose logs silently vanish.
resource "google_project_iam_member" "log_writer" {
  for_each = local.runtime_accounts

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.runtime[each.key].email}"
}

resource "google_secret_manager_secret_iam_member" "backend" {
  for_each = local.backend_secret_bindings

  project   = var.project_id
  secret_id = each.value.secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value.account].email}"
}

resource "google_secret_manager_secret_iam_member" "gateway" {
  for_each = local.gateway_secret_bindings

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime["gateway"].email}"
}
