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

resource "google_storage_bucket" "artifacts" {
  name     = "nessie-${var.environment}-artifacts"
  project  = var.project_id
  location = var.region

  uniform_bucket_level_access = true
  versioning {
    enabled = false
  }

  lifecycle_rule {
    condition {
      age                = 90
      with_state         = "ARCHIVED"
      num_newer_versions = 1
    }
    action {
      type = "Delete"
    }
  }

  labels = var.labels
}

output "bucket_name" {
  value = google_storage_bucket.artifacts.name
}

output "bucket_url" {
  value = google_storage_bucket.artifacts.url
}
