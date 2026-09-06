# Nessie on Google Cloud.
#
# Topology, in the order the modules appear:
#
#   network         VPC, the subnet Cloud Run attaches to, and the private
#                   services peering Cloud SQL's address comes from.
#   database        Cloud SQL for PostgreSQL 17, private address only.
#   storage         GCS attachment bucket plus the interoperability HMAC key
#                   the existing S3 backend signs with.
#   secrets         Secret Manager: four generated, the rest operator-populated.
#   registry        Artifact Registry, one repository.
#   iam             One service account per job, plus the optional deploy
#                   identity and its GitHub OIDC federation.
#   api             Cloud Run service, CPU always allocated, min 1.
#   worker          Cloud Run worker pool: no ingress, no port, always-on CPU.
#   gateway         Cloud Run service, optional, min 0.
#   migrate_job     Cloud Run job. Every rollout gates on it.
#   load_balancer   External HTTPS load balancer in front of the API.
#
# There is no Pub/Sub and no Redis. Postgres is the queue (PgQueueProvider) and
# the realtime bus (PgRealtimeTransport) by decision, and both modules in the
# retired tree provisioned infrastructure nothing read.

module "network" {
  source = "./modules/network"

  project_id                           = var.project_id
  region                               = var.region
  name_prefix                          = local.name_prefix
  subnet_cidr                          = var.subnet_cidr
  private_service_access_prefix_length = var.private_service_access_prefix_length

  depends_on = [google_project_service.required]
}

module "database" {
  source = "./modules/database"

  project_id                        = var.project_id
  region                            = var.region
  name_prefix                       = local.name_prefix
  labels                            = local.labels
  network_id                        = module.network.network_id
  private_service_access_connection = module.network.private_service_access_connection
  tier                              = var.db_tier
  availability_type                 = var.db_availability_type
  disk_size_gb                      = var.db_disk_size_gb
  backup_retention_days             = var.db_backup_retention_days
  max_connections                   = var.db_max_connections
  deletion_protection               = var.db_deletion_protection
}

module "storage" {
  source = "./modules/storage"

  project_id                 = var.project_id
  region                     = var.region
  name_prefix                = local.name_prefix
  labels                     = local.labels
  versioning                 = var.storage_versioning
  soft_delete_retention_days = var.storage_soft_delete_retention_days

  depends_on = [google_project_service.required]
}

module "secrets" {
  source = "./modules/secrets"

  project_id                = var.project_id
  name_prefix               = local.name_prefix
  labels                    = local.labels
  managed_secret_env        = var.managed_secret_env
  gateway_secret_env        = var.gateway_secret_env
  database_url              = module.database.database_url
  storage_access_key_id     = module.storage.hmac_access_id
  storage_secret_access_key = module.storage.hmac_secret
}

module "registry" {
  source = "./modules/registry"

  project_id  = var.project_id
  region      = var.region
  name_prefix = local.name_prefix
  labels      = local.labels

  depends_on = [google_project_service.required]
}

module "iam" {
  source = "./modules/iam"

  project_id         = var.project_id
  name_prefix        = local.name_prefix
  environment        = var.environment
  backend_secret_ids = local.backend_secret_ids
  gateway_secret_ids = local.gateway_secret_ids
  github_repository  = var.github_repository

  depends_on = [google_project_service.required]
}

module "api" {
  source = "./modules/service"

  project_id              = var.project_id
  region                  = var.region
  name                    = "${local.name_prefix}-api"
  labels                  = local.labels
  image                   = var.app_image
  service_account_email   = module.iam.api_service_account_email
  ingress                 = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  cpu                     = var.api_cpu
  memory                  = var.api_memory
  min_instances           = var.api_min_instances
  max_instances           = var.api_max_instances
  concurrency             = var.api_concurrency
  request_timeout_seconds = var.api_request_timeout_seconds
  network_id              = module.network.network_id
  subnet_id               = module.network.subnet_id
  plain_env               = local.api_plain_env
  secret_env              = local.secret_env
  startup_probe_path      = "/api/health/ready"
  liveness_probe_path     = "/api/health"
}

module "worker" {
  source = "./modules/worker"

  project_id            = var.project_id
  region                = var.region
  name                  = "${local.name_prefix}-worker"
  labels                = local.labels
  image                 = var.app_image
  service_account_email = module.iam.worker_service_account_email
  network_id            = module.network.network_id
  subnet_id             = module.network.subnet_id
  cpu                   = var.worker_cpu
  memory                = var.worker_memory
  instance_count        = var.worker_instance_count
  plain_env             = local.worker_plain_env
  secret_env            = local.secret_env
}

module "gateway" {
  source = "./modules/service"
  count  = var.gateway_enabled ? 1 : 0

  project_id              = var.project_id
  region                  = var.region
  name                    = "${local.name_prefix}-gateway"
  labels                  = local.labels
  image                   = var.gateway_image
  service_account_email   = module.iam.gateway_service_account_email
  ingress                 = "INGRESS_TRAFFIC_ALL"
  cpu                     = var.gateway_cpu
  memory                  = var.gateway_memory
  min_instances           = var.gateway_min_instances
  max_instances           = var.gateway_max_instances
  concurrency             = 80
  request_timeout_seconds = 60
  plain_env               = local.gateway_plain_env
  secret_env              = local.gateway_secret_env
  startup_probe_path      = "/health"
  liveness_probe_path     = "/health"
}

module "migrate_job" {
  source = "./modules/job"

  project_id            = var.project_id
  region                = var.region
  name                  = "${local.name_prefix}-migrate"
  labels                = local.labels
  image                 = var.app_image
  service_account_email = module.iam.migrate_service_account_email
  network_id            = module.network.network_id
  subnet_id             = module.network.subnet_id
  plain_env             = local.job_plain_env
  secret_env            = local.secret_env
}

module "load_balancer" {
  source = "./modules/load-balancer"

  project_id              = var.project_id
  region                  = var.region
  name_prefix             = local.name_prefix
  api_hostname            = var.api_hostname
  api_service_name        = module.api.name
  backend_timeout_seconds = var.api_request_timeout_seconds
}
