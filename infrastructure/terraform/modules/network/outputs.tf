output "network_id" {
  description = "Self link of the VPC."
  value       = google_compute_network.main.id
}

output "subnet_id" {
  description = "Self link of the subnet Cloud Run attaches to."
  value       = google_compute_subnetwork.main.id
}

output "private_service_access_connection" {
  description = "The peering connection Cloud SQL's private IP depends on. Consumed as an explicit dependency so the instance is never created before the peering exists."
  value       = google_service_networking_connection.private_service_access.id
}
