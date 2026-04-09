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

variable "network_id" {
  type = string
}

variable "private_ip_address" {
  type = string
}

variable "private_ip_name" {
  type = string
}

resource "google_sql_database_instance" "nessie" {
  name             = "nessie-pg-${var.environment}"
  project          = var.project_id
  region           = var.region
  database_version = "POSTGRES_16"

  settings {
    tier              = "db-custom-2-4096"
    availability_type = "REGIONAL"

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id

      enable_private_path_for_google_cloud_services = true
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    maintenance_window {
      day          = 7
      hour         = 4
      update_track = "stable"
    }

    user_labels = var.labels
  }

  deletion_protection = var.environment == "prod" ? true : false
}

resource "google_sql_database" "nessie" {
  name     = "nessie"
  project  = var.project_id
  instance = google_sql_database_instance.nessie.name
}

output "connection_name" {
  value = google_sql_database_instance.nessie.connection_name
}

output "instance_name" {
  value = google_sql_database_instance.nessie.name
}

output "private_ip" {
  value = google_sql_database_instance.nessie.private_ip_address
}

output "database_name" {
  value = google_sql_database.nessie.name
}
