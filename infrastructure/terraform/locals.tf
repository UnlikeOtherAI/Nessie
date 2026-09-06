# The environment the services actually need.
#
# Derived from packages/config/src/index.ts (ConfigEnvMap plus the handful the
# API reads through process.env directly), not from the retired tree. Area 7.3
# of the audit records four the API refuses to start — or silently misbehaves —
# without: NESSIE_API_PUBLIC_URL, NESSIE_ADMIN_PUBLIC_URL, NESSIE_CORS_ORIGINS
# and NESSIE_API_TRUSTED_PROXY_HOPS. All four are below, and
# NESSIE_AUTH_SECRET (hard failure in hosted/selfHosted) and NESSIE_CONFIG_PATH
# (no env path exists for auth.providers, so SSO is off without it) with them.
#
# Empty values are stripped rather than passed as "": the config loader treats
# an explicitly empty variable as "no override", so an empty string and an
# absent variable mean the same thing, and stripping keeps `gcloud run services
# describe` readable.

locals {
  name_prefix = "nessie-${var.environment}"

  labels = {
    application = "nessie"
    environment = var.environment
    managed-by  = "terraform"
  }

  api_public_url = "https://${var.api_hostname}"

  # Ledger's OpenAI-compatible transport. Nessie rewrites this per request to
  # Ledger's /v1/:serviceId/* route using NESSIE_MODEL_SERVICE_ID.
  model_base_url = "${var.ledger_public_url}/v1/openai"

  # Plain (non-secret) environment shared by the API, the worker and the
  # migrate job. Every one of these is either an operator-declared origin, a
  # routing segment or a tuning number; none is a credential.
  shared_plain_env_raw = {
    NODE_ENV                            = "production"
    NESSIE_MODE                         = var.nessie_mode
    NESSIE_CONFIG_PATH                  = var.config_path
    NESSIE_API_PUBLIC_URL               = local.api_public_url
    NESSIE_ADMIN_PUBLIC_URL             = var.admin_public_url
    NESSIE_SHUTDOWN_TIMEOUT_MS          = tostring(var.shutdown_timeout_ms)
    NESSIE_DB_POOL_MAX                  = tostring(var.db_pool_max)
    NESSIE_DB_POOL_MIN                  = tostring(var.db_pool_min)
    NESSIE_STORAGE_PROVIDER             = "s3"
    NESSIE_STORAGE_ENDPOINT             = var.storage_endpoint
    NESSIE_STORAGE_REGION               = var.region
    NESSIE_STORAGE_FORCE_PATH_STYLE     = tostring(var.storage_force_path_style)
    NESSIE_STORAGE_BUCKET               = module.storage.bucket_name
    NESSIE_MAX_UPLOAD_BYTES             = tostring(var.max_upload_bytes)
    NESSIE_MODEL_PROVIDER               = var.model_provider
    NESSIE_MODEL_BASE_URL               = local.model_base_url
    NESSIE_MODEL_SERVICE_ID             = var.model_service_id
    NESSIE_MODEL_NAME                   = var.model_name
    NESSIE_EMBEDDING_PROVIDER           = var.embedding_provider
    NESSIE_EMBEDDING_SERVICE_ID         = var.embedding_service_id
    NESSIE_EMBEDDING_MODEL              = var.embedding_model
    NESSIE_LEDGER_IMAGE_PURPOSE_API_ID  = var.ledger_image_purpose_api_id
    NESSIE_LEDGER_SEARCH_PURPOSE_API_ID = var.ledger_search_purpose_api_id
    LEDGER_PUBLIC_URL                   = var.ledger_public_url
    UOA_BASE_URL                        = var.uoa_base_url
    INFISICAL_API_URL                   = var.infisical_api_url
    INFISICAL_PROJECT_ID                = var.infisical_project_id
    INFISICAL_ENVIRONMENT               = var.infisical_environment
    NESSIE_TEAM_HOST_BASE_DOMAIN        = var.team_host_base_domain
  }

  shared_plain_env = {
    for name, value in merge(local.shared_plain_env_raw, var.extra_env) :
    name => value if value != ""
  }

  # API only. NESSIE_API_PORT is deliberately NOT set: Cloud Run injects PORT,
  # and packages/config accepts PORT as a lower-precedence fallback for exactly
  # this case. Pinning NESSIE_API_PORT here would override the platform.
  api_plain_env = merge(local.shared_plain_env, {
    NESSIE_API_HOST               = "0.0.0.0"
    NESSIE_CORS_ORIGINS           = join(",", var.cors_origins)
    NESSIE_API_TRUSTED_PROXY_HOPS = tostring(var.trusted_proxy_hops)
  })

  # The worker takes no ingress, so it needs no CORS allowlist and no proxy
  # trust. It does need the public API origin: the personal assistant's
  # connector_authorize flow mints OAuth redirect URIs outside any request.
  # NESSIE_SHUTDOWN_TIMEOUT_MS rides along in the shared block, and the worker
  # never reads it — the API and gateway do. The worker's own budget is this
  # variable, read straight from the environment, so it is set explicitly rather
  # than left to the application default an operator cannot see from here.
  worker_plain_env = merge(local.shared_plain_env, {
    NESSIE_WORKER_DRAIN_TIMEOUT_MS = tostring(var.worker_drain_timeout_ms)
  })

  # The migrate job runs `prisma migrate deploy` and then `reconcile`, which
  # loads the same config as the API. Giving it the API's environment is
  # deliberate: a job missing a variable fails a deploy at the gate, which is
  # the one place a missing variable is cheap.
  job_plain_env = merge(local.api_plain_env, {
    NESSIE_MIGRATE_RESOLVE_ROLLED_BACK = ""
  })

  # GATEWAY_PORT is deliberately unset: the gateway falls back to PORT, which
  # Cloud Run injects.
  gateway_plain_env = merge({
    NODE_ENV                   = "production"
    GATEWAY_HOST               = "0.0.0.0"
    NESSIE_SHUTDOWN_TIMEOUT_MS = tostring(var.shutdown_timeout_ms)
  }, var.gateway_extra_env)

  # Secret-backed environment. The first five are generated and populated by
  # this tree; the rest are operator-populated containers the operator opts
  # into once a version exists.
  generated_secret_env = {
    DATABASE_URL                     = module.secrets.generated_secret_ids["database-url"]
    NESSIE_DB_URL                    = module.secrets.generated_secret_ids["database-url"]
    NESSIE_AUTH_SECRET               = module.secrets.generated_secret_ids["auth-secret"]
    NESSIE_STORAGE_ACCESS_KEY_ID     = module.secrets.generated_secret_ids["storage-access-key-id"]
    NESSIE_STORAGE_SECRET_ACCESS_KEY = module.secrets.generated_secret_ids["storage-secret-access-key"]
  }

  operator_secret_env = {
    for name in var.injected_secret_env :
    name => module.secrets.managed_secret_ids[name]
  }

  secret_env = merge(local.generated_secret_env, local.operator_secret_env)

  gateway_secret_env = {
    for name in var.injected_gateway_secret_env :
    name => module.secrets.gateway_secret_ids[name]
  }

  # Per-secret accessor bindings, one list per service account. A project-wide
  # secretAccessor grant would let the gateway read the database URL.
  backend_secret_ids = distinct(values(local.secret_env))

  gateway_secret_ids = distinct(values(local.gateway_secret_env))
}
