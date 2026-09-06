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

variable "versioning" {
  type = bool
}

variable "soft_delete_retention_days" {
  type = number
}
