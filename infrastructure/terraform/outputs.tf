output "api_load_balancer_ip" {
  description = "Point api_hostname's A record here. The Google-managed certificate cannot be issued until it resolves."
  value       = module.load_balancer.ip_address
}

output "api_certificate_name" {
  description = "gcloud compute ssl-certificates describe <name> --global reports PROVISIONING until DNS propagates."
  value       = module.load_balancer.certificate_name
}

output "api_service_name" {
  description = "Cloud Run service the deploy workflow rolls revisions on."
  value       = module.api.name
}

output "worker_pool_name" {
  value = module.worker.name
}

output "gateway_service_name" {
  description = "Empty when gateway_enabled is false."
  value       = length(module.gateway) > 0 ? module.gateway[0].name : ""
}

output "migrate_job_name" {
  description = "The gate. `gcloud run jobs execute <name> --wait` must succeed before any revision takes traffic."
  value       = module.migrate_job.name
}

output "artifact_registry_url" {
  description = "Image path prefix for docker push and for the app_image / gateway_image variables."
  value       = module.registry.repository_url
}

output "database_connection_name" {
  description = "For gcloud sql connect and the Cloud SQL Auth Proxy when an operator needs a psql session."
  value       = module.database.connection_name
}

output "database_private_ip" {
  value = module.database.private_ip
}

output "attachments_bucket" {
  value = module.storage.bucket_name
}

output "secrets_needing_versions" {
  description = "Every Secret Manager container this tree creates. The four generated ones already hold a version; the rest need one before their name may appear in injected_secret_env."
  value       = module.secrets.all_secret_ids
}

output "deploy_service_account_email" {
  description = "Set this as the GCLOUD_DEPLOY_SERVICE_ACCOUNT repository variable. Empty when github_repository is unset."
  value       = module.iam.deploy_service_account_email
}

output "workload_identity_provider" {
  description = "Set this as the GCLOUD_WORKLOAD_IDENTITY_PROVIDER repository variable. Empty when github_repository is unset."
  value       = module.iam.workload_identity_provider
}
