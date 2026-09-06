variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "labels" {
  type = map(string)
}

variable "network_id" {
  type = string
}

variable "private_service_access_connection" {
  description = "Threaded in purely to order creation after the VPC peering exists."
  type        = string
}

variable "tier" {
  type = string
}

variable "availability_type" {
  type = string
}

variable "disk_size_gb" {
  type = number
}

variable "backup_retention_days" {
  type = number
}

variable "max_connections" {
  type = string
}

variable "deletion_protection" {
  type = bool
}
