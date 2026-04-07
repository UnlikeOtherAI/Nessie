# Nessie hosted architecture recommendation on Google Cloud

## Recommended stack

The first serious hosted version of Nessie should be a **Cloud Run + Cloud SQL (PostgreSQL) + Pub/Sub + GCS** platform, with **Redis** added specifically for rate limits, ephemeral agent/tool sessions, and “step‑up” verification state. This is the smallest “boring” set of managed services on Google Cloud that still supports stateless horizontal scaling, durable state, asynchronous work, and streaming UX. citeturn6search15turn4search7turn5search17turn4search0turn6search0

**Opinionated default stack (hosted):**

- **API/runtime language & framework:** TypeScript on **Node.js** (LTS) using a low-friction HTTP framework (e.g., Fastify or Hono) packaged as a container and deployed on **Cloud Run**. The key requirement is excellent streaming/SSE support, strong ecosystem libraries for Postgres/Redis, and predictable production behaviour. Cloud Run’s core model (stateless containers invoked by HTTP) aligns with your stateless constraint. citeturn6search15turn5search28turn2search0  
- **Database:** **Cloud SQL for PostgreSQL** (regional HA) as the durable system-of-record for multi-tenant metadata, chat history, run state, approvals, ledgers, and audit trails. Enable HA early for a paid product. citeturn4search0turn4search4  
- **DB connectivity & auth:** Use **IAM database authentication** plus the **Cloud SQL Node.js Connector** (recommended by Google) rather than baking database passwords into configs. citeturn0search2turn6search11turn6search15  
- **Cache/ephemeral store:** **Memorystore for Redis** (Standard HA) with **in‑transit TLS** and **Redis AUTH** enabled; use strict TTLs and treat it as disposable. citeturn6search0turn6search5turn6search1  
- **Queue/background jobs:** **Pub/Sub** for run orchestration + async tool calls, delivered to Cloud Run via **Eventarc Pub/Sub triggers**. Assume **at‑least‑once** delivery (duplicates are normal) and design idempotent workers. citeturn0search5turn5search17turn7search10  
  - Optional add-on when you need controlled pacing/dedup/scheduling: **Cloud Tasks** (task names provide deduplication and it provides rate/retry controls). citeturn1search1turn1search9  
- **Blob/object storage:** **Google Cloud Storage** for uploaded files, artifacts, and large run outputs; use **signed URLs** so clients upload/download directly without proxying large payloads through API instances. citeturn4search7turn2search1  
- **Auth/session approach:** **Identity Platform** for user authentication (including MFA), issuing JWTs; keep Nessie API stateless by validating tokens on each request. Add a “step‑up” capability by minting short-lived “elevated” tokens after a recent MFA challenge for sensitive operations (secrets export, org role changes, deployment approvals). citeturn1search11turn1search3  
- **Secrets handling:** Prefer **application-layer envelope encryption** with **Cloud KMS** for per-tenant secrets stored in Postgres, and reserve **Secret Manager** for infrastructure/runtime secrets (if any) and operational workflows (audit logs, access control). citeturn2search3turn2search14turn2search6  
- **Observability:** Use Google Cloud Operations suite basics (Logging/Monitoring/Trace) by default, and standardise on **OpenTelemetry** end-to-end (OTLP ingestion is now supported/recommended for Cloud Trace). citeturn3search6turn3search2turn3search10  
- **GCP services you should assume exist in v1:** Cloud Run, Cloud SQL (Postgres), Pub/Sub + Eventarc, Cloud Storage, Memorystore (Redis), Identity Platform, Cloud Logging/Monitoring/Trace. citeturn6search15turn4search0turn0search5turn4search7turn6search0turn1search11turn3search6

## Hosted architecture on Google Cloud

