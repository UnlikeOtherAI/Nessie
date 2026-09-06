output "generated_secret_ids" {
  description = "Secret ids terraform mints and populates, keyed by short name."
  value       = { for key, secret in google_secret_manager_secret.generated : key => secret.secret_id }
}

output "managed_secret_ids" {
  description = "Operator-populated secret ids, keyed by the environment variable each feeds."
  value       = { for key, secret in google_secret_manager_secret.managed : key => secret.secret_id }
}

output "gateway_secret_ids" {
  description = "Push-relay secret ids, keyed by environment variable."
  value       = { for key, secret in google_secret_manager_secret.gateway : key => secret.secret_id }
}

output "all_secret_ids" {
  description = "Every container this module creates, for operator tooling that lists what still needs a version."
  value       = concat(
    [for secret in google_secret_manager_secret.generated : secret.secret_id],
    [for secret in google_secret_manager_secret.managed : secret.secret_id],
    [for secret in google_secret_manager_secret.gateway : secret.secret_id],
  )
}
