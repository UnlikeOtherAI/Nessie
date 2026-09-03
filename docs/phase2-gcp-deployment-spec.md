# Phase 2 GCP Deployment Specification

> Status: target-state design.

## 1) Objective

Define the concrete Google Cloud Platform deployment plan for Nessie Phase 2 (Multi-User Hosted Beta). This spec maps every logical component from [hosted-app-architecture.md](./hosted-app-architecture.md) to a physical GCP resource, with exact configurations, service accounts, networking, and cost estimates.

Phase 2 turns the local-first MVP into a real hosted beta for teams. The deployment must support:

- multi-user organizations with project/team/channel separation,
- hosted auth via Identity Platform,
- async agent execution via Pub/Sub-triggered workers,
- blob storage for uploads and artifacts,
- envelope encryption for tenant secrets,
- observability from day one.

## 2) Cloud Run service topology

| Service | Image | Min/Max instances | CPU / Memory | Trigger | Notes |
|---|---|---|---|---|---|
| `nessie-api` | `nessie-api` | 1 / 10 | 2 vCPU / 1 GiB | Cloud Load Balancer | HTTP API, SSE streaming, WebSocket activity |
| `nessie-worker` | `nessie-worker` | 0 / 5 | 2 vCPU / 2 GiB | Eventarc (Pub/Sub push) | Agent execution, model calls, tool runs |
| `nessie-realtime` | -- | -- | -- | -- | Not separate in Phase 2; SSE and WebSocket served from `nessie-api` |
| `nessie-runner` | -- | -- | -- | -- | Phase 4 only; not deployed in Phase 2 |

Configuration notes:

- `nessie-api` keeps min 1 to avoid cold-start latency on the primary HTTP surface.
- `nessie-worker` scales to zero when idle. Eventarc push subscriptions wake instances on message delivery.
- Both services use `--cpu-boost` for faster cold starts.
- Concurrency: `nessie-api` max 80 concurrent requests per instance, `nessie-worker` max 1 (one job per instance for isolation).
- Request timeout: `nessie-api` 300s (SSE streams), `nessie-worker` 900s (long agent runs).
- Both services connect to Cloud SQL and Redis via VPC connector (section 13).

## 3) Cloud SQL configuration

- **Engine**: PostgreSQL 16
- **Machine type**: `db-custom-2-4096` (2 vCPU, 4 GB RAM)
- **High availability**: Regional HA (automatic failover)
- **Storage**: SSD, 20 GB initial, auto-resize enabled
- **Connection method**: Cloud SQL Node.js connector (`@google-cloud/cloud-sql-connector`)
  - The connector handles IAM authentication, TLS termination, and connection pooling.
  - Do NOT use Unix socket or Cloud SQL Auth Proxy sidecar.
- **Database authentication**: IAM database authentication (no password-based DB auth)
  - Each service account is granted the `cloudsql.instanceUser` role and a corresponding PostgreSQL IAM user.
- **Backups**: Automated daily backups, 7-day retention, point-in-time recovery enabled
- **Private IP**: Accessible only via VPC connector (no public IP)
- **Maintenance window**: Sunday 03:00 UTC
- **Flags**: `log_min_duration_statement=1000` (log slow queries > 1s)

Connection example:

```ts
import { Connector } from '@google-cloud/cloud-sql-connector';

const connector = new Connector();
const clientOpts = await connector.getOptions({
  instanceConnectionName: 'project:region:nessie-db',
  ipType: 'PRIVATE',
  authType: 'IAM',
});
```

Prisma connects via the connector-provided socket. The `DATABASE_URL` is constructed at runtime from connector options, not hardcoded.

Data model reference: [api/prisma/schema.prisma](../api/prisma/schema.prisma).

## 4) Pub/Sub topic mapping

Logical queue topics from [hosted-app-architecture.md](./hosted-app-architecture.md) section 8 map to physical Pub/Sub topics as follows:

