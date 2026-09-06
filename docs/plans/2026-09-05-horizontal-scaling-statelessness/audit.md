# Horizontal-scaling audit — consolidated findings

Companion to [overview.md](overview.md). Audited 2026-09-05 against `main`
at `e064a136` by nine parallel reviewers, one per area; the orchestrator
re-verified every contradiction and every claim the plan depends on.
Everything below cites `file:line` on that commit.

Severity: **BLOCKER** = wrong behaviour, lost or duplicated work, or data
corruption once more than one instance runs. **DEGRADED** = works, but
wastefully or with a bounded staleness that N instances widen. **INFO** =
worth knowing for the GCloud move; not a statelessness defect.

## What is already multi-instance safe

Most of the platform was built on shared-store primitives, and that is why
the fix list is bounded. These are verified, with the evidence:

- **Job queue.** Claim is `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP
  LOCKED)` with a 5-minute lock renewed at one third
  (`packages/runtime/src/queue.ts:196-253`). Enqueue upserts on
  `idempotency_key` (`packages/db/src/queue.ts:24-49`). Every
  `enqueueRunExecution` call site passes a key (`run:<id>`,
  `run:batch:<id>`, `run:continue:<id>`, `subtask:…`, `mailbox:…`,
  `agent-email:…`, orchestrate `messageId+agentId`).
- **Realtime fan-out.** Every publish goes through `pg_notify` on
  `nessie_realtime`; the publisher persists once and carries the row id,
  listeners never append (`api/src/realtime/hub.ts:145-153, 490-509`;
  `packages/runtime/src/realtime.ts:149-160, 325-351, 470-499`). All hub
  state is per connection (`hub.ts:15-38, 336-350`). Clients reconnect with
  `Last-Event-ID` and re-bootstrap (`admin/src/facades/realtime/event-stream.ts:43-88`).
- **Cancellation.** An API replica writes `run.cancelRequestedAt`
  (`api/src/services/runs.ts:174, 202`); the owning worker polls it between
  iterations (`worker/src/run/execute/agent-loop.ts:373-378`) and every
  second while a document stream is open
  (`worker/src/run/execute/document-cancel-poll.ts:34-53`). No in-process
  abort path.
- **Scheduled triggers.** Per-row lease claim under `FOR UPDATE SKIP LOCKED`
  with `scheduler_claim_id` (`worker/src/control/trigger-scheduler.ts:41-77`),
  claim-scoped finalize (`:112-123`), and duplicate runs blocked by the
  `(trigger_id, dedupe_key)` unique index (`api/prisma/schema.prisma:3283`).
  `docs/the-agents.md:1297, 1687` describe a `pg_advisory_lock` leader
  election that does not exist; the lease design is better and the doc is
  wrong.
- **Thread serialisation and workflow overlap.**
  `pg_advisory_xact_lock(agent, principal, thread)`
  (`packages/db/src/thread-serialization.ts:72`) and
  `pg_advisory_xact_lock(installationId, 'workflow_overlap')`
  (`packages/team-admin/src/workflow-concurrency.ts:90-103`).
- **Exactly-once sends.** Gmail drafts `sending→dispatching`
  (`packages/team-admin/src/gmail-draft-dispatch.ts:87-108`), agent mail
  `queued→sending` (`worker/src/control/agent-email/outbound.ts:257-262`),
  mailbox dispatch CTE claim (`worker/src/control/mailbox.ts:96-137`).
- **Fourteen of seventeen worker sweeps** claim through a conditional
  UPDATE, `SKIP LOCKED`, an advisory lock, or a window-bucketed idempotency
  key (table in the worker section below).