The clean hosted architecture for Nessie is a **stateless control plane** with a **durable database** and **event-driven workers**. Cloud Run acts as your scaling boundary for HTTP and “worker via HTTP” workloads; Cloud SQL holds truth; Pub/Sub carries execution intent and progress events; GCS holds bytes; Redis holds short-lived coordination state. citeturn6search15turn4search0turn5search17turn4search7turn6search0

A practical decomposition that stays simple (open-source friendly) while still scaling:

- **Control plane API (Cloud Run service):**  
  Handles org/team/channel CRUD, agent/tool registry, chat APIs, run creation, approvals, token ledger reads, and issues signed URLs for uploads. It writes durable state to Postgres, publishes “run requested” events to Pub/Sub, and exposes SSE endpoints that stream from persisted run output/events. Cloud Run supports streaming HTTP responses; SSE is a standard pattern here. citeturn5search28turn5search11turn4search0turn5search17  
- **Worker (Cloud Run service triggered by Pub/Sub via Eventarc):**  
  Implements the agent executor as a **step machine**: claim a step, execute, persist outputs, enqueue next step. Eventarc can deliver Pub/Sub-triggered requests to Cloud Run services. citeturn0search5turn0search1  
- **Storage layer:**  
  - Cloud SQL PostgreSQL (HA regional) = truth + audit. citeturn4search0turn4search4  
  - GCS = artifacts and uploads. citeturn4search7turn2search1  
  - Memorystore Redis = TTL coordination. citeturn6search0turn6search5  
- **Security/auth:**  
  Identity Platform handles authentication and MFA; Nessie validates JWTs and enforces org/team RBAC in the API and database access patterns. citeturn1search11turn1search3  
- **MCP-first posture:**  
  MCP is a JSON‑RPC 2.0 based standard describing “hosts/clients/servers” for tool access; adopting it as your boundary for tools is aligned with where the ecosystem is going. The MCP specification is published at modelcontextprotocol.io, and entity["company","Anthropic","ai research company"] originally introduced MCP publicly in late 2024. citeturn5search1turn5search5  
  Google Cloud itself is now investing in managed/remote MCP servers for database and cloud products (including Cloud SQL / PostgreSQL) which is a signal that “MCP-first control planes” are becoming mainstream infrastructure patterns. citeturn5search4turn5search0turn5search8  

image_group{"layout":"carousel","aspect_ratio":"16:9","query":["Google Cloud Run Cloud SQL Pub/Sub architecture diagram","Google Cloud Storage signed URL upload architecture","Cloud Run Pub/Sub Eventarc trigger diagram","Memorystore for Redis architecture diagram"],"num_per_query":1}

**Why this is the right default for a hosted, paid, multi-tenant product:**

- **Cloud Run gives you horizontal scaling with minimal ops**, but you must accept its constraints: request timeouts, best-effort session affinity, and the reality that instances can be recycled at any time, which is exactly why the design must be state-externalised (DB/Redis/GCS). citeturn6search15turn7search2turn3search1turn3search21  
- **Cloud SQL Postgres is the simplest durable backbone** for the product requirements you listed (orgs/teams/channels/agents/tools/secrets/translation/ledger/approvals). You can add HA as a configuration rather than rebuilding later. citeturn4search0turn4search4  
- **Pub/Sub is the GCP-native way to decouple runtime work from HTTP requests**, and its default at-least-once delivery pushes you into the correct reliability posture: idempotent workers with explicit state transitions. citeturn5search17turn7search10  

## Stateless scaling model for chat, agent runs, and real-time communication

Building Nessie “stateless” does not mean “no state exists”; it means **no instance-local state is required for correctness**. Every feature you listed becomes a matter of (a) durable records in Postgres, (b) ephemeral coordination keys in Redis, and (c) async execution via Pub/Sub. Cloud Run instances become replaceable. citeturn6search15turn4search0turn5search17turn6search0

### Chat threads

Use Postgres as the source of truth for chat threads:

