# Horizontal scaling: making the API, worker and gateway stateless for Google Cloud

> Status: plan, 2026-09-05. Findings with `file:line` evidence are in
> [audit.md](audit.md); this page is the decision and the work order.

## Table of Contents

- **[audit.md](audit.md)** — the consolidated findings: what is already
  multi-instance safe, then every BLOCKER, DEGRADED and INFO item per area
  with `file:line` evidence. The plan tables below cite its numbering.
- This page — target topology, the nine invariants, Phases 0–5, cutover and
  delivery mechanics.

## The one-paragraph version

Nessie is closer to horizontally scalable than its single-container
deployment suggests. The job queue, realtime fan-out, scheduled triggers,
thread serialisation, exactly-once mail sends, OAuth flows, executor daemons
and cloud-browser rows were all built on Postgres primitives that already
work across instances. What blocks running N copies is a short list of
concrete defects: neither the API nor the gateway handles `SIGTERM`, the
worker abandons in-flight runs on shutdown and replays them from scratch
when another instance re-claims them, a handful of boot-time and request-time
writes are read-then-write with no lock or unique key, a few authorities
(rate limits, the bootstrap token, the cloud-browser connect capability) live
in process memory, and the deployment configuration assumes one host. The
plan below fixes those in dependency order, proves each fix with a
two-instance harness that runs in CI and on the current Hetzner host, and
only then moves the platform to Google Cloud.

## Target topology

| Component | Google Cloud service | Scaling | Must be true first |
|---|---|---|---|
| API (`api/`) | Cloud Run service, gen2, CPU always allocated, request timeout 3600 s, session affinity off | Autoscale on concurrency, min instances 1 | Phases 1–2 |
| Worker (`worker/`) | Cloud Run worker pool (no ingress, always-on CPU); GKE Autopilot Deployment if worker pools are not available in the region | Autoscale on `queue_jobs` pending depth, min 1 | Phases 1–3 |
| Gateway (`gateway/`) | Cloud Run service | Autoscale on concurrency, min 0 | Phase 1 (drain only) |
| Postgres + pgvector | Cloud SQL for PostgreSQL 17, regional HA, managed connection pooling in front | Vertical | Phase 4 (pool knobs, LISTEN on a direct connection) |
| Object storage | GCS bucket via the existing streaming S3 backend on the S3-interop endpoint | n/a | Phase 4 smoke test |
| Migrations and reconcile | Cloud Run Job on the same image, gating every rollout | One-shot | Phase 2 (boot work moved out of boot) |
| Config and secrets | `nessie.config.json` baked into the image; everything secret as Secret Manager env references | n/a | Phase 4 |
| Queue and realtime | Postgres (`PgQueueProvider`, `PgRealtimeTransport`) | n/a | Keep. No Pub/Sub, no Redis |

Two decisions are settled here rather than left open:

- **Postgres stays the queue and the realtime bus.** Everything is built on
  it and it is correct at N; the polling cost is about 36 statements per
  second per worker instance, which is fine to at least twenty workers. The
  unwired `pubsub-queue.ts`, the Pub/Sub terraform module and the Redis config
  stub are deleted rather than finished.
- **The worker does not become an HTTP push consumer.** It keeps its polling
  loop and runs on a compute shape that allows no ingress and always-on CPU.
  Drain is solved by checkpointing inside sixty seconds, not by asking the
  platform for a 45-minute grace period.

## The invariants (become `docs/standards/horizontal-scaling.md` in Phase 0)

1. No module-scope mutable state that a second instance would need. A cache
   is allowed only if it is read-through, bounded, has a TTL, and is never an
   authority for a decision.
2. Every periodic job either claims its work (conditional UPDATE,
   `FOR UPDATE SKIP LOCKED`, window-bucketed idempotency key) or runs its
   body under `withSweepLock`, a `pg_try_advisory_lock` helper in `@nessie/db`.
3. Every enqueue passes an idempotency key, or the handler's writes are
   idempotent through a unique constraint and the topic says so in a comment.