| Logical topic | Physical Pub/Sub topic | Subscription | Dead-letter topic | Ordering key | Max delivery attempts |
|---|---|---|---|---|---|
| `run.requested` | `nessie-run-requested` | `nessie-run-requested-sub` (push to `nessie-worker`) | `nessie-run-requested-dlq` | `threadId` | 5 |
| `step.requested` | `nessie-step-requested` | `nessie-step-requested-sub` (push to `nessie-worker`) | `nessie-step-requested-dlq` | `runId` | 5 |
| `tool.call.requested` | `nessie-tool-call-requested` | `nessie-tool-call-requested-sub` (push to `nessie-worker`) | `nessie-tool-call-requested-dlq` | `runId` | 3 |
| `approval.requested` | `nessie-approval-requested` | `nessie-approval-requested-sub` (push to `nessie-worker`) | `nessie-approval-requested-dlq` | `taskId` | 5 |
| `approval.sweep` | `nessie-approval-sweep` | `nessie-approval-sweep-sub` (push to `nessie-worker`) | -- | -- | 3 |
| `audit.emit` | `nessie-audit-emit` | `nessie-audit-emit-sub` (push to `nessie-worker`) | `nessie-audit-emit-dlq` | -- | 5 |
| `token.ledger.emit` | `nessie-token-ledger-emit` | `nessie-token-ledger-emit-sub` (push to `nessie-worker`) | `nessie-token-ledger-emit-dlq` | `organizationId` | 5 |

Notes:

- `approval.sweep` is triggered by Cloud Scheduler on a 60-second cron (`* * * * *`). It publishes a sweep message to the topic, which triggers the worker to check for expired or timed-out approvals.
- `audit.emit` and `token.ledger.emit` are high-volume async write paths. They decouple audit/ledger persistence from the critical request path to avoid latency spikes.
- Ordering keys are used only where strict sequencing matters (thread-scoped runs, run-scoped steps). Non-ordered topics get higher throughput.
- Dead-letter topics collect messages that exceed max delivery attempts. A separate alerting rule fires when DLQ depth > 0.
- Message retention: 7 days on all topics, 14 days on DLQ topics.

## 5) PubSubQueueProvider adapter

Implements the `QueueProvider` interface from [hosted-app-architecture.md](./hosted-app-architecture.md) section 4:

```ts
import { PubSub, Topic } from '@google-cloud/pubsub';

const TOPIC_MAP: Record<string, string> = {
  'run.requested': 'nessie-run-requested',
  'step.requested': 'nessie-step-requested',
  'tool.call.requested': 'nessie-tool-call-requested',
  'approval.requested': 'nessie-approval-requested',
  'approval.sweep': 'nessie-approval-sweep',
  'audit.emit': 'nessie-audit-emit',
  'token.ledger.emit': 'nessie-token-ledger-emit',
};

class PubSubQueueProvider implements QueueProvider {
  private readonly pubsub: PubSub;

  constructor(projectId: string) {
    this.pubsub = new PubSub({ projectId });
  }

  async enqueue(
    topic: string,
    payload: unknown,
    options?: { delayMs?: number; idempotencyKey?: string },
  ): Promise<string> {
    const physicalTopic = TOPIC_MAP[topic];
    if (!physicalTopic) throw new Error(`Unknown topic: ${topic}`);

    const messageId = await this.pubsub.topic(physicalTopic).publishMessage({
      json: payload,
      attributes: {
        topic,
        ...(options?.idempotencyKey && { idempotencyKey: options.idempotencyKey }),
        publishedAt: new Date().toISOString(),
      },
      ...(options?.delayMs && {
        publishTime: { seconds: Math.floor((Date.now() + options.delayMs) / 1000) },
      }),
    });

    return messageId;
  }

  subscribe(topic: string, handler: (job: QueueJob) => Promise<void>): void {
    // In hosted mode, subscriptions are Eventarc push endpoints.
    // The Cloud Run service receives HTTP POST requests from Pub/Sub.
    // This method registers the handler in an internal registry keyed by topic.
    // The Fastify push endpoint routes incoming messages to the correct handler.
  }

  async acknowledge(jobId: string): Promise<void> {
    // Pub/Sub push: return 200 from the push handler.
    // The jobId maps to the Pub/Sub message ackId.
  }

  async nack(jobId: string, reason?: string): Promise<void> {
    // Pub/Sub push: return 4xx/5xx from the push handler.
    // Pub/Sub redelivers with exponential backoff.
  }
}
```

