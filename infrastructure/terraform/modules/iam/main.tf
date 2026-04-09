variable "project_id" {
  type = string
}

variable "environment" {
  type = string
}

variable "labels" {
  type = map(string)
}

resource "google_service_account" "api" {
  account_id   = "nessie-api"
  display_name = "Nessie API (${var.environment})"
  project      = var.project_id
}

resource "google_service_account" "worker" {
  account_id   = "nessie-worker"
  display_name = "Nessie Worker (${var.environment})"
  project      = var.project_id
}

locals {
  api_roles = [
    "roles/run.invoker",
    "roles/cloudsql.client",
    "roles/pubsub.publisher",
    "roles/secretmanager.secretAccessor",
    "roles/storage.objectViewer",
  ]

  worker_roles = [
    "roles/cloudsql.client",
    "roles/pubsub.subscriber",
    "roles/pubsub.publisher",
    "roles/secretmanager.secretAccessor",
    "roles/storage.objectAdmin",
    "roles/cloudkms.cryptoKeyEncrypterDecrypter",
  ]
}

resource "google_project_iam_member" "api" {
  for_each = toset(local.api_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "worker" {
  for_each = toset(local.worker_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.worker.email}"
}

output "api_service_account_email" {
  value = google_service_account.api.email
}

output "worker_service_account_email" {
  value = google_service_account.worker.email
}

output "api_service_account_id" {
  value = google_service_account.api.id
}

output "worker_service_account_id" {
  value = google_service_account.worker.id
}
