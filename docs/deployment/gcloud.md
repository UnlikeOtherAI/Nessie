# Google Cloud: the Cloud Run topology, and how to stand it up

Chapter of [deployment.md](../deployment.md). The terraform tree, the environment each service gets, the migrate job every rollout gates on, and what about this path is still unproven.

## What is proven, and what is not

Read this section before anything else. Hetzner is production
([redeploying.md](redeploying.md) is the live runbook); this chapter describes
a path that has been written but not walked.

- **No live apply.** No Google Cloud project exists for this. Nothing in
  `infrastructure/terraform/` has been `plan`ned or `apply`ed against a real
  project, and terraform was not installed on the machine the tree was written
  on, so `terraform fmt -check` and `terraform validate` have not been run
  either. Run both, then `plan`, before believing any of it.
- **The storage interoperability path is untested against a real bucket.**
  Objects go to GCS through the existing S3-compatible backend
  (`packages/runtime/src/storage/s3.ts`) on GCS's interoperability endpoint.
  That backend uploads through `@aws-sdk/lib-storage`'s multipart `Upload`.
  Multipart on GCS's XML API is the specific thing to smoke-test first — a
  multi-GiB upload and a signed download — because if it does not work the
  answer is a streaming native GCS backend, not a configuration change.
- **The worker pool resource is unvalidated.**
  `google_cloud_run_v2_worker_pool` is used because it is the only Cloud Run
  primitive that accepts a container binding no port. Its schema has not been
  checked against a provider download. `terraform plan` will say.
- **The trusted proxy hop count is a placeholder.** It must be measured against
  the real load balancer — the procedure is below — not inherited from this
  file.

## Topology

| Component | Google Cloud | Why |
|---|---|---|
| API | Cloud Run service, gen2, CPU always allocated, min 1 instance, request timeout 3600 s | Holds a persistent Postgres `LISTEN` client and runs maintenance sweeps, so a throttled or scaled-to-zero instance stops delivering realtime events |
| Worker | Cloud Run **worker pool**: no ingress, no port, always-on CPU | Binds no port and polls `queue_jobs`; a Service would never become ready |
| Gateway | Cloud Run service, min 0 | Stateless push relay, no listener, no periodic work. Optional |
| Migrations | Cloud Run job on the same image, command override | Gates every rollout |
| Postgres | Cloud SQL for PostgreSQL 17, regional HA, private address only | pgvector on 17, matching production |
| Object storage | GCS bucket over the S3-interop endpoint | Reuses the streaming S3 backend |
| Queue and realtime | Postgres | Settled. No Pub/Sub, no Redis |
| Ingress | External HTTPS load balancer, Google-managed certificate | Stable address, operator's own domain, and it lets the service refuse its `run.app` URL |

Admin and web are **not** modelled here. The load balancer fronts the API only;
the static SPA images still deploy the Hetzner way. Serving them from Cloud
Storage or a second Cloud Run service behind the same load balancer is the
obvious next step and is deliberately not assumed.

## The tree

`infrastructure/terraform/`, one module per concern:

| Module | Holds |
|---|---|
| `network` | VPC, the subnet Cloud Run attaches to with direct VPC egress, the private services peering Cloud SQL's address comes from |
| `database` | Cloud SQL PostgreSQL 17, private IP, `max_connections`, backups, the generated application password |
| `storage` | GCS attachment bucket, its own service account, and the interoperability HMAC key |
| `secrets` | Secret Manager: four generated and populated, the rest created empty |
| `registry` | Artifact Registry, one Docker repository, cleanup policies |
| `iam` | One service account per job; the optional deploy identity and its GitHub OIDC federation (`deploy.tf`) |
| `service` | A reusable Cloud Run v2 service. Instantiated twice: API, gateway |
| `worker` | The Cloud Run worker pool |
| `job` | The migrate-and-reconcile job |
| `load-balancer` | Global address, serverless NEG, backend service, URL map, managed certificate, HTTP redirect |

The Pub/Sub and Redis modules from the retired tree are **deleted**, not
disabled. Postgres is the queue and the realtime bus by decision, and both
modules provisioned infrastructure nothing read.

### Inputs with no default