Message attributes for correlation:

- `requestId` -- original API request ID from `AuthorizedActionContext`
- `correlationId` -- ties related messages across topics (e.g., run -> steps -> tool calls)
- `attempt` -- delivery attempt number (set by Pub/Sub)
- `idempotencyKey` -- caller-provided dedup key

Rules:

- Topic name resolution from logical to physical via the `TOPIC_MAP` config.
- At-least-once delivery; all handlers must be idempotent.
- Handlers must complete within the Cloud Run request timeout (900s for worker).
- Failed handlers return non-200 status, triggering Pub/Sub redelivery with backoff.

## 6) GCS configuration

- **Bucket**: `nessie-{env}-artifacts` (e.g., `nessie-staging-artifacts`, `nessie-production-artifacts`)
- **Location**: Same region as Cloud Run services
- **Storage class**: Standard
- **Versioning**: Disabled (artifacts are immutable; overwrites create new keys)
- **Uniform bucket-level access**: Enabled (no per-object ACLs)

### StorageProvider interface

```ts
interface StorageProvider {
  upload(key: string, data: Buffer | ReadableStream, opts?: { contentType?: string }): Promise<string>;
  download(key: string): Promise<ReadableStream>;
  getSignedUrl(key: string, expiresInMs: number): Promise<string>;
  delete(key: string): Promise<void>;
}
```

### GcsStorageProvider

