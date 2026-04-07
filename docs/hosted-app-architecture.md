# Hosted App Architecture

> Status: target-state design.

## 1) Architecture overview

Build Nessie as a stateless, database-backed, multi-tenant system with:

- one provider-agnostic core application,
- one reference hosted SaaS deployment on Google Cloud,
- one first-class self-hosted path for local and organization-owned installs.

TypeScript remains the main implementation language.

The correct default is not "wrap the current CLI/server and hope it scales." The correct default is:
- reuse the orchestration concepts and typed control-plane ideas from the current codebase,
- refactor the task/event/approval/verification model into shared packages,
- replace the local-machine execution assumptions with hosted isolation boundaries.

The primary scale model should be horizontal for API, realtime, and worker services, with vertical tuning available per service. A paid hosted product should never depend on one process owning in-memory tenant state.

The hosted deployment may be GCP-specific, but the core product architecture must not be.

## 2) Reuse vs rewrite

### Reuse

- task/event model from the current orchestration layer
- task ledger concepts and review/approval flow
- role registry and multi-agent orchestration patterns
- MCP/control-plane naming direction
- metrics, watcher, and validation concepts
- OpenClaw-style deterministic control semantics:
  - explicit routing and delivery ordering
  - idempotency keys and resumable continuation
  - queueing by mutation boundary so one conflicting run cannot corrupt shared state
- OpenClaw-style session discipline:
  - stable session/thread IDs
  - lightweight previews
  - bounded history fetch
  - subscription-first updates instead of transcript reloads
- approval-gated side effects and workflow checkpoints
- role-scoped capability boundaries for orchestrators, builders, reviewers, and watchers

### Refactor

- orchestrator service boundaries
- MCP adapter and typed control-plane contracts
- approval/verification/token-ledger modules into shared domain packages
- event types into shared packages used by API, realtime, and workers
- OpenClaw's "Gateway" idea into a multi-tenant stateless control plane split across API, realtime, worker, and runner services
- string-heavy session keys into proper org-scoped entities:
  - organization
  - team
  - channel
  - thread
  - agent
  - task
  - run
  - approval
- review loops into policy-driven templates instead of one hard-coded workflow
- remote-stack infrastructure discipline from [remote/techstack.md](./remote/techstack.md):
  - durable versus ephemeral storage boundaries
  - telemetry from day one
  - explicit subsystem ownership

### Replace

- local SQLite persistence
- direct filesystem/bash tool execution on the host
- unauthenticated HTTP/MCP/WS surface
- local-machine assumptions in tool registry and session handling
- any "single process owns everything" runtime design
- monolithic always-on gateway ownership of all runtime state
- JSONL transcripts as the primary source of truth
- device-global or machine-global trust assumptions
- local pairing/discovery, LAN-first, or operator-machine assumptions as core platform architecture
- opaque skill marketplace trust assumptions

## 3) Preferred stack

- Language: TypeScript
- Runtime: Node.js 22+
- API: Fastify
- Web app: React + Vite for the authenticated product UI
- Database: Cloud SQL for PostgreSQL (regional HA)
- DB auth/connectivity: IAM DB authentication plus the Cloud SQL Node.js connector
- ORM/query layer: Prisma initially, with SQL escape hatches for hot paths
- Cache/ephemeral store: Memorystore Redis with TTL-first usage only
- Queue/background execution: Pub/Sub plus Eventarc-triggered Cloud Run workers
- Optional paced/dedup queue: Cloud Tasks where scheduled or rate-controlled delivery is required
- Blob storage: Google Cloud Storage
- Realtime fanout: SSE-first API delivery with optional later split to a dedicated realtime gateway
- Infra target: Google Cloud Run for stateless services
- Auth/session: provider-agnostic auth abstraction with:
  - hosted default = `authentication.unlikeotherai.com`
  - GCP reference option = Identity Platform
  - self-hosted option = configurable SSO providers with optional auto-redirect
- Secrets: application-layer envelope encryption with Cloud KMS for tenant secrets; Secret Manager for infrastructure/runtime secrets
- Observability: Cloud Logging/Monitoring/Trace plus OpenTelemetry
- Persistent services: Cloud SQL for PostgreSQL, GCS for blobs/artifacts, Pub/Sub/Eventarc, Identity Platform, Cloud KMS, optional Memorystore for Redis

Why this stack:
- it is fast enough,
- operationally boring,
- open-source friendly,
- close enough to the current TypeScript codebase to reuse core concepts,
- much simpler than jumping to microservices or a second primary language immediately.

