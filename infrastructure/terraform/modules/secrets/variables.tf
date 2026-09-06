variable "project_id" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "labels" {
  type = map(string)
}

variable "managed_secret_env" {
  description = "Operator-populated containers, keyed by the environment variable each feeds."
  type        = map(string)
}

variable "gateway_secret_env" {
  description = "Operator-populated containers for the push relay."
  type        = map(string)
}

variable "database_url" {
  type      = string
  sensitive = true
}

variable "storage_access_key_id" {
  type      = string
  sensitive = true
}

variable "storage_secret_access_key" {
  type      = string
  sensitive = true
}
