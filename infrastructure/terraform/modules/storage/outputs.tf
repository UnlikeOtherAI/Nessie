output "bucket_name" {
  description = "NESSIE_STORAGE_BUCKET."
  value       = google_storage_bucket.attachments.name
}

output "interop_service_account_email" {
  description = "Identity the HMAC key authenticates as. Holds objectAdmin on this bucket only."
  value       = google_service_account.interop.email
}

output "hmac_access_id" {
  description = "NESSIE_STORAGE_ACCESS_KEY_ID."
  value       = google_storage_hmac_key.interop.access_id
  sensitive   = true
}

output "hmac_secret" {
  description = "NESSIE_STORAGE_SECRET_ACCESS_KEY."
  value       = google_storage_hmac_key.interop.secret
  sensitive   = true
}