- **Auth.** Stateless HMAC JWT (`api/src/auth/session.ts`);
  `NESSIE_AUTH_SECRET` is fatal if unset outside `local`
  (`api/src/lib/server-context.ts:99-109`); every OAuth `state` is a Postgres
  row consumed atomically — MCP (`packages/mcp-manage/src/mcp-oauth-state.ts:82-107`),
  comms (`api/src/routes/comms/oauth-routes.ts:279-357`), board sources
  (`api/src/routes/board-sources/oauth-state.ts:55-84`); device-code polling
  is a DB lease (`api/src/services/model-subscription-device.ts:183-194`);
  brute-force limits are the Postgres `rate_limit_buckets` upsert
  (`api/src/services/rate-limit.ts:149-165`).
- **Executor daemons.** REST poll every second; all state is Postgres under
  `pg_advisory_xact_lock('executor:<id>')` with a monotonic connection epoch
  (`packages/executor-manage/src/executor-daemon.ts:321-362`); command results
  are correlated by row, not by socket (`executor-command-results.ts:45-101`).
- **Cloud-browser rows, control claims and reaper.** Conditional UPDATEs
  with TTLs (`packages/browser-cloud/src/session-lifecycle.ts:405-462,
  555-575, 625-637`). DeepWater handoff state is all conditional row updates
  (`packages/runtime/src/deepwater-handoff-runs.ts`).
- **Files.** Storage accounting is an append-only signed-delta ledger
  (`packages/runtime/src/storage-usage-ledger.ts:27-84`); `FileService.store`
  deletes the object on every failure path (`packages/runtime/src/files/index.ts:217-344`);
  thumbnails claim with `updateMany WHERE thumbnailKey IS NULL`
  (`attachment-thumbnails.ts:82-89`). Uploads are memory-bounded on every
  path (S3 multipart holds about 32 MiB, `storage/s3.ts:12-13, 63-81`).
- **Webhook ingress.** SNS message id as queue key plus `receiptId @unique`
  (`api/src/routes/agent-email-inbound.ts:99`; `schema.prisma:6727`); comms
  events catch `P2002` on `(connectionId, canonicalMessageId, version)`
  (`worker/src/control/comms-persistence.ts:88-140`); trigger dedupe on the
  unique index (`api/src/services/trigger-dispatch.ts:296-320`). Signature
  verification is stateless everywhere; the SNS certificate cache is a
  bounded eight-entry read-through of Amazon's immutable PEMs.
- **Migrations.** `prisma migrate deploy` runs only as a one-shot step in
  `infrastructure/compose/redeploy.sh:112-125`; nothing in app boot migrates.

## Area 1 — API process lifecycle and bootstrap