- Store each message as an immutable row with monotonic ordering per thread (sequence number) and strong indexing. For scale, partition by time or tenant once tables get large; Postgres declarative partitioning exists specifically for splitting large tables while keeping a single logical table interface. citeturn4search2turn4search0  
- “Realtime” updates should be **cursor-based**: clients fetch `messages?after=<message_id or seq>` and optionally connect to SSE to receive new message IDs/events. This avoids server-side in-memory per-room state. Cloud Run supports streaming HTTP responses (chunked), and SSE is an explicit supported pattern. citeturn5search28turn5search11  

**Anti-pattern to avoid:** “sticky chat servers” that keep canonical chat state in process memory (or rely on session affinity) will fail under autoscaling and instance recycling. Cloud Run session affinity is best-effort and explicitly warns you not to assume reconnection to the same instance. citeturn3search1

### Long-running agent tasks

Treat an “agent run” as a persisted state machine, not a single long process:

1. API writes `run` + initial `run_steps` rows and publishes `run.requested(run_id, tenant_id, attempt)` to Pub/Sub. citeturn5search17turn0search5  
2. Worker receives the message and performs a small bounded unit of work (e.g., one reasoning step, one tool call, one LLM completion chunk batch), then persists outputs and transitions the run state. citeturn5search17turn7search10  
3. If more work remains, the worker publishes the next step event (or the worker loop schedules itself with a follow-up message). citeturn0search5turn5search17  

This is how you stay stateless **and** survive interruptions: every step commits to durable storage. Cloud Run has a hard request timeout cap (up to 3600 seconds) for any single request/connection, so designing runs as multiple short steps is structurally safer than “one request per run.” citeturn7search2turn0search0

If you genuinely need single units of work that exceed typical request timeouts, Cloud Run **Jobs** support long “run-to-completion” tasks with configurable task timeouts (the job/task timeout can be configured up to 168 hours in the Jobs model). Use Jobs for offline batch workflows, not for interactive step execution. citeturn1search2

### SSE, WebSockets, and streaming responses

For v1, the most practical hosted default is:

- **SSE for “tailing” run output and chat updates**, with client reconnection logic using a cursor (`last_event_id`/sequence). Cloud Run supports streaming responses and SSE; no special platform feature is required beyond chunked transfer encoding. citeturn5search28turn5search11  
- **Streaming LLM responses** should be implemented as: worker writes tokens/chunks to a run-output table (or Redis stream with TTL), API streams them over SSE. If the stream breaks, the client reconnects and resumes from the last cursor (stateless reconnection). The requirement that clients reconnect is normal on Cloud Run because the maximum request timeout is 60 minutes. citeturn7search2turn0search29  
- **WebSockets are optional** and come with constraints: Cloud Run WebSockets are treated as long-running requests and remain subject to the configured request timeout (example guidance: set it to 60 minutes and implement reconnect). There’s also no guarantee a reconnect lands on the same instance. citeturn0search0turn0search29turn3search1  

**Blunt recommendation:** make **SSE the product default**; add WebSockets only after you can prove you need bidirectional realtime semantics that SSE + normal HTTP cannot cover. The platform constraints (60-minute max timeout, best-effort affinity) mean WebSockets are not a free lunch on Cloud Run. citeturn7search2turn3search1turn0search0

### Interactive tool sessions

Tool sessions are where people accidentally smuggle “stateful server” back into a stateless system. The stateless model that works:

- Persist the **authoritative transcript** (tool invocations + outputs + approvals) in Postgres. citeturn4search0  
- Keep only **ephemeral session buffers** (terminal-like output buffers, temporary tool handshakes, short-lived capability tokens) in Redis with short TTL and revocation semantics; enable TLS and AUTH for Memorystore. citeturn6search0turn6search5  
- Any “tool session” must be resumable from Postgres + a new ephemeral token. If Redis is flushed, sessions degrade gracefully (force re-handshake) rather than corrupting state. citeturn6search0turn4search0  

### Queues, retries, and idempotency