4. Every long-running handler is resumable: a fencing token on the run and a
   checkpoint at each iteration boundary.
5. Boot connects and listens. Seeding, backfills and reconciliation live in
   the post-migrate job.
6. `SIGTERM` drains within the configured grace: the API stops accepting,
   ends streams with a retry hint and closes within 60 s; the worker stops
   claiming, checkpoints in-flight runs within 60 s, and acks or nacks.
7. No local disk beyond per-request scratch that the same request deletes.
   The `filesystem` storage provider, the `docker` execution provider and the
   `file_*` builtins are fatal at boot outside `local` mode.
8. Instance identity is a UUID minted at boot, never `HOSTNAME`. Rows keyed
   by it carry a heartbeat and are reaped.
9. Realtime persists and notifies in one transaction holding a per-scope
   advisory lock across both, so within a watermark's span commit order is id
   order, and a listener never advances a connection watermark past an id it
   did not deliver.

## Phase 0 — Guardrails and the two-instance harness

Do this first so every later phase lands with proof.

| # | Item | Size |
|---|---|---|
| 0.1 | `docs/standards/horizontal-scaling.md` with the nine invariants, routed from `AGENTS.md` → Architecture. Fix `docs/the-agents.md:1297, 1687` to describe the lease-based scheduler that actually exists. | S |
| 0.2 | ESLint ratchet in the root config, same shape as the egress block: module-scope `new Map`/`new Set`/`let` in `api/src` and `worker/src` fail lint unless the file is on an allowlist that shrinks as phases land. | S |
| 0.3 | `infrastructure/compose/docker-compose.multi.yml` override: `api` × 2 and `worker` × 2 against one Postgres and MinIO, with Caddy round-robining the API. `pnpm dev:multi` runs it locally. | S |
| 0.4 | CI job `multi-instance-smoke`: the existing mock-LLM smoke through the two-instance stack, plus a chaos step that sends `SIGTERM` to one worker mid-run and one API mid-stream and asserts no duplicate messages, no run left in `running`/`waiting_approval` without a live lease, and SSE resumes with no sequence gap. Required check once Phase 3 lands; advisory before. | M |
| 0.5 | Hetzner soak: after Phase 2, `redeploy.sh` keeps `api` and `worker` at two replicas permanently. The blue-green swap already runs two API replicas briefly, so several of these defects are latent in production today. | S |

## Phase 1 — Lifecycle, fencing and platform basics

Everything else assumes an instance can be killed safely.

| # | Fixes | Item | Size |
|---|---|---|---|
| 1.1 | 1.1, 2.1-drain, 8.3 | API and gateway `SIGTERM`/`SIGINT` handlers: stop accepting, write `event: shutdown` + `retry: 2000` and end every SSE connection, close every WebSocket with 1012, then `app.close()` with a hard exit timer under the grace period. The hub already tracks its connections. | M |
| 1.2 | 5.1 | Worker drain: `subscribe` returns a handle; `stop()` sets a draining flag so no topic claims again, awaits in-flight handlers under a deadline, then closes the pool. Pass the `AbortSignal` into `handler(job)` so the agentic loop reaches its cancel/checkpoint path. Handle signals in the embedded case too. | M |
| 1.3 | 5.3 | Run fencing: `runs.executor_token` set by `claimRunForExecution` in a conditional UPDATE (`pending`, or same token, or heartbeat stale), carried on every terminal write, and lock-renewal failures fail the handler after two misses instead of logging. | M |
| 1.4 | 5.4 | Queue claim honours `max_attempts` on the timeout arm; a sweep dead-letters timed-out jobs at the cap. | S |
| 1.5 | 1.9 | Readiness: the load balancer targets `/api/health` (or a new readiness that only does `SELECT 1`); the worker-heartbeat signal stays on `/api/ops/health`. | S |
| 1.6 | 1.6, 1.11 | Config: `NESSIE_DB_POOL_MAX`/`_MIN` env mappings; `PORT` accepted as a fallback for `api.port`; the API's memory pool merged into the realtime pool. | S |
| 1.7 | 5.7 | Instance identity: a boot UUID replaces `HOSTNAME` for runner labels; the lease sweep deletes `execution_runners` whose heartbeat is older than an hour. | S |