Cross-link:
- [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md)
- [implementation-phases.md](./implementation-phases.md)
- [provider-system-and-frontend-architecture.md](./provider-system-and-frontend-architecture.md)

## 4) Logical architecture

### API service

Responsibilities:
- auth/session validation
- one canonical current-user/session endpoint for frontend consumers
- MVP scope:
  - user/session validation
  - default project/team bootstrap per organization
  - channel CRUD and membership
  - agent CRUD and channel binding
  - thread/message CRUD
  - chat/send and SSE stream endpoints
  - basic run/task records
- later hosted scope:
  - org/project/team/channel policy enforcement
  - CRUD for projects, secrets metadata, token ledger, and language settings
- command parsing and control-plane actions
- job submission to workers
- canonical persistence to Postgres
- Fastify auth middleware validates the session, resolves `AuthorizedActionContext`, and attaches it to the request before handlers run

### Realtime gateway

Responsibilities:
- SSE/WebSocket connections
- stream deltas, task updates, routing traces, approval prompts
- read resumable stream state from durable storage and short-lived caches
- no durable business state

### Worker service

Responsibilities:
- execute agent jobs
- coordinate model calls
- run bounded workflow steps
- emit task events and token-ledger events
- consume Pub/Sub-delivered work with idempotent handlers
- write durable outputs to Postgres/GCS

### Runner service

Responsibilities:
- isolated execution for risky tools or interactive sessions
- per-job/per-session sandbox boundary
- no tenant-long-lived mutable state

This should be a separate service boundary from the API. Do not let the API process execute shell-like tools directly.

### Remote worker boundary

The hosted product should also support customer-installed remote workers that register to a parent Nessie control plane.

Rules:

- remote workers are not hosted runners,
- remote workers authenticate to the parent API with worker-scoped credentials,
- remote workers heartbeat while idle and open websocket sessions only when assigned work,
- remote workers report capability and local-policy digests during handshake and policy-sync,
- parent policy may narrow remote worker permissions but never exceed machine-local hard policy.

### Identity source-of-truth rule

There must be one canonical identity/session source for the product.

Rules:

- `/admin` should consume one shared auth/session module,
- current user/session comes from one canonical backend contract,
- actor context for agent/runtime calls is derived from that same backend session,
- pages must not construct their own parallel auth/user state objects.

### Actor context propagation rule

The API must serialize the canonical shared `AuthorizedActionContext` into worker job payloads.

Rules:

- the API creates the context once per request
- worker jobs receive the serialized context, not a session token
- workers must not reconstruct actor context from ad hoc env vars or page state
- `requestId` and `correlationId` must survive API -> queue -> worker -> ledger/audit paths

## 5) Control-plane invariants

These are the most important OpenClaw carry-forwards. Nessie should preserve the behavior even though the deployment model is different.

1. The control plane, not the prompt, is the source of truth for routing, approvals, retries, audit, and policy.
2. Every mutable workflow step needs an idempotency boundary.
3. Conflicting mutations must serialize on the smallest safe key:
   - thread when mutating thread state
   - task or run when mutating task state
   - approval when consuming an approval token
4. Spawn is non-blocking:
   - parent gets acceptance immediately
   - child completion returns as an event
   - polling is optional compatibility, not the primary model
5. Side effects must be resumable after approval without double-send or double-deploy behavior.
6. Tasks, runs, approvals, reviews, artifacts, and ledger entries are first-class records, not implicit chat turns.
7. Client sync must be incremental:
   - previews
   - cursored history
   - subscriptions
   - reconnect from durable state
8. Policy is runtime-enforced:
   - tool grants
   - channel/project scope
   - verification requirements
   - sandbox boundaries

## 6) OpenClaw carry-forward matrix

### Adopt directly

- deterministic control semantics
- explicit session and thread identity
- durable task ledger with event history
- approval-gated side effects with continuation tokens
- role-scoped capabilities and visibility
- bounded review and verification stages
- push-based completion and announce semantics
- subscription-first session updates

### Adapt for Nessie

- replace the single Gateway with separate stateless services
- keep session-key discipline, but model primary data as org-scoped relational entities
- keep workflow approvals, but use simpler state machines before adding richer workflow builders
- keep node capability ideas, but express them as runners, tool hosts, or MCP-capable execution surfaces
- keep OpenClaw's control protocol mindset, but do not copy `[VERIFY LIVE]` protocol details as implementation contracts

### Reject explicitly

