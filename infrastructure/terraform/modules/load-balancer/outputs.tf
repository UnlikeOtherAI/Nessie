output "ip_address" {
  description = "The address api_hostname's A record must point at before the managed certificate can be issued."
  value       = google_compute_global_address.api.address
}

output "certificate_name" {
  description = "Managed certificate; `gcloud compute ssl-certificates describe` reports its provisioning state."
  value       = google_compute_managed_ssl_certificate.api.name
}
