variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "api_hostname" {
  type = string
}

variable "api_service_name" {
  type = string
}

variable "backend_timeout_seconds" {
  description = "Must be at least the Cloud Run request timeout, or the load balancer cuts long SSE streams the service is still writing."
  type        = number
  default     = 3600
}

variable "log_sample_rate" {
  description = "Fraction of requests logged. 1.0 while the deployment is new and unproven; lower it once the shape of normal traffic is known."
  type        = number
  default     = 1.0
}