- monolithic gateway as the source of truth
- JSONL transcript storage as the main persistence model
- LAN discovery, pairing, or device-centric trust as baseline SaaS behavior
- unrestricted cross-channel or cross-project side effects
- marketplace trust assumptions for unreviewed skills or plugins
- prompt-only policy enforcement
- debate-heavy coordination as the default review model

## 7) Physical deployment topology

### Google Cloud default

- `nessie-api` on Cloud Run
- `nessie-worker` on Cloud Run triggered by Pub/Sub via Eventarc
- `nessie-realtime` on Cloud Run only if SSE/stream fanout later needs its own deployable
- `nessie-runner` on Cloud Run Jobs first, then isolated long-lived runner pool only if needed
- Cloud SQL PostgreSQL
- Pub/Sub + Eventarc
- Google Cloud Storage
- Identity Platform
- Cloud KMS
- Memorystore Redis only for rate limits, ephemeral session state, verification cooldowns/tokens, and short-lived coordination
- Cloud Load Balancer in front of API/realtime
- Secret Manager for infrastructure/runtime credentials only

### Why this is the right first deployment shape

- stateless services scale cleanly
- Postgres remains the source of truth
- Pub/Sub decouples HTTP from agent execution
- Redis, when present, handles ephemeral coordination only
- in hosted GCP mode, GCS handles uploads, generated artifacts, transcripts, and export bundles
- Cloud Run keeps ops simple for an OSS project that people can self-host in smaller environments

### Self-hosted default

- Docker Compose as the first supported self-hosting path
- Postgres as the default durable store
- optional Redis for ephemeral coordination
- local disk or S3-compatible object storage adapter
- pluggable SSO providers
- single-machine installs supported for machines like Mac mini or small Linux servers

### Non-Docker local default

- non-Docker installs must also be supported
- Postgres remains required
- Redis stays optional unless enabled features require it
- local filesystem object storage should be the simplest default
- MinIO or another S3-compatible local store should be optional, not mandatory
- local launcher should provide dependency checks and installation guidance instead of assuming Docker

## 8) Database and storage boundaries

### PostgreSQL

Use Postgres for:
- organizations, users, memberships
- projects, channels, agents, tool bindings
- task ledger and task events
- approvals and verification state
- token ledger and pricing profiles
- knowledge-base metadata
- message canonicals and translation metadata

### Redis

Use Redis for:
- rate limits
- step-up verification cooldowns and transient tokens
- ephemeral presence
- short-lived streaming state
- session cursors and transient translation caches
- transient idempotency and continuation-token coordination
- ephemeral runner session buffers and process liveness data
- short-lived distributed leases if needed

Do not use Redis as the source of truth for any durable business record.

Verification challenge records, approvals, and audit trails remain durable in Postgres.

### Pub/Sub and Eventarc

Use Pub/Sub for:
- `run.requested`
- `step.requested`
- `tool.call.requested`
- `approval.requested`
- `translation.requested`
- internal run-event notifications that should fan out asynchronously

Rules:
- design for at-least-once delivery
- every handler must be idempotent
- ordering keys should be used only where strict sequencing is required
- dead-letter topics should be enabled early for stuck workloads

### Google Cloud Storage

Use GCS for:
- uploaded files
- knowledge-base source blobs
- generated exports
- large agent artifacts
- optional transcript/object snapshots

## 9) Realtime and session handling

### Two transport model

Phase 1 explicitly uses both realtime transports.

Nessie uses two realtime transports for different purposes:

- **SSE** for chat/thread streaming: ordered message deltas, run completions, and thread-scoped events. SSE is the right fit because chat is unidirectional server-to-client delivery with natural reconnect semantics (`Last-Event-ID`).
- **WebSocket** for presence and activity: agent status changes, tool execution ticks, sub-agent lifecycle, and UI subscription management. WebSocket is justified here because the client needs to subscribe/unsubscribe to specific agent activity streams and the server needs low-latency push for high-frequency status changes.

Both transports must rebuild state from Postgres on reconnect, not from in-memory process state.

All realtime events must use the canonical dotted event names from [shared-type-contracts-spec.md](./shared-type-contracts-spec.md).

### Chat/reply streaming (SSE)

- canonical thread state lives in Postgres
- SSE is the streaming transport for chat content delivery
- stream fanout should replay from durable events with optional short-lived Redis buffers
- reconnect must rebuild state from Postgres using `Last-Event-ID` mapped to a monotonic sequence
- client sync should prefer:
  - session previews
  - bounded history windows
  - cursors
  - follow/subscribe semantics
  - targeted run-state events

### Agent activity and presence (WebSocket)

The WebSocket connection carries all non-chat realtime state. This is the transport that makes the UI feel alive.

