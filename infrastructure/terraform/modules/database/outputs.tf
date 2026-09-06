output "instance_name" {
  description = "Cloud SQL instance name."
  value       = google_sql_database_instance.main.name
}

output "connection_name" {
  description = "project:region:instance, for gcloud sql connect and the Cloud SQL Auth Proxy."
  value       = google_sql_database_instance.main.connection_name
}

output "private_ip" {
  description = "Private address the services connect to over direct VPC egress."
  value       = google_sql_database_instance.main.private_ip_address
}

output "database_url" {
  description = "Full DATABASE_URL for the application user. Written to Secret Manager, never to an output an operator reads casually."
  value       = "postgresql://${google_sql_user.app.name}:${urlencode(random_password.app_user.result)}@${google_sql_database_instance.main.private_ip_address}:5432/${google_sql_database.nessie.name}?schema=public"
  sensitive   = true
}
