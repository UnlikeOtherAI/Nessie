variable "project_id" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "environment" {
  type = string
}

variable "backend_secret_ids" {
  description = "Secrets the API, worker and migrate job read."
  type        = list(string)
}

variable "gateway_secret_ids" {
  description = "Secrets the push relay reads."
  type        = list(string)
}

variable "github_repository" {
  description = "owner/repo allowed to impersonate the deploy service account through Workload Identity Federation. Empty provisions no deploy identity at all."
  type        = string
  default     = ""
}
