# Phase 2 GCP Deployment Spec

> Status: target-state design for Phase 2.

## 1) Objective

Deploy Nessie as a hosted multi-tenant beta on Google Cloud Platform. This spec covers the concrete deployment topology, infrastructure resources, adapter implementations, and migration path from local-first Phase 1 to hosted Phase 2.

Cross-links:

- [hosted-app-architecture.md](./hosted-app-architecture.md) section 7 (physical topology)
- [hosted-app-architecture.md](./hosted-app-architecture.md) section 3 (preferred stack)
- [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md) section 2.1 (hosted SaaS mode)

## 2) Core rules

- hosted deployment must not break the local-first path -- all adapters are config-selected,
- the core application code must remain provider-agnostic; GCP-specific code lives in adapter modules,
- infrastructure-as-code is mandatory -- no manual console-created resources in production,
- all services are stateless and horizontally scalable,
- Postgres (Cloud SQL) is the single source of truth,
- secrets and credentials must never be committed to the repository.

## 3) Service topology

### Cloud Run services

| Service | Source | Min Instances | Max Instances | Memory | CPU | Concurrency |
|---------|--------|---------------|---------------|--------|-----|-------------|
| `nessie-api` | `/api` | 1 | 10 | 512Mi | 1 | 80 |
| `nessie-worker` | `/worker` | 0 | 10 | 1Gi | 2 | 1 |
| `nessie-admin` | `/admin` (static) | 1 | 5 | 256Mi | 1 | 200 |

Rules:

- `nessie-api` serves HTTP REST, SSE streaming, and WebSocket connections,
- `nessie-worker` is triggered by Pub/Sub via Eventarc (push subscription),
- `nessie-admin` serves the static Vite build via a lightweight server or Cloud Run static hosting,
- all services use the same container base image (Node.js 22 Alpine),
- CPU is always allocated (not request-only) for `nessie-api` due to WebSocket keepalives.

### Supporting GCP resources

| Resource | Service | Purpose |
|----------|---------|---------|
| Cloud SQL PostgreSQL 16 | `nessie-db` | Primary data store, regional HA |
| Pub/Sub topic: `run.execute` | queue | Worker job delivery |
| Pub/Sub topic: `run.resume` | queue | Approval continuation |
| Pub/Sub topic: `approval.sweep` | cron | Periodic expiry check |
| Pub/Sub dead-letter topic | DLQ | Failed job capture |
| Eventarc trigger | `nessie-worker` | Pub/Sub -> Cloud Run routing |
| Cloud Storage bucket | `nessie-assets` | Uploads, artifacts, exports |
| Cloud KMS keyring | `nessie-keys` | Tenant secret encryption |
| Secret Manager | infrastructure | Runtime credentials (DB password, auth secret, API keys) |
| Cloud Load Balancer | ingress | HTTPS termination, routing |
| Identity Platform | auth | Hosted auth default (optional) |

## 4) Cloud SQL configuration

### Instance

- Engine: PostgreSQL 16
- Tier: `db-custom-2-4096` (2 vCPU, 4GB RAM) for beta, scale as needed
- High availability: regional (automatic failover)
- Storage: SSD, auto-resize enabled, 20GB initial
- Backup: automated daily with 7-day retention
- Maintenance window: Sunday 03:00 UTC

### Connectivity

- Private IP via VPC connector (Cloud Run -> Cloud SQL)
- IAM database authentication for service accounts (no password in connection string)
- Cloud SQL Auth Proxy sidecar not needed with direct VPC + IAM auth
- Connection pooling via PgBouncer or built-in connection limits

### Connection from application

```ts
// In packages/config, when mode === 'hosted'
{
  database: {
    host: '/cloudsql/PROJECT:REGION:INSTANCE', // Unix socket path
    database: 'nessie',
    user: 'nessie-api@PROJECT.iam',            // IAM auth
    ssl: false,                                 // Unix socket, no SSL needed
    pool: { min: 2, max: 10 }
  }
}
```

### Migration