Nothing here can be guessed, so nothing here has a default:
`project_id`, `region`, `environment`, `api_hostname`, `admin_public_url`,
`cors_origins`, `ledger_public_url`, `uoa_base_url`, `app_image`,
`gateway_image`.

`terraform.tfvars.example` is a placeholder copy. `terraform.tfvars` is
git-ignored; it names the project, the region and the deployment's domains, and
must not be committed.

### Defaults worth knowing

| Variable | Default | Why that value |
|---|---|---|
| `db_tier` | `db-custom-2-7680` | Smallest custom shape that carries `db_max_connections` plus a pgvector index build without swapping |
| `db_max_connections` | `200` | One API replica opens `2 * poolMax + 1` connections — 21 at the default. 200 carries 6 API replicas, 4 workers, the job and operator sessions |
| `db_pool_max` / `db_pool_min` | `10` / `2` | The application defaults. Lower `poolMax` *before* adding replicas |
| `api_max_instances` | `6` | Bounded by `db_max_connections`, not by traffic |
| `api_request_timeout_seconds` | `3600` | Cloud Run's maximum; a streaming agent run needs it, and the load balancer backend timeout is set to match |
| `shutdown_timeout_ms` | `9000` | Cloud Run **services** SIGKILL 10 s after SIGTERM and that grace is not configurable, so the application default of 25000 would be cut off mid-drain |
| `trusted_proxy_hops` | `1` | Errs low deliberately — see below |
| `storage_versioning` | `true` | An agent deleting the wrong key is recoverable; versioned attachment storage is cheap next to the database |
| `api_min_instances` | `1` | Never 0. The `LISTEN` client and the sweeps live in the API process |

### Measuring the trusted proxy hop count

`NESSIE_API_TRUSTED_PROXY_HOPS` is the single trust decision behind every
rate-limit client-IP key and every `request.ip`. Too low and every client shares
the load balancer's bucket (degraded); too high and a client can forge its own
address (exploitable). The default of 1 is the fail-safe direction, not a
measurement.

Measure it once the load balancer serves:

1. From a machine outside Google Cloud, request an endpoint that echoes what the
   server believes, and read the `X-Forwarded-For` header the container
   receives from the Cloud Run request log.
2. Count the addresses appended *after* your own client address. That count is
   the hop value.
3. Set `trusted_proxy_hops`, apply, and confirm `/api/ops/health`'s rate-limiter
   counters key on distinct client addresses rather than one.

## The environment each service gets

Derived from `packages/config/src/index.ts` — `ConfigEnvMap` plus the handful
the API reads through `process.env` directly — not from the retired tree. The
audit recorded four the API refuses to start, or silently misbehaves, without;
all four are here.

### Shared by the API, the worker and the migrate job

