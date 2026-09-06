# Provider and state pinning.
#
# `google-beta` is not decoration: the worker runs as a Cloud Run *worker pool*
# (`modules/worker`), which is the only Cloud Run primitive that accepts a
# container binding no port. The Nessie worker binds none, which is exactly why
# the retired tree's HTTP worker Service could never have become ready.
terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.36, < 7.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 6.36, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State holds the generated database password, the generated auth secret and
  # the GCS HMAC key material, so the state bucket must be private, versioned
  # and access-logged. Bucket name is supplied at init time so no project
  # identifier is committed:
  #   terraform init -backend-config="bucket=<state-bucket>"
  backend "gcs" {
    prefix = "terraform/state"
  }
}