- Prisma migrations run as a Cloud Build step before deployment,
- migration job uses a separate service account with schema-alter permissions,
- runtime service accounts have read/write but not DDL permissions.

## 5) Pub/Sub adapter implementation

The `QueueProvider` interface from [hosted-app-architecture.md](./hosted-app-architecture.md) section 4 needs a Pub/Sub adapter.

### Adapter: `PubSubQueueProvider`

Location: `packages/queue/src/pubsub.ts` (new package or in worker)

```ts
class PubSubQueueProvider implements QueueProvider {
  async enqueue(topic: string, payload: unknown, options?: { delayMs?: number; idempotencyKey?: string }): Promise<string>;
  subscribe(topic: string, handler: (job: QueueJob) => Promise<void>): void;
  async acknowledge(jobId: string): Promise<void>;
  async nack(jobId: string, reason?: string): Promise<void>;
}
```

Implementation rules:

- `enqueue()` publishes a message to the Pub/Sub topic with the payload as JSON,
- `subscribe()` in hosted mode is a no-op -- Eventarc push delivers messages to the Cloud Run HTTP endpoint,
- the worker exposes `POST /worker/jobs/:topic` which Eventarc pushes to,
- `acknowledge()` returns 200 to the Eventarc push (implicit),
- `nack()` returns 500 to trigger Pub/Sub retry,
- dead-letter topic captures messages after max delivery attempts (default: 5),
- ordering keys use `taskId` or `runId` when strict sequencing is required.

### Topic naming

| Logical topic | Pub/Sub topic name | Ordering key |
|---------------|-------------------|--------------|
| `run.execute` | `nessie-run-execute` | `runId` |
| `run.resume` | `nessie-run-resume` | `runId` |
| `approval.sweep` | `nessie-approval-sweep` | none |

### Eventarc triggers

Each Pub/Sub topic gets one Eventarc trigger pointing to `nessie-worker`:

```hcl
resource "google_eventarc_trigger" "run_execute" {
  name     = "nessie-run-execute-trigger"
  location = var.region

  matching_criteria {
    attribute = "type"
    value     = "google.cloud.pubsub.topic.v1.messagePublished"
  }

  transport {
    pubsub {
      topic = google_pubsub_topic.run_execute.id
    }
  }

  destination {
    cloud_run_service {
      service = google_cloud_run_v2_service.worker.name
      path    = "/worker/jobs/run.execute"
      region  = var.region
    }
  }
}
```

## 6) Cloud Storage adapter

### Adapter: `GcsStorageProvider`

Location: `packages/storage/src/gcs.ts` (new package or in API)

```ts
interface StorageProvider {
  upload(key: string, data: Buffer | Readable, contentType: string): Promise<string>;
  download(key: string): Promise<Buffer>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

class GcsStorageProvider implements StorageProvider {
  constructor(private bucket: string) {}
  // Implementation using @google-cloud/storage
}
```

### Bucket configuration

- Bucket name: `nessie-assets-{env}` (e.g. `nessie-assets-beta`)
- Location: same region as Cloud Run services
- Storage class: Standard
- Lifecycle: objects older than 90 days move to Nearline (configurable)
- CORS: allow `*.unlikeotherai.com` origins
- Public access: denied (all access via signed URLs)
- Uniform bucket-level access: enabled

### Key structure

```
uploads/{organizationId}/{year}/{month}/{filename}
artifacts/{organizationId}/{runId}/{filename}
exports/{organizationId}/{exportId}/{filename}
```

## 7) Cloud KMS

### Keyring and keys

- Keyring: `nessie-keys` in the same region
- Symmetric encryption key: `nessie-tenant-secrets` for tenant secret encryption
- Key rotation: automatic every 90 days
- Key purpose: `ENCRYPT_DECRYPT`

### Usage

- Tenant secrets (API keys, provider credentials) are envelope-encrypted:
  1. Generate a random DEK (data encryption key),
  2. Encrypt the secret with the DEK (AES-256-GCM),
  3. Encrypt the DEK with the KMS key,
  4. Store both encrypted DEK and ciphertext in Postgres.