With Pub/Sub you must assume **redelivery**. Pub/Sub documents that it has at-least-once delivery semantics by default, meaning subscribers must tolerate duplicates. citeturn5search17  
Design rules that keep this practical:

- **Idempotent worker handlers:** every message has a deterministic `event_id` (or use Pub/Sub message ID) and the worker records “processed event IDs” in Postgres with a uniqueness constraint (`INSERT … ON CONFLICT DO NOTHING`) so duplicate deliveries become no-ops. This aligns with at-least-once semantics and retry policies (messages are resent when ack deadlines expire or on negative ack). citeturn7search10turn5search17  
- **Exactly-once expectations:** Pub/Sub “exactly-once delivery” exists, but it’s only supported for **pull** subscriptions, not push delivery. Eventarc-to-Cloud-Run flow is effectively push style, so design as at-least-once. citeturn5search2turn0search5  
- **Idempotency keys for user-facing POST endpoints:** copy the payments industry discipline: the client supplies an idempotency key; the server stores the result by key and returns the same result if retried. This is a widely adopted mitigation for network retries. citeturn7search1turn7search19  
- **Ordering where needed:** Pub/Sub supports ordering keys; apply them per `run_id` if you need strict step ordering, and use dead-letter topics to avoid indefinite blocking when an ordered key gets stuck. citeturn1search0turn1search8  
- **Transactional outbox when you outgrow simple “insert then publish”:** the outbox pattern turns dual-write (DB + Pub/Sub) into a single DB transaction plus an async dispatcher. This is a known reliability pattern once you care about not losing events. citeturn7search0turn7search30  

### Horizontal scaling mechanics on Cloud Run

Cloud Run scales by adding instances, and each instance can process multiple concurrent requests (configurable up to 1000). This is ideal for a stateless API that’s mostly I/O bound (DB calls, Pub/Sub publish, Redis). citeturn2search0turn3search21  
Practically:

- Tune concurrency conservatively for endpoints that hold long-lived streams (SSE/WebSockets), because each open connection consumes resources and is limited by the request timeout anyway. citeturn2search0turn7search2turn0search0  
- Prefer “short request → enqueue → stream from persisted events” rather than “long request does all the work”, because Cloud Run requests have a maximum timeout of 60 minutes. citeturn7search2turn0search0  

## Reuse refactor or rewrite

**Blunt recommendation:** **largely rewrite the hosted server/runtime**, but **reuse** the TypeScript domain logic by extracting shared libraries. Treat the current Bun/TypeScript CLI/server (SQLite + in-memory state) as a prototype/reference implementation, not the hosted core. Align the hosted product with your `remote/` direction (Postgres + Redis + stateless control plane). citeturn4search0turn6search0turn6search15

Why this is the most practical path:

- **SQLite + in-memory state is fundamentally mismatched** with multi-tenant hosted scaling: you need a central durable DB (Cloud SQL Postgres) and instances that can be killed/replaced at any time, which is the Cloud Run model. citeturn6search15turn4search0  
- Hosted Nessie needs **async execution with retries** (Pub/Sub/Tasks), and those systems assume idempotent handlers and persisted state transitions—not a long-lived in-process coordinator. citeturn5search17turn7search10turn1search1  
- The “hard edges” that shape the architecture (60-minute request timeout, best-effort affinity, streaming constraints) mean you must design around reconnection and durable cursors; bolting that onto a CLI-style in-memory design tends to create fragile hybrids. citeturn7search2turn3search1turn5search28  

What to reuse (the “good” reuse):

- Extract your domain model, MCP abstractions, tool invocation schemas, and permission logic into shared TypeScript packages used by both hosted services and the CLI. This keeps the open-source story coherent while letting the hosted plane be re-architected properly. citeturn5search1turn5search9  

## Data and storage boundaries