| Variable | Source | Note |
|---|---|---|
| `NODE_ENV` | plain | `production` |
| `NESSIE_MODE` | plain | `selfHosted`. `local` is rejected by variable validation |
| `NESSIE_CONFIG_PATH` | plain | `/app/infrastructure/compose/nessie.config.json`. **Required for SSO**: `auth.providers` has no environment mapping, and the file ships inside the image because `.dockerignore` does not exclude `infrastructure/` |
| `NESSIE_API_PUBLIC_URL` | plain | Derived from `api_hostname`. The API throws at request time without it outside `local` mode |
| `NESSIE_ADMIN_PUBLIC_URL` | plain | MCP and comms OAuth callbacks mint redirect URIs from it |
| `NESSIE_SHUTDOWN_TIMEOUT_MS` | plain | Must stay inside the platform's grace |
| `NESSIE_DB_POOL_MAX` / `_MIN` | plain | Per-process pool bounds |
| `NESSIE_STORAGE_PROVIDER` | plain | `s3` |
| `NESSIE_STORAGE_ENDPOINT` | plain | GCS interoperability endpoint |
| `NESSIE_STORAGE_REGION` | plain | The bucket's region |
| `NESSIE_STORAGE_FORCE_PATH_STYLE` | plain | `true`; the XML API is path-style |
| `NESSIE_STORAGE_BUCKET` | plain | From the storage module |
| `NESSIE_MAX_UPLOAD_BYTES` | plain | Also pins the API multipart limit |
| `NESSIE_MODEL_PROVIDER` / `_BASE_URL` / `_SERVICE_ID` / `_NAME` | plain | Ledger routing; `_BASE_URL` is derived as `<ledger_public_url>/v1/openai` |
| `NESSIE_EMBEDDING_PROVIDER` / `_SERVICE_ID` / `_MODEL` | plain | Embeddings do not follow chat. Without these, memory recall and `kb_search` degrade to lexical-only |
| `NESSIE_LEDGER_IMAGE_PURPOSE_API_ID` | plain | Optional; empty is stripped |
| `NESSIE_LEDGER_SEARCH_PURPOSE_API_ID` | plain | Optional; empty is stripped |
| `LEDGER_PUBLIC_URL` | plain | |
| `UOA_BASE_URL` | plain | |
| `INFISICAL_API_URL` / `_PROJECT_ID` / `_ENVIRONMENT` | plain | Optional |
| `NESSIE_TEAM_HOST_BASE_DOMAIN` | plain | Optional; see the certificate constraint below |
| `DATABASE_URL` | **secret** | Generated. Same secret as `NESSIE_DB_URL` |
| `NESSIE_DB_URL` | **secret** | Generated |
| `NESSIE_AUTH_SECRET` | **secret** | Generated. Hard startup failure in `hosted`/`selfHosted`; must be stable across replicas and deploys or every session dies on every revision |
| `NESSIE_STORAGE_ACCESS_KEY_ID` | **secret** | Generated HMAC key |
| `NESSIE_STORAGE_SECRET_ACCESS_KEY` | **secret** | Generated HMAC key |
| `NESSIE_MODEL_API_KEY` | **secret** | Operator-populated |
| `LEDGER_PROXY_TOKEN` | **secret** | Operator-populated |
| `DEEPSIGNAL_MCP_APP_KEY` | **secret** | Operator-populated |
| `UOA_BILLING_APP_KEY_NESSIE` | **secret** | Operator-populated |
| `UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE` | **secret** | Operator-populated |
| `UOA_CLIENT_SECRET` | **secret** | Operator-populated |
| `INFISICAL_SERVICE_TOKEN` | **secret** | Operator-populated |
| `NESSIE_WEBPUSH_PRIVATE_KEY` | **secret** | Operator-populated |
| `NESSIE_GITHUB_TOKEN` | **secret** | Operator-populated |

Anything else — board-source OAuth clients, comms clients, Jitsi, run backstop
caps — goes in `extra_env` (plain) or `managed_secret_env` plus
`injected_secret_env` (secret) without editing a module. The full catalogue is
in [configuration.md](configuration.md).

### API only

| Variable | Source | Note |
|---|---|---|
| `NESSIE_API_HOST` | plain | `0.0.0.0` |
| `NESSIE_CORS_ORIGINS` | plain | From `cors_origins` |
| `NESSIE_API_TRUSTED_PROXY_HOPS` | plain | Measure it |
| `PORT` | injected by Cloud Run | `NESSIE_API_PORT` is deliberately **not** set: `packages/config` accepts `PORT` as a lower-precedence fallback, which is exactly this case |

### Worker

The shared set, and nothing else. No CORS allowlist and no proxy trust — it
takes no ingress. It does keep `NESSIE_API_PUBLIC_URL`, because the personal
assistant's `connector_authorize` flow mints OAuth redirect URIs outside any
HTTP request.

### Migrate job

The API's environment, plus `NESSIE_MIGRATE_RESOLVE_ROLLED_BACK` (empty by
default). Giving the job the API's full environment is deliberate: a missing
variable then fails a deploy at the gate, which is the cheapest place for it to
fail.

### Gateway

| Variable | Source | Note |
|---|---|---|
| `NODE_ENV`, `GATEWAY_HOST` | plain | |
| `NESSIE_SHUTDOWN_TIMEOUT_MS` | plain | |
| `PORT` | injected by Cloud Run | `GATEWAY_PORT` is unset so the fallback applies |
| `GATEWAY_API_KEY` | **secret** | Required; the gateway refuses to start without it |
| `PUSH_APNS_P8` | **secret** | Optional |
| `PUSH_FCM_SERVICE_ACCOUNT` | **secret** | Optional |
| `PUSH_APNS_KEY_ID`, `_TEAM_ID`, `_TOPIC`, `_ENV` | plain, via `gateway_extra_env` | APNs is all-or-nothing: a partial set is a startup error |

