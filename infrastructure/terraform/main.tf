provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

module "networking" {
  source = "./modules/networking"

  project_id  = var.project_id
  region      = var.region
  environment = var.environment
  labels      = local.labels
}

module "iam" {
  source = "./modules/iam"

  project_id  = var.project_id
  environment = var.environment
  labels      = local.labels
}

module "kms" {
  source = "./modules/kms"

  project_id  = var.project_id
  region      = var.region
  environment = var.environment
  labels      = local.labels
}

module "cloud_sql" {
  source = "./modules/cloud-sql"

  project_id  = var.project_id
  region      = var.region
  environment = var.environment
  labels      = local.labels

  network_id         = module.networking.network_id
  private_ip_address = module.networking.private_ip_address
  private_ip_name    = module.networking.private_ip_name

  depends_on = [module.networking]
}

module "redis" {
  source = "./modules/redis"

  project_id  = var.project_id
  region      = var.region
  environment = var.environment
  labels      = local.labels

  network_id = module.networking.network_id

  depends_on = [module.networking]
}

module "gcs" {
  source = "./modules/gcs"

  project_id  = var.project_id
  region      = var.region
  environment = var.environment
  labels      = local.labels
}

module "pubsub" {
  source = "./modules/pubsub"

  project_id  = var.project_id
  environment = var.environment
  labels      = local.labels

  worker_service_url = module.cloud_run.worker_service_url

  depends_on = [module.cloud_run]
}

module "cloud_run" {
  source = "./modules/cloud-run"

  project_id  = var.project_id
  region      = var.region
  environment = var.environment
  labels      = local.labels

  vpc_connector_id             = module.networking.vpc_connector_id
  api_service_account_email    = module.iam.api_service_account_email
  worker_service_account_email = module.iam.worker_service_account_email
  database_connection_name      = module.cloud_sql.connection_name
  redis_host                   = module.redis.host

  depends_on = [module.networking, module.iam, module.cloud_sql, module.redis]
}