The clean boundary rule: **Postgres is truth**, **Redis is non-authoritative TTL state**, **GCS is bytes**, **Pub/Sub is intent/events**, **memory is per-request only**. The goal is that you can kill any instance at any time and not lose correctness. citeturn4search0turn6search0turn4search7turn5search17turn6search15

### What belongs in PostgreSQL

Postgres should contain anything you need to be durable, queryable, auditable, and correct under retries:

- **Orgs / teams / channels / RBAC**, including membership history and audit timestamps. citeturn4search0  
- **Agents & tools:** agent definitions, tool manifests (as JSON), versioning, capability scopes, and compatibility constraints. citeturn4search0  
- **Messages (chat threads):** immutable message rows + indexes. Consider **partitioning** once message volumes are large enough to create vacuum/index pain. citeturn4search2  
- **Tasks & run state:** runs, steps, step outputs, retry counters, and deterministic “next step” scheduling metadata. citeturn4search0turn5search17  
- **Approvals:** approval requests, approver identity, decision, timestamp, and “step-up satisfied” references. citeturn4search0  
- **Secrets metadata:** secret name, scope (org/team/project/agent), rotation policy metadata, last accessed, and **encrypted secret payload** (ciphertext + encrypted DEK + key ID), using envelope encryption patterns with Cloud KMS as your KEK store. citeturn2search3  
- **Token ledger:** append-only ledger rows per billing subject (org/project/agent/run) with immutable facts (model, tokens, cost basis, timestamp). Partition by time once it is large. citeturn4search2turn4search0  
- **Translation metadata:** translation jobs, source/target language, provenance (model/API used), cost attribution, references to produced artefacts. citeturn4search0  
- **Idempotency & dedup records:** API idempotency keys and processed Pub/Sub event IDs. citeturn5search17turn7search1  

Multi-tenant enforcement: add Postgres Row-Level Security (RLS) later as defence-in-depth (policies with `CREATE POLICY`, enabled per table). It is a real Postgres feature designed for isolating rows by conditions such as tenant attributes. citeturn3search7turn3search19  

### What belongs in Redis

Redis should only contain state you can lose without corrupting correctness:

- **Ephemeral session buffers** for streaming run output (e.g., “last 5 seconds of tokens”), with TTL. citeturn6search0  
- **Rate limits / quotas** (per org/team/user) as counters with TTL to protect the database and your wallet. citeturn6search0turn6search5  
- **Step-up verification state:** “user X has elevated privileges for org Y until time T” stored as a short-lived key so you don’t need sticky sessions. citeturn6search0turn1search3  
- **Distributed leases** for worker coordination (if needed): “run step claimed until time T” as a backstop, not the source of truth. citeturn6search0turn5search17  

Operationally: Memorystore supports TLS in-transit encryption and Redis AUTH; enable both, because you will put sensitive ephemeral tokens here. citeturn6search0turn6search5turn6search1  

### What belongs in GCS

Use GCS for large payloads and unstructured artefacts, referenced by IDs in Postgres:

- **Uploaded files** (user attachments, datasets for tools, model input files). citeturn4search7  
- **Run artefacts** (generated files, logs too large for DB, zipped trace bundles). citeturn4search7  
- **Large exports** (billing exports, audit export snapshots). citeturn4search7  

Use signed URLs so clients upload/download directly with time-limited access (reduces load on API and keeps Cloud Run stateless). citeturn2search1turn4search7  

### What belongs in the queue or event stream

Pub/Sub should carry *intent* and *facts for asynchronous processing*, not your only copy of reality:

- `run.requested`, `step.requested`, `tool.call.requested`, `approval.requested`, `translation.requested`, plus internal “run.event.appended” style notifications. citeturn5search17turn0search5  
- Use ordering keys where you need sequencing and dead-letter topics where you need to prevent jams. citeturn1search0turn1search8  
- Assume redelivery and implement idempotency; Pub/Sub retry policy redelivers when ack deadlines expire or on negative ack. citeturn7search10turn5search17  