- Phase 2 stores model provider API keys this way.
- Full secrets system (Phase 3) will expand this pattern.

## 8) Identity Platform (optional hosted auth)

Phase 2 can use Google Identity Platform as the hosted auth default, or continue with `authentication.unlikeotherai.com`.

If Identity Platform:

- configure as a tenant in the GCP project,
- enable email/password + Google OAuth,
- OIDC token exchange mapped to Nessie JWT claims,
- the auth abstraction treats it like any other OIDC provider.

The auth provider config in `packages/config` selects which path to use:

```ts
{
  auth: {
    mode: 'hosted',
    providers: [
      {
        providerId: 'uoa',
        type: 'uoa',
        label: 'Unlike Other AI',
        enabled: true,
        autoRedirect: true,
        issuerUrl: 'https://authentication.unlikeotherai.com',
        clientId: 'nessie-hosted',
        scopes: ['openid', 'profile', 'email']
      }
    ]
  }
}
```

## 9) Infrastructure-as-code

### Terraform structure

```
infrastructure/
  terraform/
    main.tf              # Provider config, backend
    variables.tf         # Input variables
    outputs.tf           # Service URLs, connection strings
    cloud-run.tf         # API, worker, admin services
    cloud-sql.tf         # PostgreSQL instance
    pubsub.tf            # Topics, subscriptions, DLQ
    eventarc.tf          # Triggers
    storage.tf           # GCS buckets
    kms.tf               # Keyring and keys
    iam.tf               # Service accounts and permissions
    networking.tf        # VPC connector, load balancer
    secrets.tf           # Secret Manager entries
    identity.tf          # Identity Platform (optional)
```

### Service accounts

| Account | Purpose | Roles |
|---------|---------|-------|
| `nessie-api@` | API service | Cloud SQL Client, Pub/Sub Publisher, Storage Object Viewer |
| `nessie-worker@` | Worker service | Cloud SQL Client, Pub/Sub Subscriber, Storage Object Admin |
| `nessie-migrate@` | DB migrations | Cloud SQL Admin (DDL permissions) |
| `nessie-deploy@` | CI/CD deployment | Cloud Run Admin, Artifact Registry Writer |

### CI/CD pipeline

```yaml
# Simplified Cloud Build steps
steps:
  - id: build-api
    name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '$_API_IMAGE', '-f', 'api/Dockerfile', '.']

  - id: build-worker
    name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '$_WORKER_IMAGE', '-f', 'worker/Dockerfile', '.']

  - id: build-admin
    name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '$_ADMIN_IMAGE', '-f', 'admin/Dockerfile', '.']

  - id: push-images
    # Push to Artifact Registry

  - id: migrate-db
    # Run Prisma migrations against Cloud SQL

  - id: deploy-api
    # gcloud run deploy nessie-api

  - id: deploy-worker
    # gcloud run deploy nessie-worker

  - id: deploy-admin
    # gcloud run deploy nessie-admin
```

## 10) Environment configuration

### Environment variables (via Secret Manager)

| Variable | Source | Description |
|----------|--------|-------------|
| `NESSIE_MODE` | config | `hosted` |
| `NESSIE_DB_CONNECTION` | Secret Manager | Cloud SQL connection string or Unix socket path |
| `NESSIE_AUTH_SECRET` | Secret Manager | JWT signing secret |
| `NESSIE_QUEUE_PROVIDER` | config | `pubsub` |
| `NESSIE_STORAGE_PROVIDER` | config | `gcs` |
| `NESSIE_STORAGE_BUCKET` | config | GCS bucket name |
| `NESSIE_KMS_KEY` | config | KMS key resource name |
| `NESSIE_PUBSUB_PROJECT` | config | GCP project ID for Pub/Sub |
| `NESSIE_MODEL_PROVIDER` | config | `openai` (or others) |
| `NESSIE_MODEL_API_KEY` | Secret Manager | Model provider API key |
| `NESSIE_LOG_LEVEL` | config | `info` |

### Config resolution order

1. Environment variables (highest priority)
2. Secret Manager references (mounted as env vars by Cloud Run)
3. Config file (`nessie.config.json` baked into container)
4. Defaults from `packages/config`

