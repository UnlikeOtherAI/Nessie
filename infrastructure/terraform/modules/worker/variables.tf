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

variable "command" {
  description = "Entrypoint override. The image ships the API as its CMD."
  type        = list(string)
  default     = ["node"]
}

variable "args" {
  type    = list(string)
  default = ["worker/dist/index.js"]
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
  type = string
}

variable "memory" {
  type = string
}

variable "instance_count" {
  type = number
}

variable "plain_env" {
  type = map(string)
}

variable "secret_env" {
  type    = map(string)
  default = {}
}
