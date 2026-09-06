variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "name" {
  type = string
}

variable "labels" {
  type = map(string)
}

variable "image" {
  type = string
}

variable "service_account_email" {
  type = string
}

variable "network_id" {
  type = string
}

variable "subnet_id" {
  type = string
}

variable "cpu" {
  description = "A migration is one connection doing DDL; 2 vCPU is for the reconcile step's batched upserts, not for the migration."
  type        = string
  default     = "2"
}

variable "memory" {
  type    = string
  default = "4Gi"
}

variable "timeout_seconds" {
  description = "One hour. An index build on a large `messages` table is the long pole; a migration slower than this needs to be run deliberately, not inside a deploy gate."
  type        = number
  default     = 3600
}

variable "plain_env" {
  type = map(string)
}

variable "secret_env" {
  type    = map(string)
  default = {}
}