### What belongs in memory only

In-memory state should be treated as an optimisation, never correctness:

- Per-request caches, parsed manifests, open SSE connection maps (connection → run cursor), small batching buffers. If the instance dies, clients reconnect and resume from Postgres/Redis. citeturn6search15turn5search28turn4search0  

**Anti-patterns to call out explicitly:**

- Storing “live run state” only in memory and expecting session affinity to save you (Cloud Run explicitly warns affinity is best-effort). citeturn3search1  
- Storing blobs in Postgres because “it’s easier” (you lose cheap/object storage semantics and complicate DB scaling; GCS is designed for object storage in buckets). citeturn4search7  
- Expecting push-delivered Pub/Sub to be exactly-once (exactly-once is limited to pull subscriptions). citeturn5search2turn0search5  

## Cost and complexity tradeoffs and upgrade path

The cost/complexity strategy that matches “open-source, paid, multi-tenant” is: start with a **small number of managed services**, then add complexity only when you hit clear triggers (connection limits, DB write saturation, realtime scale, workload isolation). citeturn6search15turn4search0turn5search17turn6search0

### Simplest stack that still works well

The simplest credible hosted stack is:

- Cloud Run (API) + Cloud Run (worker)  
- Cloud SQL Postgres (regional HA)  
- Pub/Sub  
- GCS  
- Identity Platform  
- Cloud Logging/Monitoring/Trace citeturn6search15turn4search4turn0search5turn4search7turn1search11turn3search6  

Add Memorystore Redis as soon as you need: reliable rate limits, ephemeral session buffers, or high-frequency ephemeral coordination that would otherwise hammer Postgres. Redis supports TLS in-transit encryption and AUTH, which makes it viable for short-lived sensitive session tokens. citeturn6search0turn6search5  

### What upgrades later and what triggers it

**Cloud Run → GKE**  
Move from Cloud Run to GKE when you have requirements that Cloud Run makes awkward:

- You need **connections lasting longer than the 60-minute request timeout** (Cloud Run requests max at 3600 seconds), or you need advanced connection routing beyond best-effort affinity. citeturn7search2turn3search1turn0search0  
- You need heavy custom networking, sidecars everywhere, or very high sustained realtime fanout that benefits from dedicated always-on pods and fine-grained autoscaling. (Cloud Run does support multi-container deployments, but you should not assume “Kubernetes features” wholesale.) citeturn6search6turn6search15  

**Postgres single instance → HA + replicas + partitioning**  
- Enable **regional HA** immediately for a paid product; Cloud SQL creates a regional instance for HA configuration. citeturn4search4  
- Add **read replicas** when read load (analytics dashboards, admin queries, search-like features) starts competing with write latency; be explicit that “read replicas are unable to failover” (failover requires DR replica) so read replicas are not your HA mechanism. citeturn4search1  
- Add **partitioning** when message tables, run-event tables, or token ledger hit operational pain (slow deletes, bloated indexes, vacuum overhead). Postgres declarative partitioning is designed for this. citeturn4search2  

**Redis optional → Redis required**  
Redis becomes “required” when:

- You must enforce per-tenant rate limits without adding DB writes on hot paths. citeturn6search0  
- You need reliable ephemeral “step-up” and interactive session tokens with tight TTLs and fast revocation. citeturn6search5turn1search3  
- You want to reduce Postgres load for high-frequency, low-value ephemeral states (cursor checkpoints, short output buffers). citeturn6search0turn4search0  

**Single API service → split control plane, workers, and gateways**  
Split services only when you have clear bottlenecks:

- If SSE/streaming connections dominate the API’s connection and memory footprint, split a **stream gateway** from the CRUD/control plane so autoscaling and deploy cadence are independent. (Cloud Run supports streaming responses, but long-lived connections change scaling maths.) citeturn5search28turn2search0  
- If agent execution becomes noisy neighbour for API latency, keep workers fully separate (different Cloud Run service, distinct autoscaling settings, separate Pub/Sub subscriptions). citeturn0search5turn2search0  

