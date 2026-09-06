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

variable "ingress" {
  description = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER for the API, which is fronted by the external HTTPS load balancer and must not be reachable on its run.app address."
  type        = string
}

variable "public_invoker" {
  description = "Grant roles/run.invoker to allUsers. Required even behind the load balancer: ingress restricts who may connect, IAM restricts who may invoke, and the load balancer is an anonymous caller."
  type        = bool
  default     = true
}

variable "container_port" {
  description = "Port the container listens on. Cloud Run publishes it as PORT, which packages/config accepts as a lower-precedence fallback for api.port — which is why NESSIE_API_PORT is deliberately not set."
  type        = number
  default     = 8080
}

variable "cpu" {
  type = string
}

variable "memory" {
  type = string
}

variable "min_instances" {
  type = number
}

variable "max_instances" {
  type = number
}

variable "concurrency" {
  type = number
}

variable "request_timeout_seconds" {
  type = number
}

variable "network_id" {
  type    = string
  default = ""
}

variable "subnet_id" {
  description = "Empty attaches no VPC network, which is right for a service that talks only to the public internet."
  type        = string
  default     = ""
}

variable "plain_env" {
  type = map(string)
}

variable "secret_env" {
  description = "Environment variable name to Secret Manager secret id. Always resolved at `latest`."
  type        = map(string)
  default     = {}
}

variable "startup_probe_path" {
  type    = string
  default = ""
}

variable "liveness_probe_path" {
  type    = string
  default = ""
}