## Phase 2 — Remove every per-process authority and boot-time race

| # | Fixes | Item | Size |
|---|---|---|---|
| 2.1 | 1.3 | Delete `api/src/lib/rate-limit.ts`; add `rate_limit_buckets` rules for thread messages, mailbox discovery and agent mutations to the Postgres `RateLimiter`. One limiter. | S |
| 2.2 | 1.2 | Bootstrap token becomes a single Postgres row claimed with `UPDATE … WHERE consumed_at IS NULL RETURNING`, created under the existing bootstrap advisory lock. | S |
| 2.3 | 1.4, 1.7 | Boot work leaves boot: `pnpm --filter @nessie/api reconcile` runs policy seeding, the protected-grant backfill, PA default grants and the credential sweep after `migrate deploy` in `redeploy.sh` and in the Cloud Run Job. Policy seeding gains `pg_advisory_xact_lock` per organisation and a nullable `seed_key` column with a partial unique index on `(organization_id, seed_key)`. Not an index on the rule's semantic columns: two rules may legitimately differ only in their conditions or priority, so only rules the seeder itself writes are keyed. Boot then only connects and listens. | M |
| 2.4 | 1.5 | Approval expiry: claim and terminalisation in one transaction, and the sweep also picks up `expired` approvals whose run is still `waiting_approval`. | S |
| 2.5 | 4.1 | Scoped settings: `pg_advisory_xact_lock` on the setting's target inside the existing transaction, so the loser of a concurrent save updates instead of failing. No new index and no collapse migration — the partial unique indexes already shipped in `20260903130000_scoped_settings` make duplicates unrepresentable (see the corrected audit entry). | S |
| 2.6 | 9.1 | Board-source apply: `pg_advisory_xact_lock(hashtext(sourceId), hashtext(externalId))` at the top of the transaction; the intake route enqueues with the provider delivery id as the idempotency key. | S |
| 2.7 | 8.1 | Cloud browsers: encrypted `connect_capability` and `origin_gate` columns on `cloud_browser_sessions` (same sealing as executor command payloads); the in-memory pool becomes a socket cache that re-attaches from the row. | M |
| 2.8 | 2.1 | Realtime ordering: persist and `pg_notify` in one transaction on one client for both the SSE and WS lanes (the hub stops persisting through Prisma); the listener delivers a lower id instead of dropping it and never advances the watermark past it. | M |
| 2.9 | 2.6, 2.3, 5.5, 5.9, 5.10 | `withSweepLock` in `@nessie/db`; the four API maintenance sweeps, `realtime_events` pruning, registry sync (drop the process flag and the per-boot kickoff), tombstone reconcile and stranded reconciliations run under it or gain a conditional claim. | S |
| 2.10 | 4.2, 4.3 | Budget and storage-quota gates in `enforce`/`degrade` modes take a `pg_advisory_xact_lock` on the governing scope for check-plus-admission. The soft-cap comment goes. | M |

## Phase 3 — Run durability across instance loss

The largest phase, and the one with the most user-visible payoff: today a
worker restart during a deploy already replays whatever was in flight.

