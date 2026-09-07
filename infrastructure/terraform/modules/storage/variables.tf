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

# Browser origins allowed to fetch an object directly. Empty disables CORS on
# the bucket, which also means signed-URL downloads cannot work from a browser.
variable "cors_origins" {
  type    = list(string)
  default = []
}
