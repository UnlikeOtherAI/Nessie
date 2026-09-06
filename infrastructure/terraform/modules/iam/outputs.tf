output "api_service_account_email" {
  value = google_service_account.runtime["api"].email
}

output "worker_service_account_email" {
  value = google_service_account.runtime["worker"].email
}

output "migrate_service_account_email" {
  value = google_service_account.runtime["migrate"].email
}

output "gateway_service_account_email" {
  value = google_service_account.runtime["gateway"].email
}

output "deploy_service_account_email" {
  description = "Empty when github_repository is unset."
  value       = length(google_service_account.deploy) > 0 ? google_service_account.deploy[0].email : ""
}

output "workload_identity_provider" {
  description = "Full resource name for google-github-actions/auth. Empty when github_repository is unset."
  value       = length(google_iam_workload_identity_pool_provider.github) > 0 ? google_iam_workload_identity_pool_provider.github[0].name : ""
}
