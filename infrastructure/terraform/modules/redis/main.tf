variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "environment" {
  type = string
}

variable "labels" {
  type = map(string)
}

variable "network_id" {
  type = string
}

resource "google_redis_instance" "nessie" {
  name           = "nessie-redis-${var.environment}"
  project        = var.project_id
  region         = var.region
  tier           = "BASIC"
  memory_size_gb = 1

  authorized_network = var.network_id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"

  redis_version = "REDIS_7_2"

  labels = var.labels
}

output "host" {
  value = google_redis_instance.nessie.host
}

output "port" {
  value = google_redis_instance.nessie.port
}

output "instance_id" {
  value = google_redis_instance.nessie.id
}
