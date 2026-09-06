# VPC, the subnet Cloud Run attaches to with direct VPC egress, and the
# private services connection Cloud SQL's private IP is allocated from.
#
# There is no Serverless VPC Access connector here on purpose: direct VPC
# egress attaches a revision straight to the subnet, which removes the
# connector's own instances, its cost and its throughput ceiling. It costs one
# subnet address per running instance, which is why the subnet is a /24 and not
# a /28.
#
# There is no Cloud NAT either: egress is PRIVATE_RANGES_ONLY, so traffic to
# Ledger, UOA and Infisical leaves through Cloud Run's own internet path and
# only RFC1918 destinations enter the VPC.

resource "google_compute_network" "main" {
  name                    = "${var.name_prefix}-vpc"
  project                 = var.project_id
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name                     = "${var.name_prefix}-subnet"
  project                  = var.project_id
  region                   = var.region
  network                  = google_compute_network.main.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_service_access" {
  name          = "${var.name_prefix}-psa"
  project       = var.project_id
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.private_service_access_prefix_length
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_service_access" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_access.name]
}