| # | Sev | Finding | Where |
|---|---|---|---|
| 1.1 | BLOCKER | No `SIGTERM`/`SIGINT` handler in the API. Node's default exits immediately: in-flight requests are reset mid-transaction, SSE/WS get no close frame, pools and the LISTEN client are dropped. `app.close()` alone would hang on open streams because Fastify 5.8 `forceCloseConnections` defaults to `'idle'`. | `api/src/index.ts:406-433`; hooks that never run `:294-298, :399-401` |
| 1.2 | BLOCKER | Owner-bootstrap token is minted per process with `randomUUID()`; the exchange lands on a random replica and fails with `TOKEN_INVALID`, and `clearBootstrapState` clears one replica only. Latent in prod because a UOA provider disables the local-bootstrap flow. | `api/src/lib/server-context.ts:111-150`; `api/src/routes/auth-core.ts:164-170, 266-297` |
| 1.3 | BLOCKER | In-process rate-limit `Map` is per replica (effective limit `max × N`) and never pruned (grows one entry per route × IP for the life of the instance). It is the only limiter for thread messages (60/min), `mailbox-connections/discover` (30/min, an outbound-probe amplifier) and agent mutations. | `api/src/lib/rate-limit.ts:56-77`; `api/src/lib/global-auth-hook.ts:41-47` |
| 1.4 | BLOCKER | `seedDefaultPolicies` runs on every replica at boot as a count-then-create with no lock and no unique constraint on `PolicyRule`; concurrent boots insert the default set N times per organisation, and duplicate rules at equal priority make `resolveDecision` order-dependent. `ensureKnowledgeDefaultPolicies` runs before the early return, so the window reopens every deploy. | `api/src/index.ts:249-266`; `api/src/services/policy.ts:159-196, 265-381`; `schema.prisma:4585-4608` |
| 1.5 | BLOCKER | `sweepExpiredApprovals` claims `pending→expired` in one statement and terminalises the run in a second transaction; a kill between them leaves the run in `waiting_approval` forever and no replica will revisit it. | `api/src/services/approvals.ts:364-392`; `api/src/services/approval-resume.ts:130-152, 236-239` |
| 1.6 | BLOCKER | About 31 Postgres connections per API replica (Prisma 10 + realtime pool 10 + memory pool 10 + one dedicated LISTEN client) and no env var for `poolMax`/`poolMin`; only `nessie.config.json` can change them. Twenty replicas is 620 connections. | `api/src/lib/server-context.ts:76-79`; `api/src/realtime/hub.ts:321-325`; `api/src/index.ts:189-192`; `packages/config/src/index.ts:121-122, 257, 365-366` |
| 1.7 | DEGRADED | Boot does O(orgs + agents + assistants) sequential, advisory-locked round trips before `listen()` (policy seed, protected-grant backfill, PA default grants, credential sweep). Safe, but cold-start time scales with tenant size and simultaneous boots serialise on the locks. | `api/src/index.ts:249-283, 406-430`; `agent-tool-policy-registry.ts:383-473` |
| 1.8 | DEGRADED | Session-revocation cache is per replica with a 30 s TTL. Masked today because every revocation also revokes refresh rows and `authenticateRequest` checks those live; logout does not call the local invalidate that session-delete does. | `api/src/services/auth-session-registry.ts:66-106`; `api/src/routes/auth-logout.ts:24-45` |
| 1.9 | DEGRADED | `/api/health/ready` returns 503 when every worker heartbeat is stale, so a worker outage or worker deploy would pull all API replicas out of the load balancer. | `api/src/routes/health.ts:21-25`; `api/src/services/ops-health.ts:35-56, 146-164` |
| 1.10 | DEGRADED | `filesystem` is the default storage provider and nothing forbids it outside `local`; a deployment that forgets `NESSIE_STORAGE_PROVIDER` writes uploads to per-instance ephemeral disk silently. | `packages/config/src/index.ts:369-373`; `packages/runtime/src/storage/index.ts:18-25` |
| 1.11 | INFO | The API binds `NESSIE_API_PORT`; Cloud Run injects `PORT`. | `packages/config/src/index.ts:284-285, 387` |
| 1.12 | INFO | `apiUsageTracker` accumulates per process and is never read; the DB ledger is the authority. Delete it. | `api/src/index.ts:85, 158`; `packages/runtime/src/usage.ts:8-45` |
| 1.13 | INFO | `RateLimiter.stats` on `/api/ops/health` are per process. Observability only. | `api/src/services/rate-limit.ts:107-129` |

## Area 2 — Realtime: SSE, WebSocket, presence, calls, voice