## 11) Dockerfiles

### API Dockerfile

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ packages/
COPY api/ api/
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @nessie/schemas build
RUN pnpm --filter @nessie/config build
RUN pnpm --filter @nessie/api build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/api/dist ./dist
COPY --from=builder /app/api/node_modules ./node_modules
COPY --from=builder /app/api/prisma ./prisma
COPY --from=builder /app/packages ./packages
EXPOSE 4317
CMD ["node", "dist/index.js"]
```

### Worker Dockerfile

Same pattern as API but for `/worker`.

### Admin Dockerfile

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ packages/
COPY admin/ admin/
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @nessie/admin build

FROM nginx:alpine
COPY --from=builder /app/admin/dist /usr/share/nginx/html
COPY admin/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

## 12) Networking

### Load balancer

- Google Cloud HTTPS Load Balancer
- SSL certificate: managed by Google Certificate Manager for `*.unlikeotherai.com`
- Backend services:
  - `/api/*` -> `nessie-api` Cloud Run
  - `/admin/*` -> `nessie-admin` Cloud Run (static)
  - `/` -> `nessie-admin` Cloud Run (redirect)

### VPC connector

- Serverless VPC Access connector for Cloud Run -> Cloud SQL private IP
- Connector in the same region as Cloud SQL
- `e2-micro` instances, min 2, max 3

### WebSocket support

- Cloud Run supports WebSocket natively
- Session affinity: not required (WebSocket state is not in memory)
- Timeout: 3600s for WebSocket connections (Cloud Run max)

## 13) Observability

### Logging

- Structured JSON logging to stdout (picked up by Cloud Logging automatically)
- Log fields: `severity`, `message`, `requestId`, `organizationId`, `service`
- Error logs include stack traces

### Monitoring

- Cloud Monitoring dashboards for:
  - API latency (p50, p95, p99)
  - Worker job processing time
  - Queue depth (pending messages per topic)
  - Database connections and query latency
  - Error rates by service

### Alerting

- Error rate > 5% sustained for 5 minutes
- API p99 latency > 5s
- Queue depth > 100 pending messages
- Cloud SQL connection count > 80% of max
- Worker job failure rate > 10%

### Tracing

- OpenTelemetry integration for distributed tracing
- `requestId` propagated across API -> queue -> worker

## 14) Migration path from Phase 1

### What changes for existing local installs

Nothing. Local installs continue to use:

- pgqueue (Postgres-backed queue)
- filesystem storage
- local auth (bootstrap + optional OIDC)
- same config, same CLI launcher

### What's new for hosted

- Pub/Sub queue adapter replaces pgqueue
- GCS storage adapter replaces filesystem
- Cloud SQL replaces local Postgres
- Cloud KMS replaces local secret encryption (Phase 3)
- Identity Platform or UOA replaces local-only auth
- Cloud Run replaces `nessie local up`

### Adapter selection

Config-driven, not code-branched:

```ts
// In packages/config
if (config.mode === 'hosted') {
  queueProvider = new PubSubQueueProvider(config.pubsub);
  storageProvider = new GcsStorageProvider(config.storage.bucket);
} else {
  queueProvider = new PgQueueProvider(config.database);
  storageProvider = new FilesystemStorageProvider(config.storage.path);
}
```

## 15) Cost estimate (beta)

Rough monthly cost for a small beta deployment:

| Resource | Estimated cost |
|----------|---------------|
| Cloud Run API (1 min instance) | $30-50 |
| Cloud Run Worker (0 min, event-driven) | $10-30 |
| Cloud SQL (db-custom-2-4096, HA) | $120-150 |
| Pub/Sub | $5-10 |
| Cloud Storage (10GB) | $1-5 |
| Cloud KMS | $1-5 |
| Load Balancer | $20-30 |
| **Total** | **~$200-280/month** |

## 16) Cross-links

- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md)
- [implementation-phases.md](./implementation-phases.md)
- [config-module-spec.md](./config-module-spec.md)
