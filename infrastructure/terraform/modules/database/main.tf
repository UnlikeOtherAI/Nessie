# Cloud SQL for PostgreSQL 17 with a private address.
#
# 17, not 16: production runs pgvector on pg17 and the retired tree's 16 was a
# silent downgrade (audit 7.6). The `vector`, `pg_trgm` and `pgcrypto`
# extensions are created by the migrations themselves
# (20260408140000_enable_pgvector and friends), so the migrating role must be a
# member of cloudsqlsuperuser — which the Cloud SQL default user is. That is
# why the application user below is the one the migrate job runs as.
#
# No managed connection pooling is provisioned here. The API keeps a dedicated
# Postgres LISTEN client, and a transaction-mode pooler in front of it breaks
# LISTEN silently. Sizing is done with max_connections and NESSIE_DB_POOL_MAX
# instead; adding a pooler later is a deliberate change that has to route the
# listener around it.

resource "google_sql_database_instance" "main" {
  name                = "${var.name_prefix}-pg"
  project             = var.project_id
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.tier
    availability_type = var.availability_type
    disk_size         = var.disk_size_gb
    disk_type         = "PD_SSD"
    disk_autoresize   = true
    edition           = "ENTERPRISE"

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "02:00"
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = var.backup_retention_days
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = var.network_id
      enable_private_path_for_google_cloud_services = true
      ssl_mode                                      = "ENCRYPTED_ONLY"
    }

    database_flags {
      name  = "max_connections"
      value = var.max_connections
    }

    # The realtime bus is LISTEN/NOTIFY over a long-lived client. A short
    # idle-session timeout would reap it between quiet periods and the listener
    # would only notice at the next publish.
    database_flags {
      name  = "idle_in_transaction_session_timeout"
      value = "300000"
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = true
    }

    maintenance_window {
      day          = 7
      hour         = 3
      update_track = "stable"
    }

    user_labels = var.labels
  }

  depends_on = [var.private_service_access_connection]
}

resource "google_sql_database" "nessie" {
  name     = "nessie"
  project  = var.project_id
  instance = google_sql_database_instance.main.name
}

# Generated, never committed and never printed. It reaches the services only as
# part of the DATABASE_URL secret; it is in terraform state, which is why the
# state bucket has to be private (see versions.tf).
resource "random_password" "app_user" {
  length  = 40
  special = false
}

resource "google_sql_user" "app" {
  name     = "nessie"
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  password = random_password.app_user.result
}