| # | Sev | Finding | Where |
|---|---|---|---|
| 2.1 | BLOCKER | Insert and `NOTIFY` are two autocommit statements on two pools, so notifications can arrive out of id order. The per-connection watermark then drops the lower id permanently, and because the client's `Last-Event-ID` has already advanced past it, replay (`id > $2`) never returns it either. Two publishers today make this rare; N make it routine. | `api/src/realtime/hub.ts:179-181, 226-228, 261`; `packages/runtime/src/realtime.ts:128-135, 331-350, 486-496`; persist via Prisma at `hub.ts:508` |
| 2.2 | DEGRADED | On a LISTEN drop the transport re-listens after 1 s but never re-reads the backlog for connections already registered; keepalives keep those sockets alive so no client reconnect fires. Bounded by the client's next reconnect. | `packages/runtime/src/realtime.ts:253-268, 287-292`; `hub.ts:334` |
| 2.3 | DEGRADED | `realtime_events` pruning is gated by an in-process `lastPruneAt`, so every worker replica prunes once a minute. `thread_stream_events` is never pruned at all. | `packages/runtime/src/realtime.ts:170, 380-391, 458`; migration `20260408030300` |
| 2.4 | DEGRADED | `user_presence.connections` is incremented on connect and decremented only from the same process's close handler; a hard kill leaks it forever. Inert today: presence state uses `lastSeenAt`, and the one reader of the counter has no production caller. | `api/src/services/presence.ts:30-92, 158-175`; `api/src/routes/events.ts:43-56, 85-93` |
| 2.5 | DEGRADED | A hard-killed worker leaves `run_document_sessions` in `streaming` forever; every terminaliser is in-process and there is no reaper, so the admin shows a document that never finishes. | `worker/src/run/execute/document-stream.ts:167-179`; `api/src/services/document-streams.ts:29, 203-221` |
| 2.6 | DEGRADED | Four API maintenance sweeps run on every replica with no leader. Idempotent, so N redundant DELETEs contending on the same rows. | `api/src/services/api-maintenance.ts:44-63` |
| 2.7 | INFO | `pg_notify` payloads are capped at 8000 bytes. Only the document-delta lane splits (`MAX_NOTIFY_CONTENT_BYTES = 3500`); `stream.done` carries the whole assistant reply, so an oversized one is persisted, then the notify throws into the run's completion stage and clients see it only on reconnect. | `packages/runtime/src/realtime.ts:141-147`; `worker/src/run/execute/document-stream-lanes.ts:8-11`; `worker/src/run/execute/completion.ts:108-114` |
| 2.8 | INFO | Client reconnect backoff resets on any `'connected'`, including a socket that died mid-stream; draining a replica with 200 clients produces a one-second re-hydration burst on the survivors. | `admin/src/facades/threads/stream-retry.ts:51-95` |
| 2.9 | INFO | `MAX_REPLAY_EVENTS = 5000` truncates a long replay with no gap signal. | `packages/runtime/src/realtime.ts:70, 113-136` |

Verified safe in this area: calls (`SELECT … FOR UPDATE` plus revisioned
conditional updates, ring timeouts as delayed idempotent queue jobs,
`api/src/services/calls.ts:67-259`, `packages/team-admin/src/call-start.ts:154-159`),
voice (no in-memory registry at all, `api/src/services/voice/voice-session.ts`),
push-surface presence (monotonic upsert plus a five-minute reaper), designer
streaming (in-process on the same reply, per request).

## Area 3 — Auth, sessions, rate limits, OAuth and device flows

Beyond 1.2, 1.3 and 1.8 above, the area is clean. One extra bounded item:

| # | Sev | Finding | Where |
|---|---|---|---|
| 3.1 | DEGRADED | UOA roster-subject cache (30 s per process) gates the avatar relay; a removed member can fetch former teammates' pictures for up to 30 s. Accepted trade-off, documented in the module. | `api/src/services/uoa-roster-subjects.ts:25-88`; `api/src/routes/team-members.ts:308` |

Cookies are `SameSite=None; Secure`, host-only, scoped to `/api/auth`
(`api/src/lib/refresh-cookie.ts`); public-origin resolution refuses
header-derived origins outside `local` (`api/src/lib/public-origin.ts:53-74`).

## Area 4 — In-process mutable state in services and packages; read-modify-write races

