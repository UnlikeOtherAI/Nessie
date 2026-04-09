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

resource "google_kms_key_ring" "nessie" {
  name     = "nessie-${var.environment}"
  project  = var.project_id
  location = var.region
}

resource "google_kms_crypto_key" "tenant_secrets" {
  name     = "nessie-tenant-secrets"
  key_ring = google_kms_key_ring.nessie.id
  purpose  = "ENCRYPT_DECRYPT"

  rotation_period = "7776000s" # 90 days

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  labels = var.labels

  lifecycle {
    prevent_destroy = true
  }
}

output "key_ring_id" {
  value = google_kms_key_ring.nessie.id
}

output "tenant_secrets_key_id" {
  value = google_kms_crypto_key.tenant_secrets.id
}

output "tenant_secrets_key_name" {
  value = google_kms_crypto_key.tenant_secrets.name
}
