terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.36, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