| # | Sev | Finding | Where |
|---|---|---|---|
| 4.1 | BLOCKER | `writeScopedSetting` is find-then-create inside a transaction with no unique constraint on `(organizationId, key, scope, teamId, userId)`; two saves of the same setting on two replicas create two rows, and `resolveFromRows` reads them with no `ORDER BY`, so a setting someone just locked can read back unlocked. | `packages/runtime/src/scoped-settings.ts:69-88, 184-233`; `schema.prisma:7103-7138` |
| 4.2 | DEGRADED | The budget gate is read-then-decide over an aggregate with no lock or reservation; it is documented as a soft cap ("can overshoot slightly"). N concurrent runs across N replicas make the overshoot routine in `enforce`/`degrade` modes. | `packages/runtime/src/budget.ts:21-22, 154-166, 284-313` |
| 4.3 | DEGRADED | The storage-quota gate has the same shape ("exact modulo concurrent uploads"); N concurrent uploads can each pass before any usage event lands. | `packages/runtime/src/budget.ts:420-426, 468-497` |
| 4.4 | DEGRADED | Query-embedding cache: 15 min TTL, 500 entries, deterministic input. Acceptable; a cold replica recomputes. | `api/src/services/knowledge-query-embedding.ts:6-36` |

Everything else on the module-level grep list is either a constant table
(`manifestBySlug`, `operatorEnvSecretRefs`, adapter registries built from
identical env), a bounded per-process resource cache (`pinnedAgentCache` 64
entries, `chunkers`, the PDFium render chain), or already covered above.
Verified safe with DB evidence: agent-card press claim is a conditional
UPDATE (`api/src/routes/agent-cards.ts:196-206`); resource locks and the
owner lock are advisory or `FOR UPDATE` (`api/src/services/resource-locks.ts:75-115`,
`organization-owner-lock.ts:19-26`); message creation is idempotent on
`(threadId, clientMessageId)` with `P2002` re-fetch
(`api/src/services/message-create.ts:26-38, 282-329`; `schema.prisma:2361`);
inference usage is `createMany({ skipDuplicates })` on `inferenceInvocationId`
(`packages/runtime/src/ledger.ts:412`), which dedupes a redelivered
recording but not a replayed run that mints new invocation ids; budget
config writes upsert on `(scopeType, scopeId)`; the first-owner bootstrap
row is created under `pg_advisory_xact_lock('nessie:bootstrap-initialization')`
(`api/src/db/seed.ts:28-38, 163-176`); Infisical access has no in-process
cache; the in-memory subscription secret store is a test double never wired
in production (`packages/model-subscriptions/src/secret-store.ts:54-72, 239-243`).
`inference-control-plane.ts`, `pricing-profiles.ts` and `plans.ts` have no
cache layer at all, so there is no write-here-read-stale-there pair.

## Area 5 — Worker: queue, sweeps, schedulers, drain