```ts
import { Storage } from '@google-cloud/storage';

class GcsStorageProvider implements StorageProvider {
  private readonly storage: Storage;
  private readonly bucketName: string;

  constructor(bucketName: string) {
    this.storage = new Storage();
    this.bucketName = bucketName;
  }

  async upload(key: string, data: Buffer | ReadableStream, opts?: { contentType?: string }): Promise<string> {
    const file = this.storage.bucket(this.bucketName).file(key);
    // Stream or buffer upload
    // Returns gs:// URI
    return `gs://${this.bucketName}/${key}`;
  }

  async download(key: string): Promise<ReadableStream> {
    return this.storage.bucket(this.bucketName).file(key).createReadStream();
  }

  async getSignedUrl(key: string, expiresInMs: number): Promise<string> {
    const [url] = await this.storage.bucket(this.bucketName).file(key).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresInMs,
    });
    return url;
  }

  async delete(key: string): Promise<void> {
    await this.storage.bucket(this.bucketName).file(key).delete();
  }
}
```

Key layout:

```
uploads/{organizationId}/{year}/{month}/{uuid}/{filename}
exports/{organizationId}/{exportId}/{filename}
artifacts/{organizationId}/{agentId}/{runId}/{filename}
temp/{uuid}
```

Rules:

- Signed URLs default to 15-minute expiry for both upload and download.
- Client-side uploads use signed URLs generated by the API; the API never proxies large blob data.
- Lifecycle policy: objects under `temp/` are auto-deleted after 7 days.
- CORS configuration allows `PUT` from `*.nessie.unlikeotherai.com` for direct uploads.

## 7) Cloud KMS

- **Key ring**: `nessie-{env}` (e.g., `nessie-staging`, `nessie-production`)
- **Encryption key**: `nessie-tenant-secrets` -- for envelope encryption of tenant secrets
- **Key purpose**: `ENCRYPT_DECRYPT`
- **Algorithm**: `GOOGLE_SYMMETRIC_ENCRYPTION` (AES-256-GCM, managed by Google)
- **Rotation**: Automatic, 90-day rotation period
- **Key ring location**: Same region as Cloud Run services

Envelope encryption flow:

1. API generates a random 256-bit data encryption key (DEK) per secret.
2. API encrypts the DEK with the KMS key (key encryption key / KEK).
3. API stores the encrypted DEK alongside the ciphertext in Postgres.
4. On read, API decrypts the DEK via KMS, then decrypts the secret with the DEK.

Service account requirement:

- `nessie-api` needs `roles/cloudkms.cryptoKeyEncrypterDecrypter` to both encrypt and decrypt.
- `nessie-worker` needs `roles/cloudkms.cryptoKeyDecrypter` (decrypt only -- workers read secrets but do not create them).

Infrastructure/runtime secrets (API keys, DB credentials, signing secrets) use Secret Manager, not KMS. KMS is exclusively for tenant-owned secrets stored in the application database.

## 8) Identity Platform

- **Phase 2 hosted auth default**: Identity Platform replaces the Phase 1 local JWT auth for hosted deployments.
- **Maps to**: `AuthProviderType.identityPlatform` in `packages/config`
- **Sign-in methods enabled**:
  - Email/password
  - Google OIDC
- **Multi-tenancy**: Single Identity Platform tenant per Nessie environment (staging, production). Organization-level tenancy is handled in the application layer, not Identity Platform tenants.
- **JWT verification**: Identity Platform Admin SDK (`firebase-admin` or `google-auth-library`) verifies ID tokens server-side.
- **Token flow**:
  1. Client authenticates via Identity Platform (email/password or Google OIDC redirect).
  2. Client receives an Identity Platform ID token.
  3. Client sends the ID token as `Authorization: Bearer <idToken>` to the API.
  4. API Fastify auth middleware verifies the token via Identity Platform Admin SDK.
  5. API resolves the Identity Platform UID to a Nessie `User` record and constructs `AuthorizedActionContext`.
- **User provisioning**: On first login, if no Nessie `User` record exists for the Identity Platform UID, the API creates one (JIT provisioning). The user is bound to a default organization via an invite or auto-join policy.

Auth mode detection in `packages/config`:

```ts
type AuthMode = 'local' | 'identityPlatform' | 'selfHosted';