The gateway's service account can read the gateway secrets and nothing else. It
cannot read the database URL.

## First apply

Secrets are a two-step, and the order matters: a Cloud Run revision that
references a Secret Manager secret with **no version** never becomes ready.

1. **State bucket.** Create a private, versioned GCS bucket for terraform state
   by hand — it holds the generated database password, the auth secret and the
   HMAC key material.

   ```sh
   cd infrastructure/terraform
   terraform init -backend-config="bucket=<state-bucket>"
   ```

2. **`terraform.tfvars`.** Copy `terraform.tfvars.example` and fill in the
   required inputs. For the first apply, point `app_image` and `gateway_image`
   at any image that exists; the deploy workflow owns the tag from then on and
   terraform ignores image drift after create.

3. **First apply.** `terraform apply`. This creates everything, including empty
   Secret Manager containers. The API revision comes up with only the generated
   secrets wired.

4. **Populate the operator secrets.** `terraform output secrets_needing_versions`
   lists every container. For each one you actually use:

   ```sh
   printf '%s' "$VALUE" | gcloud secrets versions add <secret-id> --data-file=-
   ```

5. **Wire them.** Add their environment-variable names to `injected_secret_env`
   (and `injected_gateway_secret_env`) and apply again.

6. **DNS.** Point `api_hostname` at `terraform output api_load_balancer_ip`.
   The Google-managed certificate stays `PROVISIONING` until that resolves:

   ```sh
   gcloud compute ssl-certificates describe "$(terraform output -raw api_certificate_name)" --global
   ```

7. **Bootstrap the first owner.** The one-time owner bootstrap token is a
   Postgres row, so read it from the API's Cloud Run logs and open
   `<admin_public_url>/bootstrap?token=<token>`, exactly as on Hetzner
   ([first-deploy.md](first-deploy.md)).

8. **Smoke-test storage before trusting it.** Upload a multi-GiB file through
   the API and download it again. This is the untested part of the whole path.

The database extensions (`vector`, `pg_trgm`, `pgcrypto`) are created by the
migrations themselves, so the migrating role must be able to create them; the
Cloud SQL application user this tree creates is a member of
`cloudsqlsuperuser`, which can.

## The migrate job, and escaping a stuck migration

`infrastructure/gcloud/migrate-entrypoint.sh` runs on the same `nessie-app`
image as a command override and does, in order: the parked-migration repair,
`prisma migrate deploy`, the App Store catalogue seeds, then
`pnpm --filter @nessie/api reconcile`.

The reconcile step is not optional. Boot connects and listens and nothing else
([standards/horizontal-scaling.md](../standards/horizontal-scaling.md)
invariant 5), so default policy rules, the protected-MCP grant backfill,
Personal Assistant default grants and the expired-credential sweep happen here
or nowhere. An upgrade applied by hand must run it too.

**The deploy gates on this job.** The workflow runs
`gcloud run jobs execute --wait` before any revision is deployed, and `--wait`
makes the job's exit code the step's exit code, so a failed migration stops the
workflow with the previous revision still serving.

### When a migration parks the deployment

`prisma migrate deploy` stops at the first failed migration and refuses every
later one with **P3009**, so one migration that died mid-deploy takes the whole
installation out of service until somebody clears it — production spent a day
rejecting every deploy this way. The background, and the rule for when
`--rolled-back` is the truthful answer, is in
[upgrade-paths.md](upgrade-paths.md).

The entrypoint carries the same `RESOLVABLE_FAILED_MIGRATIONS` list
`redeploy.sh` does, and adds an escape hatch the Hetzner path does not have. On
the host, clearing a *newly* parked migration meant editing the script,
committing and waiting for a build. Here it is one execution override:

```sh
gcloud run jobs execute <prefix>-migrate \
  --region <region> --wait \
  --update-env-vars NESSIE_MIGRATE_RESOLVE_ROLLED_BACK=<migration_name>
```

It applies to that execution only; the next deploy runs without it. Comma-
separate several. Confirm the rollback before using it — none of the objects the
migration creates should exist, and anything it alters should still be in its
original shape. A migration that half-applied is not a candidate.