| # | Sev | Finding | Where |
|---|---|---|---|
| 5.1 | BLOCKER | `stop()` aborts, clears timers and closes the pool while a handler is still running; it never stops claiming before finishing, and the abort path returns without ack or nack. A 20-minute run dies mid-inference with its terminal writes throwing on a closed pool. | `worker/src/index.ts:1191-1226`; `packages/runtime/src/queue.ts:151-177` |
| 5.2 | BLOCKER | A re-claimed `run.execute` replays the whole run from the prompt: `claimRunForExecution` admits `running` by design, and `persistRunCheckpoint` is written only on budget stop and approval suspend, never on a crash. Tools that already sent email or created tasks run again and inference usage is recorded twice. | `worker/src/run/execute/run-job.ts:87-106`; `lifecycle.ts:77-86`; `run-stop.ts:110, 194`; `run-suspend.ts:62` |
| 5.3 | BLOCKER | Lock renewal failures are only logged (three misses in a row silently expire the lock), and nothing fences the run itself, so a second worker can claim and execute a run the first is still executing. | `packages/runtime/src/queue.ts:196-253`; `run-job.ts:88-93` |
| 5.4 | DEGRADED | The timeout arm of the claim ignores `max_attempts`; a job whose handler kills the process is re-claimed every five minutes forever, migrating across instances as a rolling crash loop. | `packages/runtime/src/queue.ts:228-253` |
| 5.5 | DEGRADED | `sweepStrandedReconciliations` increments `step` unconditionally, so N instances mint N different idempotency keys and N reconcile jobs. | `worker/src/control/automatic-membership/revalidate.ts:97-110` |
| 5.6 | DEGRADED | Automatic-membership rate-limit buckets are per process: the "whole instance" cap against UOA becomes `20 × N` calls per second. | `worker/src/control/automatic-membership/rate-limit.ts:12-51` |
| 5.7 | DEGRADED | `execution_runners` rows are keyed by `HOSTNAME`, upserted every 30 s and never deleted; with unique hostnames the table grows two rows per boot forever, and with `HOSTNAME` unset every instance shares one label and renews each other's leases. | `worker/src/index.ts:294, 834-836, 1050-1065`; `worker/src/control/execution/runners.ts:12-45` |
| 5.8 | DEGRADED | `expireExecutionLeases` flips the DB row to `failed` but never terminates the provider instance; a GCE VM whose worker was scaled in keeps billing. | `worker/src/control/execution/leases.ts:115-194` |
| 5.9 | DEGRADED | `maybeSyncRegistry` guards a multi-minute walk with a process-local flag and a documented read-then-insert race; every instance fires a 60 s post-boot kickoff, so a scale-out walks the registry N times. | `worker/src/control/registry-sync-sweep.ts:89-132`; `worker/src/index.ts:1160-1175` |
| 5.10 | DEGRADED | `reconcileTombstonedAgentBrowsers` reads then deletes with no claim; losers write a spurious `lastError`. | `packages/browser-cloud/src/agent-browser.ts:271-306` |
| 5.11 | DEGRADED | Per-process `threadLocks` for the external-conversation first turn; mostly covered by the run-slot advisory lock one layer up. | `worker/src/run/external-conversation-store.ts:64-80` |
| 5.12 | DEGRADED | Per-process memo of seeded builtin-tool organisations; the upsert batch reruns once per org per instance. Waste only. | `worker/src/run/execute/tool-registry.ts:10, 16, 56` |
| 5.13 | DEGRADED | `push.dispatch` has no claim and `push_deliveries` is a log row with no unique key, so a redelivered dispatch (dropped ack on drain, lease expiry) sends a duplicate notification. | `worker/src/control/push-dispatch.ts:72`; `push-delivery-core.ts:362`; `schema.prisma:5809-5823` |
| 5.14 | INFO | `pubsub-queue.ts` is imported by nothing; the worker warns and falls back to Postgres. It is push-mode, cannot delay, and its dedupe sets are per process. | `packages/runtime/src/pubsub-queue.ts:61-174`; `worker/src/index.ts:200-204` |
| 5.15 | INFO | `docs/the-agents.md` documents a `pg_advisory_lock` scheduler leader election that was never built. | `docs/the-agents.md:1297, 1687` |

Sweep table (all in `worker/src/index.ts`): trigger sweep 15 s **safe**;
Gmail send sweep 5 s **safe**; active-call expiry 60 s **safe**; dashboard
sweep 30 s **safe** (CAS on `claimedAt`); board-source sweep 30 s **safe**
(CAS plus day-bucketed renew key); domain revalidation 5 min **safe**,
stranded reconciliations **5.5**; workflow-step reaper 15 s **safe**;
cloud-browser reap 30 s **safe** except tombstone reconcile **5.10**;
delivery retry 15 s **safe**; mailbox sweep 5 s **safe**; runner heartbeat
30 s **5.7**; execution-lease sweep 15 s claim safe but **5.8**; pending
batch sweep 10 s **safe**; comms renew 5 min **safe**; comms incremental
sweep 60 s **safe**; registry sync 30 min and its boot kickoff **5.9**.

Polling cost of the Postgres queue at N workers: 36 topics × N × 1/s
single-row `UPDATE … SKIP LOCKED` statements (720 per second at N = 20).
Fine for now; raise `pollIntervalMs` on cold topics or add a NOTIFY wake-up
before it matters.

## Area 6 — Files, uploads, local disk, storage providers