// Hosted deployments set:
// NESSIE_AUTH_MODE=identityPlatform
// NESSIE_GCP_PROJECT_ID=<project>
```

## 9) Memorystore Redis

- **Instance name**: `nessie-redis-{env}`
- **Tier**: Basic (no replication -- acceptable for ephemeral data)
- **Memory**: 1 GB
- **Redis version**: 7.x
- **Region**: Same as Cloud Run services
- **Connection**: Private IP via VPC connector (same connector as Cloud SQL)

Use cases:

- **Rate limiting**: Sliding window counters for API endpoints. Key pattern: `rl:{endpoint}:{userId}`, TTL: 60s.
- **Ephemeral session state**: Active WebSocket subscription sets, SSE cursor positions. Key pattern: `sess:{connectionId}`, TTL: 1h.
- **Verification cooldowns**: Step-up verification rate limits. Key pattern: `verify:{userId}:{method}`, TTL: 300s.
- **Continuation-token coordination**: Prevent duplicate approval consumptions. Key pattern: `cont:{tokenId}`, TTL: 600s.
- **Idempotency dedup**: Short-lived dedup keys for at-least-once queue handlers. Key pattern: `idem:{idempotencyKey}`, TTL: 900s.

Rules:

- Every key must have an explicit TTL. No unbounded keys.
- Redis is NOT used for durable business records. If Redis is flushed, the system must recover gracefully from Postgres.
- Max memory policy: `allkeys-lru` (evict least recently used keys when memory is full).
- Application code must handle Redis unavailability gracefully (degrade, not crash).

## 10) Service accounts

| Service | SA name | IAM roles |
|---|---|---|
| `nessie-api` | `nessie-api@{project}.iam.gserviceaccount.com` | `roles/cloudsql.client`, `roles/cloudsql.instanceUser`, `roles/pubsub.publisher`, `roles/storage.objectAdmin`, `roles/cloudkms.cryptoKeyEncrypterDecrypter`, `roles/firebaseauth.admin`, `roles/secretmanager.secretAccessor` |
| `nessie-worker` | `nessie-worker@{project}.iam.gserviceaccount.com` | `roles/cloudsql.client`, `roles/cloudsql.instanceUser`, `roles/pubsub.subscriber`, `roles/storage.objectViewer`, `roles/cloudkms.cryptoKeyDecrypter`, `roles/secretmanager.secretAccessor` |

Notes:

- Each Cloud Run service runs as its dedicated service account. No shared SA.
- `roles/cloudsql.instanceUser` is required for IAM database authentication.
- `nessie-worker` has `pubsub.subscriber` (not publisher) because it only consumes messages. If the worker needs to enqueue follow-up jobs (e.g., step -> tool call), it also gets `roles/pubsub.publisher`.
- `roles/secretmanager.secretAccessor` grants read access to infrastructure secrets stored in Secret Manager (e.g., `NESSIE_AUTH_SECRET`).
- Principle of least privilege: the worker cannot create tenant secrets (no KMS encrypt), and cannot write to GCS (object viewer only, unless artifact upload is needed in which case `objectCreator` is added).

## 11) Terraform structure

```
infrastructure/terraform/
  main.tf                    # Root module, orchestrates all child modules
  variables.tf               # Input variables (project_id, region, env)
  outputs.tf                 # Output values (service URLs, DB connection)
  terraform.tfvars.staging   # Staging variable values
  terraform.tfvars.prod      # Production variable values
  backend.tf                 # GCS remote state backend
  modules/
    cloud-run/
      main.tf                # nessie-api and nessie-worker service definitions
      variables.tf
      outputs.tf
    cloud-sql/
      main.tf                # PostgreSQL instance, database, IAM users
      variables.tf
      outputs.tf
    pubsub/
      main.tf                # Topics, subscriptions, DLQ topics, Cloud Scheduler
      variables.tf
      outputs.tf
    gcs/
      main.tf                # Artifact bucket, lifecycle rules, CORS
      variables.tf
      outputs.tf
    kms/
      main.tf                # Key ring, encryption key, IAM bindings
      variables.tf
      outputs.tf
    redis/
      main.tf                # Memorystore instance
      variables.tf
      outputs.tf
    networking/
      main.tf                # VPC, subnet, VPC connector, Cloud LB, SSL cert
      variables.tf
      outputs.tf
    iam/
      main.tf                # Service accounts, role bindings
      variables.tf
      outputs.tf
```

State management:

- Remote state in GCS bucket: `nessie-terraform-state-{project}`
- State locking via GCS object versioning
- Separate state files per environment (team or directory-based)

Terraform version: `>= 1.5`
Google provider version: `>= 5.0`

## 12) CI/CD pipeline (GitHub Actions)

### Build workflow (`.github/workflows/build.yml`)

Triggers: push to `main`, pull requests.

```yaml
steps:
  - checkout
  - setup-node (22.x)
  - setup-pnpm
  - pnpm install --frozen-lockfile
  - pnpm lint          # All packages
  - pnpm typecheck     # All packages
  - pnpm build         # All packages
  - pnpm test          # All packages