Required subscription model:

- client connects once and subscribes to scopes: `organization`, `channel`, or specific `agentId` list
- server pushes events matching active subscriptions
- client can change subscriptions without reconnecting

Required Phase 1 WebSocket events for agent activity:

- `agent.status`
- `agent.tool.start`
- `agent.tool.end`
- `agent.spawned`
- `run.updated`
- `approval.needed`
- `message.new`

For canonical payload shapes and the full event type definitions, see [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) section 4. Do not redefine event shapes in this document.

`agent.thought` and `agent.tool.progress` are Phase 2+ events and must not be implemented in Phase 1.

Rules:

- `agent.status` must fire within 500ms of any status transition. This is the event that drives presence indicators.
- `agent.tool.start` and `agent.tool.end` must always fire as a pair. If a tool crashes, `agent.tool.end` fires with `success: false`.
- `inputSummary` in `agent.tool.start` must never contain secrets, credentials, or full file contents. Sanitization happens server-side before emit.
- All activity events carry `agentId` so the client can attribute activity to the correct agent panel without parsing.

Reconnect behavior:

- on WebSocket reconnect, client sends its subscription set
- server replays current snapshot for all subscribed agents:
  - one `agent.status` per agent (includes `currentRunId`, `currentToolName`, `currentToolStartedAt` when agent is not idle)
  - if an agent is in `executing` state, also replay the in-flight `agent.tool.start` so the UI can show which tool is running
  - if an agent has an active run, replay `run.updated` for the in-flight run
- server does not replay historical activity events (completed tool calls, past spawns)
- sub-agent tree is populated on initial load and reconnect via REST (`GET /api/agents/{agentId}/children`), then kept live via `agent.spawned` WebSocket events; the REST endpoint returns currently-active children regardless of parent status

### Interactive process sessions

- session metadata is durable in Postgres
- live IO buffers and presence are ephemeral in Redis
- runner instances own actual process execution
- API and realtime services only proxy control/data, never host the process

### Translation delivery

- canonical stored message remains in organization language
- translated delivery is generated on demand or cached briefly in Redis
- translation usage events also emit into the token ledger

## 10) Task and workflow model

- task, run, review, approval, and artifact records are first-class persisted entities
- builder/reviewer/adjudicator loops are policy templates, not hard-coded universal behavior
- verification is a hard state transition:
  - external truth checks first where possible
  - reviewer pass
  - bounded repair loop
  - second reviewer or adjudication only when policy requires it
- debate is not the default coordination pattern
- every workflow class should declare:
  - concurrency cap
  - loop cap
  - timeout budget
  - cost budget
  - side-effect policy

## 11) Tool execution model

The hosted product must separate:
- safe API-level tools,
- read-only hosted integrations,
- high-risk execution tools.

Default rule:
- no arbitrary host bash in API or worker containers.

Hosted execution tiers:
- tier 1: safe hosted tools in worker process
- tier 2: external integrations over HTTP/MCP
- tier 3: isolated runner jobs for privileged or interactive tools
- tier 4: customer-owned remote workers for explicitly delegated machine-local execution

If a tool needs filesystem, shell, SSH, or long-lived interactive control, it should run in a dedicated runner boundary, not in the main API.

If execution must happen on a customer-owned desktop/server, it should go through the remote-worker contract rather than direct inbound access.

Interactive tools and long-lived sessions must never drift back into the API process because the old local runtime did it that way.

## 12) Web application

- `/admin` is the authenticated Nessie product UI and should be CSR-first
- `/web` is the landing page / marketing surface and can stay minimal
- `/admin` talks to `/api`
- Phase 1 streaming should be served directly from `/api` over SSE
- a separate realtime service is optional later, not required for Phase 1
- login UX must support:
  - provider chooser page,
  - optional auto-redirect to one configured SSO provider,
  - local-install mode where auto-redirect can be disabled even if one provider exists

Do not couple the product UI to the current CLI interface. The CLI can stay as an operator/dev surface, but it is not the product architecture.

## 13) Suggested package structure

```text
api/
admin/
web/
worker/
runner/
packages/
  domain/
  schemas/
  orchestration/
  control-plane/
  remote-worker-protocol/
  auth/
  policy/
  token-ledger/
  translation/
  config/
infrastructure/
  docker/
  compose/
  cloudrun/
  terraform/
```

Root layout rule:

- `/api` is the backend/control-plane service root
- `/admin` is the full Nessie product interface root
- `/web` is the landing page / marketing site root only
- `/worker` is the async execution service root

## 14) Architectural rules