| # | Sev | Finding | Where |
|---|---|---|---|
| 6.1 | BLOCKER | Same as 1.10: `filesystem` has no deployment-mode gate. | `packages/config/src/index.ts:5, 30, 368-371` |
| 6.2 | BLOCKER | `file_write`/`file_read`/`file_glob` builtins do raw `node:fs` I/O on the worker's own disk under an operator-configured `allowedRoots`; a write on one worker is invisible to the next tool call on another. They refuse when `allowedRoots` is absent. | `worker/src/run/builtin-handlers/file-write.ts:60-71`; `sandboxed-tool-dispatch.ts:56-79`; `sandbox.ts:63-78` |
| 6.3 | BLOCKER | The `docker` execution provider shells out to the local daemon; provisioning checks runner locality but termination does not, and "No such container" is swallowed and persisted as `terminated`. Prod does not mount `docker.sock` into the worker, so it is unused today and impossible on Cloud Run. | `worker/src/control/execution/docker-provider.ts:105-177`; `claims.ts:50-70` vs `:115-135` |
| 6.4 | DEGRADED | No signed-URL download path; every download is proxied through the API. Self-contained per request, but a 5 GiB file is tied to one instance and Cloud Run's request timeout. | `api/src/routes/uploads.ts:73-110` |
| 6.5 | INFO | The native `gcs` backend is a legacy buffer-only stub that throws without a `gcsClient` nobody constructs; there is no `@google-cloud/storage` dependency anywhere. Selecting `gcs` today fails at boot. The infra reviewer's "already implemented" claim was checked and is wrong. | `packages/runtime/src/storage/index.ts:26-34`; `storage/gcs.ts:6-11` |

## Area 7 — Infrastructure, deployment, configuration, GCloud fit

`infrastructure/terraform/` is the retired Phase-2 tree: never run by any
workflow, and stale against the code in every way that matters.

| # | Sev | Finding | Where |
|---|---|---|---|
| 7.1 | BLOCKER | API background timers and the persistent LISTEN client need CPU always allocated on Cloud Run; the terraform sets neither `cpu_idle = false` nor an execution environment, so sweeps and realtime delivery stall on idle instances. | `infrastructure/terraform/modules/cloud-run/main.tf` |
| 7.2 | BLOCKER | The worker is declared as an HTTP Cloud Run Service fed by Pub/Sub push, but it binds no port and Pub/Sub is unimplemented; the revision would never become ready. | `cloud-run/main.tf:188-274`; `pubsub/main.tf:83-93` |
| 7.3 | BLOCKER | The API service omits `NESSIE_API_PUBLIC_URL`, `NESSIE_ADMIN_PUBLIC_URL`, `NESSIE_CORS_ORIGINS` and `NESSIE_API_TRUSTED_PROXY_HOPS`; `resolvePublicOrigin` throws without the first in non-local mode, and hop count 0 makes `request.ip` the load balancer. | `cloud-run/main.tf:60-171`; `api/src/lib/public-origin.ts:53-74` |
| 7.4 | BLOCKER | `nessie.config.json` is a file mount and `auth.providers` has no env path, so SSO is off unless the file is baked into the image or mounted from Secret Manager. | `docker-compose.prod.yml:195-196`; `packages/config/src/index.ts:476-488` |
| 7.5 | BLOCKER | Terraform expects separate `api` and `worker` images; CI builds one `nessie-app` image and the worker is a command override. | `cloud-run/main.tf:37-47`; `.github/workflows/deploy.yml:34-49` |
| 7.6 | DEGRADED | Cloud SQL is declared as Postgres 16; production runs pgvector on 17. | `cloud-sql/main.tf:33` |
| 7.7 | INFO | Memorystore is provisioned but `redis.enabled` has no env mapping and nothing reads it; the Pub/Sub module is dead weight. | `packages/config/src/index.ts:124-129, 584` |
| 7.8 | INFO | No migration step exists for GCloud; the compose one-shot must become a Cloud Run Job that gates the rollout, including the `RESOLVABLE_FAILED_MIGRATIONS` repair logic. | `redeploy.sh:91-125` |
| 7.9 | INFO | Per-organisation wildcard team hosts need Certificate Manager with DNS authorisation; classic Google-managed certificates do not do wildcards. Not active in prod today. | `docs/standards/team-hosts.md:78-96` |

