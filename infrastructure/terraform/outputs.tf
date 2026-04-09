output "api_service_url" {
  description = "URL of the nessie-api Cloud Run service"
  value       = module.cloud_run.api_service_url
}

output "worker_service_url" {
  description = "URL of the nessie-worker Cloud Run service"
  value       = module.cloud_run.worker_service_url
}

output "database_connection_name" {
  description = "Cloud SQL instance connection name"
  value       = module.cloud_sql.connection_name
}

output "database_private_ip" {
  description = "Cloud SQL private IP address"
  value       = module.cloud_sql.private_ip
}

output "redis_host" {
  description = "Memorystore Redis host"
  value       = module.redis.host
}

output "artifacts_bucket" {
  description = "GCS artifacts bucket name"
  value       = module.gcs.bucket_name
}

output "api_service_account_email" {
  description = "API service account email"
  value       = module.iam.api_service_account_email
}

output "worker_service_account_email" {
  description = "Worker service account email"
  value       = module.iam.worker_service_account_email
}
