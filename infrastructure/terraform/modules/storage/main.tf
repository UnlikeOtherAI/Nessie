# The attachment / knowledge-base object store.
#
# A GCS bucket reached through the existing S3-compatible backend
# (packages/runtime/src/storage/s3.ts) on GCS's interoperability endpoint. That
# backend streams through @aws-sdk/lib-storage's multipart Upload, so a 5 GiB
# body costs ~32 MiB of memory rather than 5 GiB. The native GCS backend in the
# same package is buffer-only and is not a production path.
#
# Interoperability needs an HMAC key, and an HMAC key belongs to a service
# account. It is minted here for the backend service account so the same
# identity that Cloud Run runs as is the one the S3 signature names.
#
# UNPROVEN: nothing has yet run this backend against a real GCS bucket. The
# multipart path in particular is the part to smoke-test first — see
# docs/deployment/gcloud.md.

# Bucket names are global, not per-project, so the project id is part of the
# name. A project id long enough to push this past 63 characters needs the
# name overridden by hand.
resource "google_storage_bucket" "attachments" {
  name                        = "${var.project_id}-${var.name_prefix}-attachments"
  project                     = var.project_id
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  force_destroy               = false
  labels                      = var.labels

  versioning {
    enabled = var.versioning
  }

  soft_delete_policy {
    retention_duration_seconds = var.soft_delete_retention_days * 24 * 60 * 60
  }

  # Attachments are served through the API, never from a browser origin
  # directly, so no CORS rule is configured. Adding one is what the signed-URL
  # redirect for large downloads would need.
  lifecycle_rule {
    condition {
      num_newer_versions = 3
    }

    action {
      type = "Delete"
    }
  }
}

# The HMAC key's own identity, scoped to this bucket and nothing else. It is
# not the identity the services run as: the key is a bearer credential in their
# environment, so its privileges are the blast radius of that environment
# leaking, and it must therefore be able to reach the attachment bucket and
# nothing else in the project.
resource "google_service_account" "interop" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-storage"
  display_name = "Nessie object storage interoperability"
}

resource "google_storage_bucket_iam_member" "interop" {
  bucket = google_storage_bucket.attachments.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.interop.email}"
}

resource "google_storage_hmac_key" "interop" {
  project               = var.project_id
  service_account_email = google_service_account.interop.email
}