1. API, realtime, worker, and runner are separate deployable units.
2. Postgres is the source of truth.
3. Redis is ephemeral only.
4. GCS is the only blob/artifact store.
5. API never executes privileged tools directly.
6. All external input is schema-validated.
7. Tenant boundaries are enforced in every service, not just the UI.
8. Token ledger events are emitted for every model call, including translation calls.
9. The hosted product reuses orchestration ideas from the CLI/runtime, not its local execution assumptions.
10. Keep the first hosted version unified in repo ownership, shared packages, and data contracts even though API, realtime, worker, and runner deploy separately.
11. The control plane owns routing, policy, approvals, and audit semantics.
12. All side effects must be idempotent or protected by continuation tokens.
13. Review and verification loops are budgeted by policy, not left open-ended.
14. Interactive and privileged execution stays behind runner isolation.
15. Customer-owned remote execution must flow through the remote-worker protocol with local-policy intersection and worker-scoped credentials.
16. Hosted and self-hosted deployments must share the same control-plane contracts and core data model.
17. Authentication must be provider-agnostic in the core even when hosted defaults are opinionated.

## 15) Anti-patterns

- building the hosted product around the current local SQLite runtime
- letting Cloud Run API instances own long-lived in-memory tenant state
- using Redis as the canonical database
- mounting shared writable disks into API containers
- executing bash/SSH directly in the API
- mixing product architecture with operator CLI assumptions
- introducing Kubernetes-first complexity before Cloud Run limits are real
- importing OpenClaw's trusted-host assumptions into a hosted multi-tenant product
- storing operational truth only in chat transcripts
- broad child-session visibility by default
- letting approval resumptions create duplicate side effects
- treating every workflow as a debate among many agents when a cheaper verification template will do

## 16) Scaling and cost notes

### Default scaling path

- start on Cloud Run for API and worker
- add a separate realtime service only when connection shape justifies it
- use Cloud SQL Postgres, Pub/Sub/Eventarc, GCS, Identity Platform, and Cloud KMS
- use Docker Compose plus local adapters for the first self-hosted path
- support non-Docker local startup with dependency checks and guided setup
- add Memorystore Redis when rate limits, ephemeral sessions, or step-up state justify it
- use GCS for all binary/object storage
- add dedicated runner capacity only for tools that truly require it

### Upgrade triggers

Move part of the system to GKE or a dedicated runner pool only when:
- interactive sessions are long-lived enough that Cloud Run is the wrong fit
- WebSocket/SSE volume exceeds practical Cloud Run behavior
- runner isolation needs custom kernel/container controls
- job concurrency becomes dominated by sandboxed execution rather than API traffic
- workload networking or sidecar needs exceed what Cloud Run is good at

### Vertical vs horizontal

You asked for vertical scaling. The system should support vertical tuning per service, but the actual reliable scale model is horizontal for stateless services plus vertical sizing for hot workers/runners.

## 17) First production milestone

The smallest credible production shape is:

- `nessie-api` on Cloud Run
- `nessie-worker` on Cloud Run with Pub/Sub/Eventarc
- Cloud SQL Postgres with regional HA and IAM DB auth
- Pub/Sub with dead-letter topics for run/step workflows
- GCS with signed URL upload/download
- Identity Platform for auth and MFA
- Cloud Logging/Monitoring/Trace plus OpenTelemetry

This is enough to remain stateless, durable, and scalable without prematurely splitting into a larger service graph.

## 18) Reuse recommendation for the current codebase

Treat the current CLI/runtime as:
- a domain/reference implementation for orchestration concepts,
- not the base runtime for the hosted product.

Practical rule:
- reuse types, task semantics, approval/verification patterns, and MCP/control-plane ideas,
- rewrite persistence, auth, tenancy, tool execution, and deployment topology for hosted operation.

## 19) What not to build yet

- a large microservice graph before measured bottlenecks exist
- WebSocket-first realtime as the primary delivery model
- per-tenant databases or schemas on day one
- exactly-once assumptions in the async core
- a bespoke workflow engine before Pub/Sub step orchestration and Cloud Run Jobs are proven insufficient
- unencrypted secret storage in Postgres or any secret storage in Redis

## 20) Open questions

1. Do you want the first hosted version to support arbitrary interactive shell/SSH tools immediately, or should v1 ship only safe hosted tools plus API integrations?
2. Should hosted auth default directly to `authentication.unlikeotherai.com`, with optional auto-redirect when only one provider is configured?
3. Should the web app and API live in one repo with one release train, or do you want them versioned independently from day one?
