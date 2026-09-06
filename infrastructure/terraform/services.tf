# API enablement.
#
# Every module below depends on one of these, and a first apply into a fresh
# project fails with an opaque 403 from whichever API happens to be reached
# first. Enabling them here makes the failure a wait instead of a mystery.
#
# `disable_on_destroy = false`: a `terraform destroy` of this tree must not turn
# off APIs another workload in the same project is using.

resource "google_project_service" "required" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "sts.googleapis.com",
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
