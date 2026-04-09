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

resource "google_compute_network" "nessie" {
  name                    = "nessie-vpc"
  project                 = var.project_id
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "cloudrun" {
  name          = "nessie-cloudrun-${var.environment}"
  project       = var.project_id
  region        = var.region
  network       = google_compute_network.nessie.id
  ip_cidr_range = "10.0.0.0/24"

  private_ip_google_access = true
}

resource "google_compute_global_address" "private_ip" {
  name          = "nessie-private-ip-${var.environment}"
  project       = var.project_id
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.nessie.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.nessie.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip.name]
}

resource "google_vpc_access_connector" "nessie" {
  name          = "nessie-connector"
  project       = var.project_id
  region        = var.region
  network       = google_compute_network.nessie.id
  ip_cidr_range = "10.8.0.0/28"

  min_instances = 2
  max_instances = 3

  depends_on = [google_compute_network.nessie]
}

output "network_id" {
  value = google_compute_network.nessie.id
}

output "subnet_id" {
  value = google_compute_subnetwork.cloudrun.id
}

output "vpc_connector_id" {
  value = google_vpc_access_connector.nessie.id
}

output "private_ip_address" {
  value = google_compute_global_address.private_ip.address
}

output "private_ip_name" {
  value = google_compute_global_address.private_ip.name
}
