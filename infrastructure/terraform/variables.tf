# Inputs.
#
# Rule for this file: anything that names a project, a region, a domain or a
# credential has NO default. Nobody has told this tree what project or region
# it runs in, and a guessed value that happens to be syntactically valid is
# worse than a missing one — it applies. Everything with a genuinely safe
# value (instance shapes, retention, concurrency) has a default and a comment
# saying why that number.

# ---------------------------------------------------------------------------
# Identity of the deployment. No defaults.
# ---------------------------------------------------------------------------

variable "project_id" {
  description = "GCP project id that owns every resource in this tree."
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run, Cloud SQL, the GCS bucket and Artifact Registry. Must be a region where Cloud Run worker pools are available; see docs/deployment/gcloud.md."
  type        = string
}

variable "environment" {
  description = "Deployment environment. Part of every resource name, so one project can hold staging and prod side by side."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "api_hostname" {
  description = "Public DNS name the external HTTPS load balancer serves the API on, e.g. api.example.com. NESSIE_API_PUBLIC_URL is derived from it."
  type        = string
}

variable "admin_public_url" {
  description = "Public origin of the admin SPA, e.g. https://app.example.com. Becomes NESSIE_ADMIN_PUBLIC_URL, which the MCP and comms OAuth callbacks mint redirect URIs from."
  type        = string
}

variable "cors_origins" {
  description = "Browser origins allowed to call the API. Becomes NESSIE_CORS_ORIGINS. Must include admin_public_url; a selfHosted deployment with an empty allowlist serves no browser."
  type        = list(string)

  validation {
    condition     = length(var.cors_origins) > 0
    error_message = "cors_origins must list at least the admin origin."
  }
}

variable "ledger_public_url" {
  description = "Base URL of the Ledger inference proxy, e.g. https://ledger.example.com. Becomes LEDGER_PUBLIC_URL, and NESSIE_MODEL_BASE_URL is derived as <ledger_public_url>/v1/openai."
  type        = string
}

variable "uoa_base_url" {
  description = "Base URL of the UnlikeOtherAuthenticator instance that owns identity for this deployment, e.g. https://authentication.example.com. Becomes UOA_BASE_URL."
  type        = string
}

variable "app_image" {
  description = "Fully qualified image reference for the single nessie-app image that serves the API, the worker and the migrate job. The deploy workflow rolls new revisions itself; terraform ignores image drift after create."
  type        = string
}

variable "gateway_image" {
  description = "Fully qualified image reference for the push-relay gateway image."
  type        = string
}

# ---------------------------------------------------------------------------
# Optional integrations. Empty string means "not configured", which is a real
# state for every one of these — it is not a stand-in for a value nobody has
# supplied yet.
# ---------------------------------------------------------------------------

variable "team_host_base_domain" {
  description = "Base domain for per-team hostnames (<team>.<org>.<base>). Empty leaves hostname routing off, which is every install that has not opted in. Turning it on needs Certificate Manager with DNS authorisation, not the classic managed certificate this tree provisions — see docs/deployment/gcloud.md."
  type        = string
  default     = ""
}

variable "infisical_api_url" {
  description = "Infisical instance the MCP secret store reads from. Empty disables it and the API answers 503 on secret-backed routes."
  type        = string
  default     = ""
}

variable "infisical_project_id" {
  description = "Infisical project id for the MCP secret store."
  type        = string
  default     = ""
}

variable "infisical_environment" {
  description = "Infisical environment slug for the MCP secret store."
  type        = string
  default     = ""
}

variable "ledger_image_purpose_api_id" {
  description = "Ledger Purpose API id that agent-avatar image generation routes through. Empty keeps the direct /v1/openai/images/generations route."
  type        = string
  default     = ""
}

variable "ledger_search_purpose_api_id" {
  description = "Ledger Purpose API id that builtin web_search routes through. Empty keeps the single-provider Serper route."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Model and embedding routing. Defaults mirror the values
# infrastructure/compose/docker-compose.prod.yml documents for production;
# they name Ledger service segments and model ids, not credentials.
# ---------------------------------------------------------------------------

variable "model_provider" {
  description = "NESSIE_MODEL_PROVIDER. `openai` selects the OpenAI-compatible connector, which is what Ledger speaks regardless of the upstream vendor."
  type        = string
  default     = "openai"
}

variable "model_service_id" {
  description = "NESSIE_MODEL_SERVICE_ID: the /v1/:serviceId segment Ledger routes chat on. Production uses `openrouter` because Ledger's native `meta` service stops at muse-spark 1.2."
  type        = string
  default     = "openrouter"
}

variable "model_name" {
  description = "NESSIE_MODEL_NAME. The production default; the `-contributor` tier is ~12x cheaper in and ~21x cheaper out, and its data is training-eligible upstream — a deliberate choice, not one to inherit silently."
  type        = string
  default     = "meta/muse-spark-1.3-contributor"
}

variable "embedding_provider" {
  description = "NESSIE_EMBEDDING_PROVIDER. Embeddings do not follow chat: Ledger answers `403 embeddings is not allowed for deepseek`, so the destination is named separately."
  type        = string
  default     = "openai-compatible"
}

variable "embedding_service_id" {
  description = "NESSIE_EMBEDDING_SERVICE_ID: the Ledger /v1/:serviceId segment embeddings are rewritten to. Without it the segment defaults to the provider name, which is meaningless for `openai-compatible`."
  type        = string
  default     = "jina"
}

variable "embedding_model" {
  description = "NESSIE_EMBEDDING_MODEL. Changing this is a schema change — the vector column width is fixed by migration."
  type        = string
  default     = "jina-embeddings-v3"
}

# ---------------------------------------------------------------------------
# Cloud SQL. Safe defaults with the arithmetic that produced them.
# ---------------------------------------------------------------------------

variable "db_tier" {
  description = "Cloud SQL machine type. 2 vCPU / 7.5 GiB is the smallest custom shape that carries db_max_connections plus a pgvector index build without swapping."
  type        = string
  default     = "db-custom-2-7680"
}

variable "db_availability_type" {
  description = "REGIONAL gives a synchronous standby in a second zone, which is the point of moving off the single Hetzner host. ZONAL is cheaper and appropriate for a staging project."
  type        = string
  default     = "REGIONAL"
}

variable "db_disk_size_gb" {
  description = "Initial data disk. Autoresize is on, so this is a floor, not a ceiling."
  type        = number
  default     = 100
}

variable "db_backup_retention_days" {
  description = "Automated backup retention. Two weeks covers a Monday-morning discovery of a Friday-evening mistake."
  type        = number
  default     = 14
}

variable "db_max_connections" {
  description = "Postgres max_connections. One API replica opens poolMax Prisma connections + poolMax on the shared pg.Pool + one dedicated LISTEN client, i.e. 2*poolMax+1 = 21 at the default. 200 carries 6 API replicas, 4 workers, the migrate job and operator sessions with headroom."
  type        = string
  default     = "200"
}

variable "db_pool_max" {
  description = "NESSIE_DB_POOL_MAX per process. Lower this before adding replicas, not after exhausting db_max_connections."
  type        = number
  default     = 10
}

variable "db_pool_min" {
  description = "NESSIE_DB_POOL_MIN per process."
  type        = number
  default     = 2
}

variable "db_deletion_protection" {
  description = "Refuse to destroy the instance. Off only for a scratch project you intend to tear down."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Cloud Run shapes.
# ---------------------------------------------------------------------------

variable "api_min_instances" {
  description = "Minimum API instances. Never 0: the API holds a Postgres LISTEN connection and runs maintenance sweeps, so a scaled-to-zero deployment stops delivering realtime events and stops sweeping."
  type        = number
  default     = 1
}

variable "api_max_instances" {
  description = "Maximum API instances. Bounded by db_max_connections through the 2*poolMax+1 arithmetic above, not by traffic."
  type        = number
  default     = 6
}

variable "api_concurrency" {
  description = "Requests per API instance. The API is I/O bound on Postgres and Ledger; Cloud Run's default of 80 is the right starting point and the number to lower if p99 latency tracks instance CPU."
  type        = number
  default     = 80
}

variable "api_cpu" {
  description = "vCPU per API instance."
  type        = string
  default     = "2"
}

variable "api_memory" {
  description = "Memory per API instance."
  type        = string
  default     = "4Gi"
}

variable "api_request_timeout_seconds" {
  description = "Cloud Run request timeout. 3600 is the maximum, and streaming agent responses need it — an SSE run that outlives the timeout is cut mid-stream."
  type        = number
  default     = 3600
}

variable "worker_instance_count" {
  description = "Worker pool instances. The worker polls Postgres for queued jobs; scale it on queue_jobs pending depth, which is an operator decision rather than an autoscaler signal today."
  type        = number
  default     = 1
}

variable "worker_cpu" {
  description = "vCPU per worker instance."
  type        = string
  default     = "2"
}

variable "worker_memory" {
  description = "Memory per worker instance."
  type        = string
  default     = "4Gi"
}

variable "gateway_min_instances" {
  description = "Minimum gateway instances. 0 is correct: the push relay is stateless, holds no listener and does no periodic work."
  type        = number
  default     = 0
}

variable "gateway_max_instances" {
  description = "Maximum gateway instances."
  type        = number
  default     = 4
}

variable "gateway_cpu" {
  description = "vCPU per gateway instance."
  type        = string
  default     = "1"
}

variable "gateway_memory" {
  description = "Memory per gateway instance."
  type        = string
  default     = "512Mi"
}

variable "gateway_enabled" {
  description = "Provision the push relay. It is optional in production today (compose keeps it behind a profile)."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Application behaviour that the platform constrains.
# ---------------------------------------------------------------------------

variable "trusted_proxy_hops" {
  description = "NESSIE_API_TRUSTED_PROXY_HOPS. MEASURE this against the real load balancer before trusting it — docs/deployment/gcloud.md has the procedure. The default errs low on purpose: too low collapses every client into the load balancer's rate-limit bucket (degraded), too high lets a client forge its own address (exploitable)."
  type        = number
  default     = 1
}

variable "shutdown_timeout_ms" {
  description = "NESSIE_SHUTDOWN_TIMEOUT_MS. Cloud Run *services* SIGKILL 10 seconds after SIGTERM and that grace is not configurable, so the app default of 25000 would be cut off mid-drain. 9000 finishes inside the grace. The worker runs as a worker pool precisely because its checkpoint budget does not fit in 10 seconds."
  type        = number
  default     = 9000
}

variable "worker_drain_timeout_ms" {
  type        = number
  default     = 25000
  description = "NESSIE_WORKER_DRAIN_TIMEOUT_MS. The worker reads this straight from the environment (worker/src/lifecycle.ts), NOT through @nessie/config, and it does not read NESSIE_SHUTDOWN_TIMEOUT_MS at all — so that variable is the API's budget and tuning it does nothing to the worker. Set explicitly here so the knob an operator reaches for is the one that works. The default matches the application default; note the worker's whole budget is this plus a 5 s abandon-settle plus a 10 s teardown, so 40 s in total, against a Cloud Run grace of 10 s that no workload type lets you raise. That mismatch is plan row 4.9 and is not resolved by this variable."
}

variable "max_upload_bytes" {
  description = "NESSIE_MAX_UPLOAD_BYTES; also pins the API multipart limit. 5 GiB, matching production."
  type        = number
  default     = 5368709120
}

variable "nessie_mode" {
  description = "NESSIE_MODE. `selfHosted` disables dev login and requires the CORS allowlist. `local` is not a deployable mode here — the filesystem storage and docker execution providers are only permitted in it."
  type        = string
  default     = "selfHosted"

  validation {
    condition     = contains(["hosted", "selfHosted"], var.nessie_mode)
    error_message = "nessie_mode must be hosted or selfHosted; local is a developer mode and is not deployable on Cloud Run."
  }
}

variable "config_path" {
  description = "NESSIE_CONFIG_PATH. The image is built with `COPY . .` and .dockerignore does not exclude infrastructure/, so the compose config file ships inside the image at this path and needs no mount. auth.providers has no environment mapping, so without this SSO is off."
  type        = string
  default     = "/app/infrastructure/compose/nessie.config.json"
}

# ---------------------------------------------------------------------------
# Object storage. GCS reached through the existing S3-compatible client on
# GCS's interoperability endpoint; the native GCS backend is buffer-only and
# is not a production path.
# ---------------------------------------------------------------------------

variable "storage_endpoint" {
  description = "S3-compatible endpoint. GCS's interoperability endpoint. Left as a variable so a smoke test can point the same services at MinIO."
  type        = string
  default     = "https://storage.googleapis.com"
}

variable "storage_force_path_style" {
  description = "NESSIE_STORAGE_FORCE_PATH_STYLE. GCS's XML API serves storage.googleapis.com/<bucket>/<object>, so path style is required."
  type        = bool
  default     = true
}

variable "storage_versioning" {
  description = "Object versioning on the attachment bucket. On, because an agent deleting the wrong key is recoverable and the storage cost of a versioned attachment store is small next to the database."
  type        = bool
  default     = true
}

variable "storage_soft_delete_retention_days" {
  description = "Days a deleted or overwritten object stays recoverable."
  type        = number
  default     = 14
}

# ---------------------------------------------------------------------------
# Networking.
# ---------------------------------------------------------------------------

variable "subnet_cidr" {
  description = "Primary range of the subnet Cloud Run attaches to with direct VPC egress. A /24 carries the instance counts above with room to grow; direct VPC egress consumes an address per instance."
  type        = string
  default     = "10.60.0.0/24"
}

variable "private_service_access_prefix_length" {
  description = "Size of the range reserved for the Cloud SQL private services connection. /20 is Google's recommended minimum for a peering that may later hold read replicas."
  type        = number
  default     = 20
}

# ---------------------------------------------------------------------------
# Secrets. Terraform creates and populates the five it generates; it creates
# the containers for the rest and injects only the ones the operator says are
# populated. A Cloud Run revision that references a secret with no version
# never becomes ready, which is why this is two variables and not one.
# ---------------------------------------------------------------------------

variable "managed_secret_env" {
  description = "Secret Manager containers to create, keyed by the environment variable each one feeds. Terraform creates the container; the operator adds the version out of band. Values are secret name suffixes, never secret values."
  type        = map(string)

  default = {
    NESSIE_MODEL_API_KEY                 = "model-api-key"
    LEDGER_PROXY_TOKEN                   = "ledger-proxy-token"
    DEEPSIGNAL_MCP_APP_KEY               = "deepsignal-mcp-app-key"
    UOA_BILLING_APP_KEY_NESSIE           = "uoa-billing-app-key"
    UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE = "uoa-billing-actor-private-jwk"
    UOA_CLIENT_SECRET                    = "uoa-client-secret"
    INFISICAL_SERVICE_TOKEN              = "infisical-service-token"
    NESSIE_WEBPUSH_PRIVATE_KEY           = "webpush-private-key"
    NESSIE_GITHUB_TOKEN                  = "github-token"
  }
}

variable "injected_secret_env" {
  description = "Which of managed_secret_env to actually wire into the API, worker and migrate job. Start empty, apply, populate the versions, then list them here and apply again. Listing a name whose secret has no version parks every revision."
  type        = list(string)
  default     = []
}

variable "gateway_secret_env" {
  description = "Secret Manager containers for the push relay, keyed by environment variable. GATEWAY_API_KEY is required for the gateway to boot at all."
  type        = map(string)

  default = {
    GATEWAY_API_KEY          = "gateway-api-key"
    PUSH_APNS_P8             = "push-apns-p8"
    PUSH_FCM_SERVICE_ACCOUNT = "push-fcm-service-account"
  }
}

variable "gateway_extra_env" {
  description = "Plain environment for the push relay. The APNs key id, team id, topic and environment go here; only the .p8 itself and the FCM service-account JSON are credentials. APNs configuration is all-or-nothing — the gateway refuses to start with a partial set."
  type        = map(string)
  default     = {}
}

variable "injected_gateway_secret_env" {
  description = "Which of gateway_secret_env to wire into the gateway service. Same two-step as injected_secret_env."
  type        = list(string)
  default     = []
}

variable "github_repository" {
  description = "owner/repo that .github/workflows/deploy-gcloud.yml runs from, e.g. ExampleOrg/example. Provisions the deploy service account and the GitHub OIDC federation that lets it be impersonated with no exported key. Empty provisions neither."
  type        = string
  default     = ""
}

variable "extra_env" {
  description = "Additional plain environment variables for the API, worker and migrate job. The escape hatch for the long tail of optional integrations (board sources, comms OAuth client ids, run backstop caps) without editing a module."
  type        = map(string)
  default     = {}
}