```

### Deploy workflow (`.github/workflows/deploy.yml`)

Triggers: push to `main` (staging), manual dispatch (production).

```yaml
steps:
  # 1. Build Docker images
  - docker build -f infrastructure/docker/Dockerfile.api -t nessie-api .
  - docker build -f infrastructure/docker/Dockerfile.worker -t nessie-worker .

  # 2. Push to Artifact Registry
  - docker tag nessie-api {region}-docker.pkg.dev/{project}/nessie/nessie-api:{sha}
  - docker tag nessie-worker {region}-docker.pkg.dev/{project}/nessie/nessie-worker:{sha}
  - docker push {region}-docker.pkg.dev/{project}/nessie/nessie-api:{sha}
  - docker push {region}-docker.pkg.dev/{project}/nessie/nessie-worker:{sha}

  # 3. Run Prisma migrations
  - npx prisma migrate deploy

  # 4. Deploy to Cloud Run
  - gcloud run deploy nessie-api --image={image} --region={region} ...
  - gcloud run deploy nessie-worker --image={image} --region={region} ...
```

Environments:

- **Staging**: Auto-deploy on push to `main`. Project: `nessie-staging`.
- **Production**: Manual approval gate in GitHub Actions. Project: `nessie-production`.

Artifact Registry:

- Repository: `{region}-docker.pkg.dev/{project}/nessie`
- Image tags: `{sha}` (immutable) and `latest` (mutable, points to most recent deploy)
- Cleanup policy: Delete images older than 30 days except tagged releases

Authentication:

- Workload Identity Federation for GitHub Actions (no long-lived service account keys)
- GitHub OIDC provider configured in GCP project

## 13) Networking

### VPC and connectivity

- **VPC**: `nessie-vpc` in the deployment region
- **Subnet**: `nessie-subnet` with `/24` range for Cloud Run connectors
- **VPC connector**: `nessie-connector` (Serverless VPC Access connector)
  - Used by both `nessie-api` and `nessie-worker` to reach Cloud SQL (private IP) and Redis (private IP)
  - Machine type: `e2-micro`, min 2 / max 3 instances
- **Egress**: Cloud Run services use VPC connector for private resources, direct egress for public internet (model API calls, external integrations)

### Load balancer

- **Type**: External Application Load Balancer (global)
- **Backend**: `nessie-api` Cloud Run NEG (network endpoint group)
- **SSL**: Google-managed SSL certificate for the custom domain
- **Health check**: `GET /api/health` returning `200 OK`
  - Interval: 10s, timeout: 5s, healthy threshold: 2, unhealthy threshold: 3
- **CDN**: Disabled (API responses are not cacheable)

### Custom domains

- **Production**: `api.nessie.unlikeotherai.com`
- **Staging**: `api.staging.nessie.unlikeotherai.com`
- DNS: CNAME or A record pointing to the load balancer IP
- SSL certificates auto-provisioned and auto-renewed by Google

### Firewall rules

- Cloud SQL: accept connections only from VPC connector IP range
- Redis: accept connections only from VPC connector IP range
- Cloud Run services: no ingress restrictions (traffic arrives via LB or Eventarc)

## 14) Observability

### Cloud Logging

- All Cloud Run services emit structured JSON logs.
- Log format: `{ severity, message, requestId, correlationId, userId, organizationId, timestamp, ...fields }`.
- Log sinks: default Cloud Logging retention (30 days). No BigQuery export in Phase 2.
- Error logs (`severity >= ERROR`) trigger alerting policies.

### Cloud Monitoring

Dashboards:

- **API dashboard**: request rate, error rate, p50/p95/p99 latency, active connections (SSE + WebSocket), instance count.
- **Worker dashboard**: job processing rate, job error rate, job duration p50/p95/p99, DLQ depth, instance count.
- **Infrastructure dashboard**: Cloud SQL CPU/memory/connections/replication lag, Redis memory/hit rate/evictions, Pub/Sub publish rate/ack latency/unacked messages.

### Cloud Trace

- OpenTelemetry SDK integrated in both `nessie-api` and `nessie-worker`.
- Traces exported to Cloud Trace via `@google-cloud/opentelemetry-cloud-trace-exporter`.
- Trace context propagated from API -> Pub/Sub message attributes -> worker.
- Sample rate: 100% in staging, 10% in production (adjustable).

### Alerting policies

| Alert | Condition | Duration | Notification |
|---|---|---|---|
| API error rate high | Error rate > 5% | 5 minutes | Email + Slack webhook |
| API latency high | p99 latency > 5s | 5 minutes | Email + Slack webhook |
| Worker error rate high | Job failure rate > 10% | 5 minutes | Email + Slack webhook |
| Cloud SQL CPU high | CPU utilization > 80% | 10 minutes | Email |
| Cloud SQL connections high | Active connections > 80% of max | 5 minutes | Email |
| Redis memory high | Memory utilization > 80% | 10 minutes | Email |
| DLQ non-empty | Any DLQ topic message count > 0 | 1 minute | Email + Slack webhook |
| SSL cert expiry | Certificate expires in < 14 days | -- | Email |

## 15) Cost estimate (monthly, staging)

| Resource | Configuration | Estimated cost |
|---|---|---|
| Cloud Run API | 1 instance always-on, 2 vCPU / 1 GiB | ~$25 |
| Cloud Run Worker | 0-2 instances, 2 vCPU / 2 GiB | ~$15 |
| Cloud SQL | `db-custom-2-4096`, regional HA | ~$120 |
| Pub/Sub | 7 topics, low message volume | ~$5 |
| GCS | < 10 GB storage, low egress | ~$5 |
| Cloud KMS | 1 key, < 10K operations/month | ~$3 |
| Memorystore Redis | Basic tier, 1 GB | ~$35 |
| Load Balancer | External ALB, managed SSL | ~$20 |
| Artifact Registry | < 5 GB images | ~$2 |
| Cloud Logging/Monitoring | Included tier | ~$0 |
| **Total staging** | | **~$230/month** |

Production cost scales with instance counts and traffic. At moderate load (5-10 concurrent users, ~1000 agent runs/day), expect roughly 2-3x staging cost (~$500-700/month).

## 16) Dockerfiles

### `infrastructure/docker/Dockerfile.api`

```dockerfile
# Build stage
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ ./packages/
COPY api/ ./api/