**Billing model changes on Cloud Run**  
Cloud Run has request-based vs instance-based billing modes; CPU allocation differs by billing setting (CPU only during request processing vs CPU for the entire instance lifecycle). Use request-based billing for typical APIs; consider instance-based only when you have a measured need (e.g., always-on CPU workloads). citeturn3search24turn3search4  

## First production milestone

Minimum deployable architecture that still honours your constraints (stateless servers + durable DB + scalable runs):

- **One Cloud Run service: `nessie-api`**  
  - Handles auth, org/team/channel CRUD, agent/tool registry, chat endpoints, run creation, approvals, signed URL issuance, and SSE streaming endpoints.  
  - Configured with request timeout up to 3600 seconds to support longer SSE streams, but clients must reconnect and resume with cursors. citeturn7search2turn5search28  
- **One Cloud Run service: `nessie-worker`**  
  - Triggered from Pub/Sub via Eventarc.  
  - Executes run steps with strict idempotency, writing every state change to Postgres. citeturn0search5turn5search17turn7search10  
- **Cloud SQL Postgres (regional HA)**  
  - IAM DB authentication enabled.  
  - Use the Cloud SQL Node.js connector from both services. citeturn4search4turn0search2turn6search11turn6search15  
- **Pub/Sub**  
  - Topics: at minimum `run.requested` and `step.requested`; add DLQ topics early. citeturn1search8turn5search17  
- **GCS**  
  - Buckets for uploads and artefacts; signed URLs for direct client transfer. citeturn4search7turn2search1  
- **Identity Platform**  
  - Enable MFA for user accounts; integrate JWT verification into API. citeturn1search11turn1search3  
- **Cloud Ops (Logging/Monitoring/Trace) + OpenTelemetry**  
  - Emit structured logs and traces; OTLP ingestion for Trace is now supported/recommended. citeturn3search6turn3search2  

If you must shave one service off for the very first deploy, you can temporarily run worker logic inside the API container behind a Pub/Sub-triggered route, but it’s cleaner (and usually not harder) to split API vs worker as separate Cloud Run services from day one because they scale differently. citeturn2search0turn0search5  

## What not to build yet

To keep Nessie open-source friendly and ship a hosted product quickly, avoid building “architecture cosplay” before the metrics force it.

Do **not** build these yet:

- A full microservices zoo (gateway, ingestion, orchestrator, scheduler, notifier, presence, etc.). Start with API + worker; split only when you have measured bottlenecks. citeturn2search0turn0search5  
- A WebSocket-first realtime layer as the primary UX. On Cloud Run, WebSockets are constrained by the same request timeout (max 60 minutes) and reconnection isn’t sticky; SSE + cursor resume is cheaper and simpler initially. citeturn0search0turn7search2turn3search1turn5search28  
- Per-tenant databases/schemas on day one. A single shared Postgres database with strong tenant scoping (and later RLS as defence-in-depth) is the simplest credible starting point; RLS can be added later once your tenant model is stable. citeturn3search7turn3search19turn4search0  
- “Exactly-once everywhere” delivery assumptions. Pub/Sub defaults to at-least-once; exactly-once is limited (pull subscriptions), so your core correctness model should be idempotent transitions, not fragile guarantees. citeturn5search17turn5search2  
- A bespoke workflow engine for deployment workflows. When you reach that phase, first evaluate whether Cloud Run Jobs (long tasks) plus Pub/Sub orchestration is sufficient; Jobs provide run-to-completion execution with configurable task timeouts. citeturn1search2turn5search17  
- Storing secret values unencrypted in Postgres (or worse: in Redis). Use envelope encryption with Cloud KMS for app-layer encryption, and lean on Secret Manager only where it fits operationally. citeturn2search3turn2search14turn6search0
