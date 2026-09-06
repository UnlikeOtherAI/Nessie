output "name" {
  description = "Job name the deploy workflow executes with `gcloud run jobs execute --wait`."
  value       = google_cloud_run_v2_job.migrate.name
}