## The deploy workflow

`.github/workflows/deploy-gcloud.yml`. It has **no push trigger**: it runs only
from `workflow_dispatch`, and its `preflight` job refuses to continue unless
`GCLOUD_DEPLOY_ENABLED` is `true` and every other repository variable is set.
Add the push trigger at cutover, and retire `deploy.yml` in the same change —
never run both against the same DNS name.

Repository variables (none is a credential; authentication is Workload Identity
Federation, so no service-account key is stored):

| Variable | From |
|---|---|
| `GCLOUD_DEPLOY_ENABLED` | Set to `true` to arm the workflow |
| `GCLOUD_PROJECT_ID`, `GCLOUD_REGION` | Your tfvars |
| `GCLOUD_WORKLOAD_IDENTITY_PROVIDER` | `terraform output workload_identity_provider` |
| `GCLOUD_DEPLOY_SERVICE_ACCOUNT` | `terraform output deploy_service_account_email` |
| `GCLOUD_ARTIFACT_REPOSITORY` | The repository id, e.g. `nessie-staging` |
| `GCLOUD_SERVICE_PREFIX` | The name prefix, e.g. `nessie-staging` |
| `GCLOUD_API_HOSTNAME` | The public API hostname |
| `GCLOUD_GATEWAY_ENABLED` | `true` to build and deploy the push relay |

The last two outputs are empty unless `github_repository` is set in tfvars; that
is what provisions the deploy identity and the OIDC federation.

Its shape: build and push to Artifact Registry → run the migrate job on the new
image → deploy the API revision with `--no-traffic` → deploy the worker pool →
shift traffic → verify the public endpoints → roll back on failure.

`--no-traffic` still waits for the revision to become Ready, and Ready for the
API means its startup probe passed, which is `/api/health/ready` — a real
`SELECT 1` against Cloud SQL over the VPC. A revision that cannot reach the
database therefore never reaches the traffic shift.

The public-endpoint gate runs **after** the shift, not before, and this is a
real limitation rather than an oversight: the API takes
`INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, so a tagged candidate revision has no
externally reachable address and the load balancer routes by traffic split.
Gating a candidate through the public name would mean adding a host rule for the
revision tag to the URL map. Until that exists the order is: prove Ready, shift,
prove the public path, roll back if it does not answer.

Rollback returns traffic to the revision that was serving when the run started —
recorded before anything changed, so re-running a failed deploy cannot roll back
onto the revision the failed run created. **The database is not rolled back.**
Migrations are forward-only; reverting past a schema change is a deliberate
down-migration, not a traffic shift.

## Constraints and known gaps

- **Per-organisation team hostnames need Certificate Manager.** The load
  balancer uses a classic Google-managed certificate, which does not do
  wildcards. Turning on `team_host_base_domain`
  ([standards/team-hosts.md](../standards/team-hosts.md)) means moving to
  Certificate Manager with DNS authorisation. Recorded, not built.
- **No managed connection pooling.** The API keeps a dedicated Postgres
  `LISTEN` client and a transaction-mode pooler in front of it breaks `LISTEN`
  silently. Sizing is done with `max_connections` and `NESSIE_DB_POOL_MAX`
  instead. Adding a pooler later has to route the listener around it.
- **Cloud Run services SIGKILL 10 s after SIGTERM.** That is why
  `shutdown_timeout_ms` defaults to 9000 rather than the application's 25000,
  and why the worker is a worker pool: its sixty-second checkpoint budget does
  not fit in a Service's grace.
- **Admin and web are not modelled.** The load balancer fronts the API only.
- **Infisical is not moved.** It stays where it is; it is reachable over the
  public internet and its token is an environment variable
  ([why-these-choices.md](why-these-choices.md)).

## Cutover

The order is in
[plans/2026-09-05-horizontal-scaling-statelessness/overview.md](../plans/2026-09-05-horizontal-scaling-statelessness/overview.md):
soak two replicas on Hetzner, stand up a staging Google Cloud project from this
tree, copy MinIO to GCS with `rclone` (keys are stable, so attachments need no
rewrite), migrate Postgres with Database Migration Service in continuous mode
with `CREATE EXTENSION vector` verified on the target first, then switch DNS and
keep Hetzner warm for a rollback window.