RUN pnpm install --frozen-lockfile --filter @nessie/api...
RUN pnpm --filter @nessie/api... build
RUN pnpm --filter @nessie/api deploy --prod /app/deploy

# Runtime stage
FROM node:22-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/deploy ./
COPY --from=builder /app/api/prisma ./prisma/

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
```

### `infrastructure/docker/Dockerfile.worker`

```dockerfile
# Build stage
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ ./packages/
COPY worker/ ./worker/

RUN pnpm install --frozen-lockfile --filter @nessie/worker...
RUN pnpm --filter @nessie/worker... build
RUN pnpm --filter @nessie/worker deploy --prod /app/deploy

# Runtime stage
FROM node:22-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/deploy ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
```

Notes:

- Both use multi-stage builds to minimize runtime image size.
- `node:22-slim` as runtime base (Debian bookworm-slim, ~180 MB).
- `openssl` is required for Prisma.
- `pnpm deploy --prod` creates a minimal production-only node_modules.
- Images are tagged with the Git SHA for immutable deployments.

## 17) Cross-links

- [hosted-app-architecture.md](./hosted-app-architecture.md) -- physical deployment topology, stack decisions, queue abstraction
- [deployment-modes-and-auth-spec/overview.md](./deployment-modes-and-auth-spec/overview.md) -- deployment modes, auth modes
- [implementation-phases.md](./implementation-phases.md) -- Phase 2 scope and exit criteria
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) -- canonical event types and API contracts
- [config-module-spec.md](./config-module-spec.md) -- auth mode configuration, runtime capabilities
- [organization-governance-spec.md](./organization-governance-spec.md) -- org/project/team model extended in Phase 2