Infisical accepts the token as a plain env var or a file
(`api/src/services/infisical-vault.ts:65-72`), so a Secret Manager env
reference works without a volume.

## Area 8 — Executors, MCP clients, DeepWater, cloud browsers, gateway

| # | Sev | Finding | Where |
|---|---|---|---|
| 8.1 | BLOCKER | The cloud-browser CDP connect URL and origin gate exist only in the worker process that ran `browser_open`. A run that suspends for the cross-origin write approval is re-enqueued and claimed by any worker, where `acquireCdp` returns null and the run cannot reopen (`SESSION_ALREADY_OPEN`); the abandoned session bills until its TTL. | `worker/src/run/browser-cloud/session-pool.ts:13-16, 33, 46-80`; `packages/browser-cloud/src/session-lifecycle.ts:304-318` |
| 8.2 | BLOCKER | Same root as 6.3: Docker execution instances are host-affine and the terminate job is routed to any worker. | `worker/src/control/execution/docker-provider.ts:158-177` |
| 8.3 | BLOCKER | The gateway also has no `SIGTERM` handler; its APNs HTTP/2 session is torn without GOAWAY and dead-token verdicts are dropped. | `gateway/src/index.ts:19-34`; `gateway/src/app.ts:178-180` |
| 8.4 | INFO | The worker holds a queue slot for up to six minutes while it polls for an executor command result. Correct (DB poll); a capacity-shaping fact. | `worker/src/control/executor-commands.ts:7-24` |

Request-affinity map: executor daemon **no** (REST poll, all state in
Postgres); remote MCP servers **no** (client opened and closed inside each
call, `packages/mcp-manage/src/mcp-instance-probe.ts:128-159`,
`worker/src/run/tool-mcp.ts:88-101`); OAuth callbacks **no**; Browserbase
live view **no** (URL minted per request); Browserbase driving **yes** (8.1);
Docker daemon **yes** (8.2); gcloud provider **no**; APNs/FCM **no**
(self-mintable token caches); gateway **no**.

## Area 9 — Webhooks, email ingress, renewals

| # | Sev | Finding | Where |
|---|---|---|---|
| 9.1 | BLOCKER | Board-source inbound items are created read-then-insert: the external-link lookup runs outside the transaction and `Task` has no constraint on `(sourceId, externalId)`. The intake route enqueues with no idempotency key, so a provider retry becomes a second job; two workers each create a `Task`, and the loser's task is an orphan. GitHub and Linear delivery ids are parsed but never stored, so this path is their only dedupe. | `packages/team-admin/src/board-source-apply.ts:148-231`; `api/src/routes/board-sources/webhooks.ts:43-53`; `schema.prisma:1786, 1811` |
| 9.2 | INFO | Trigger intake and DeepSignal insight events do their work inline before responding, unlike every other receiver (enqueue and ack). Race-free, but latency scales with fan-out. | `api/src/routes/trigger-intake.ts:82-119`; `api/src/routes/external-agent.ts:187-235` |
| 9.3 | INFO | Jira `ensureWebhook` registers a new webhook on every renewal without deleting the previous one. Pre-existing, bounded by Jira's 30-day expiry. | `packages/board-source-jira/src/adapter.ts:319-339` |

## Enqueue sites without an idempotency key

`api/src/routes/dashboards.ts:462`, `api/src/routes/comms-webhooks.ts:62`,
`api/src/routes/comms/oauth-routes.ts:409`,
`api/src/routes/board-sources/webhooks.ts:43`,
`packages/team-admin/src/comms-connection-management.ts:102`. The comms
paths are covered downstream by unique constraints; the board-source one is
9.1.