| # | Fixes | Item | Size |
|---|---|---|---|
| 3.1 | 5.2 | Crash checkpoints: `persistRunCheckpoint` with reason `crash` at every loop-iteration boundary and before each tool batch, carrying the live invocation accumulator; a re-claimed run resumes from it instead of the prompt. | L |
| 3.2 | 5.2 | Tool idempotency: a `run_tool_effects (run_id, tool_call_id)` unique row written before any side-effecting builtin executes; a replay that finds the row short-circuits to the recorded result. Start with mail, tasks, cards, calendar, Slack and MCP calls. | L |
| 3.3 | 2.5 | Document-session reaper: `streaming`/`saving` sessions whose run has no live executor token flip to `failed` from the API maintenance sweep. | S |
| 3.4 | 5.13 | `push.dispatch` enqueues carry an idempotency key and the handler claims a delivery row before sending. | S |
| 3.5 | 2.2 | LISTEN reconnect re-reads the backlog for every registered connection from its watermark. **Still open, and NOT what the chaos smoke's SSE check was failing on** — that check demanded replay of the five event types the hub deliberately never replays, and no LISTEN drop occurs in its scenario at all. 2.2 is a real gap on its own terms: a dropped LISTEN connection, whose sockets keepalive keeps open so no client reconnect fires. | M |
| 3.6 | — | Decide whether `delegate` may keep declaring itself `safe`. It escapes the tool-effect ledger on that flag alone, so a resumed run re-issues a delegation and the sub-agent's own effectful calls are never claimed. Either claim it, or restrict the sub-agent's toolset to genuinely read-only tools and say so where the flag is set. | S |

## Phase 4 — Google Cloud platform work

Nothing here is speculative; each line maps to a finding in areas 6 and 7.

