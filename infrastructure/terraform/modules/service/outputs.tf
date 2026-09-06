output "name" {
  value = google_cloud_run_v2_service.this.name
}

output "uri" {
  description = "The service's own run.app URL. For the API this answers only to the load balancer."
  value       = google_cloud_run_v2_service.this.uri
}