| # | Fixes | Item | Size |
|---|---|---|---|
| 4.1 | 1.10, 6.1, 6.3, 6.2 | **Done** for the three refusals. `filesystem` storage is fatal in `loadConfig`, so neither the API nor the worker starts with it outside `local`; the `docker` execution provider and the `file_*` builtins are per-organisation database rows rather than configuration, so they are refused at their worker chokepoints (`control/execution/providers.ts`, `run/sandboxed-tool-dispatch.ts`) — the inventory and the wording are one file, `packages/config/src/local-only.ts`. **Residual:** creating a `docker` execution template still succeeds and is merely inert until launched, because its write door (`api/src/services/execution-environments.ts`) is already past the 500-line cap. **Still open:** delete the legacy buffer-only `gcs` backend. | S |
| 4.2 | 6.5 | Storage smoke test: the streaming S3 backend against a real GCS bucket over the S3-interop endpoint with HMAC keys, including a multi-GiB multipart upload and a signed download. If multipart fails on interop, build a streaming native GCS backend instead; decide on the test result, not on reading. | S or L |
| 4.3 | 7.5, 7.4 | One image: the worker is a `command` override of `nessie-app`; `nessie.config.json` is copied into the image and `NESSIE_CONFIG_PATH` points at it; provider metadata stays in the JSON, secrets never do. | S |
| 4.4 | 7.8 | `google_cloud_run_v2_job` for `migrate deploy` + `reconcile`, with the `RESOLVABLE_FAILED_MIGRATIONS` repair moved into the job's entrypoint script. | M |
| 4.5 | 7.1, 7.2, 7.3, 7.6, 7.7 | Terraform rewritten from scratch for the topology above: Cloud SQL 17 with pgvector and managed pooling, GCS, Secret Manager, the API service with CPU always allocated and the four missing env vars, the worker pool, the migrate job, the external HTTPS load balancer. The Pub/Sub and Redis modules go. `NESSIE_API_TRUSTED_PROXY_HOPS` is measured against the real load balancer, not assumed. | L |
| 4.6 | — | `.github/workflows/deploy-gcloud.yml`: build to Artifact Registry, run the migrate job, deploy revisions with no traffic, shift traffic after the public-endpoint gate, roll back on failure. A staging project first. | M |
| 4.7 | 7.9 | Team hosts: if per-organisation subdomains are turned on, they need Certificate Manager with DNS authorisation. Documented as a constraint; not built here. | — |
| 4.8 | — | `docs/deployment/gcloud.md` as the authoritative runbook; `docs/deployment.md` gains the chapter; the Hetzner chapters stay until cutover. | S |
| 4.9 | — | **Neither the API nor the worker can drain inside a Cloud Run grace.** Cloud Run's container runtime contract gives services, jobs AND worker pools the same fixed ten seconds between `SIGTERM` and `SIGKILL`, and it is not configurable: `google_cloud_run_v2_worker_pool`'s `template` block exposes no termination-grace argument, so the worker does not escape the ceiling by being a pool (the worker module's comment claimed it did; corrected). The API's `shutdownTimeoutMs` defaults to 25 s and the terraform pins `NESSIE_SHUTDOWN_TIMEOUT_MS=9000` as a stopgap; the worker's budget is 40 s (25 s drain + 5 s abandon-settle + 10 s teardown) and has no stopgap at all, so every scale-in cuts it off mid-drain. Invariant 6 budgets 60 s. Decide between shortening both drains to fit ten seconds and moving to a compute shape with a configurable grace (GKE `terminationGracePeriodSeconds`). Verify the ten seconds against a real project before committing to the second option — it is documentation, not a plan output. | M |
| 4.10 | — | Admin and web have no Google Cloud story. The load balancer built in 4.5 fronts the API only, and `VITE_API_BASE_URL` is baked into the admin image at build time, so the SPA cannot be promoted between environments. Serve them from GCS or a second Cloud Run service behind the same load balancer, and decide whether the API base URL becomes runtime configuration. | M |
| 4.11 | — | The deploy's public-endpoint gate runs *after* the traffic shift, not before, because the API takes `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` and a tagged candidate revision therefore has no externally reachable address. Add a URL-map host rule for the revision tag so a candidate can be proven through the real load balancer before it takes traffic. | S |
| 4.12 | 7.7 | `config.queue.provider` still accepts `'pubsub'` and `deriveRuntimeCapabilities` still derives `hasPubSub` from it. 5.9 parks retiring that enum value behind the Pub/Sub terraform module, which 4.5 has now deleted, so the precondition is met. | S |
| 4.13 | — | Set `NESSIE_WORKER_DRAIN_TIMEOUT_MS` explicitly on the worker. It is read straight from `process.env` in `worker/src/lifecycle.ts` (deliberately, not through `@nessie/config`), and the terraform sets only `NESSIE_SHUTDOWN_TIMEOUT_MS`, which is the API's budget and which the worker never reads — so the knob an operator would reach for does nothing. The other half of this row, *give the pool a grace longer than the budget*, cannot be done: there is no such field, and no configurable grace exists. That half is now part of 4.9. | S |

Rows 4.5, 4.6 and 4.8 are delivered on `claude/hs-p4-gcloud-terraform`; they
are configuration and documentation only and nothing has been applied.

## Phase 5 — Cleanups that N instances make worse

| # | Fixes | Item | Size |
|---|---|---|---|
| 5.1 | 2.4 | Stop writing `user_presence.connections` and delete `isUserActive`; presence already resolves from `lastSeenAt`. Dropping the column itself is 5.10. | S |
| 5.2 | 5.8, 8.2 | Lease expiry enqueues `execution.environment.terminate` for instances with a provider ref. | S |
| 5.3 | 5.6 | Automatic-membership rate limits move to a Postgres token-bucket row with a conditional UPDATE. | M |
| 5.4 | 2.7, 2.9 | NOTIFY payloads over the cap notify by id and the listener re-reads the row; replay returns a truncation marker the client turns into a REST bootstrap. `thread_stream_events` gets the same retention as `realtime_events`. | M |
| 5.5 | 2.8 | Client backoff treats a connection that lived under five seconds as a failure; scope resolution is cached per connection. | S |
| 5.6 | 1.8 | Logout invalidates the local revocation cache like session-delete does; revocations publish on the realtime channel so other replicas drop the sid immediately. | S |
| 5.7 | 6.4 | Signed-URL redirect for downloads above a size threshold. | M |
| 5.8 | 9.2 | Trigger intake and DeepSignal insight events enqueue and ack like every other receiver. | M |
| 5.9 | 1.13 | Per-process limiter stats on `/api/ops/health` are read from `rate_limit_buckets`. (The three deletions this row also carried — `apiUsageTracker` (1.12), `pubsub-queue.ts` with the worker's fallback warning (5.14), and the Redis config stub with its `hasRedis` capability — have landed. `config.queue.provider` still accepts `'pubsub'`; retiring that enum value goes with the Pub/Sub terraform module in 4.5.) | S |
| 5.10 | 2.4 | Drop the now-dead `user_presence.connections` column in a deploy of its own. Precondition: 5.1 is deployed and every replica has cycled onto a build that never writes it — migrations run before the blue-green swap, so a drop shipped alongside 5.1 would fail the still-serving previous build's presence upsert with P2022. | S |
| 5.11 | — | Fence the queue's settle path. `acknowledge` and `nack` both match `WHERE id = $1` alone, while `renewLock` beside them is fenced on `status = 'processing'`. A worker whose lock expired can settle a job another worker has re-claimed and is running: a stale `nack` resets it to `pending` so a third worker starts it, a stale `ack` marks done a job still in flight. Fence both on the claim's `attempt`, and make a refused settle observable rather than a silent no-op. | S |
| 5.12 | — | A user-requested terminate of a `docker` execution environment outside `local` can be claimed by a worker that is not the container's host, get `No such container`, and record `terminated` for a container still running. Bounded, because provisioning docker outside `local` is now refused, so only pre-upgrade containers are exposed — but the database should carry the honest state the operator message currently carries only in prose. | S |
| 5.13 | — | `persistProvisionSuccess` returns `false` without throwing when either of its two conditional writes matches zero rows, so the transaction commits whatever partial state they produced instead of rolling back. A `throw` inside the callback is the one-line fix, but it changes the failure path's control flow and deserves its own change. | S |

## Order, dependencies and effort

| Phase | Depends on | Effort (S=½d, M=2d, L=5d) |
|---|---|---|
| 0 Guardrails | — | 4 d |
| 1 Lifecycle | 0.3 | 7 d |
| 2 Authorities | 1.2, 1.3 | 9 d |
| 3 Run durability | 1.2, 1.3, 2.9 | 13 d |
| 4 Platform | 2.3 (reconcile job), 4.2 result | 12 d |
| 5 Cleanups | any time after 1 | 8 d |

Phases 1 and 2 are the gate for running two replicas on Hetzner. Phase 3 is
the gate for autoscaling anywhere. Phase 4 can start in parallel with Phase 3
once the reconcile job exists, because the terraform and workflow work does
not touch application code.

## Cutover

1. Soak at two API and two worker replicas on Hetzner for a week with the
   chaos step from 0.4 run nightly against production-shaped data in staging.
2. Stand up the GCloud staging project from the Phase 4 terraform; run the
   full CI suite and the mock-LLM smoke against it.
3. Copy MinIO to GCS with `rclone` (keys are stable, so attachments need no
   rewrite); migrate Postgres with Database Migration Service in continuous
   mode so the cutover window is a DNS switch, with `CREATE EXTENSION vector`
   verified on the target first.
4. Point `api.nessie.works` at the load balancer, keep Hetzner warm for a
   rollback window, then retire it and the Hetzner deploy workflow.
   Infisical stays where it is; it is reachable over the public internet and
   the token is a plain env var.

## Delivery mechanics

One worktree and one PR per table row, or per small group of rows that
share a migration. Every PR that touches a finding also extends the
two-instance smoke with the scenario that would have caught it, and moves
the file off the lint allowlist. Nothing merges on CI green alone once 0.4
is a required check: the chaos step has to pass too. Implementation is
delegated; planning, review, gates and landing stay with the orchestrator.

## What this plan deliberately does not do

- It does not introduce Redis, Pub/Sub, a leader-election service or a
  dedicated realtime gateway. Each was considered and each would add a moving
  part to solve a problem Postgres already solves at the scale in question.
- It does not rewrite the executor daemon, the desktop app or the mobile
  clients. Their server-side contracts are already instance-agnostic.
- It does not change the team-host wildcard design; it records the
  certificate constraint for when that feature is enabled.
