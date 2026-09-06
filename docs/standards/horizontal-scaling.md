# Horizontal scaling — nothing a second instance cannot see

Authoritative standard for running N copies of the API, the worker and the
gateway. [`AGENTS.md`](../../AGENTS.md) → "Architecture" carries the one-line
invariant and points here; **this file is the rule.**

Nessie is closer to horizontally scalable than its single-container deployment
suggests: the queue, realtime fan-out, scheduled triggers, thread
serialisation, exactly-once sends, OAuth flows and executor daemons were all
built on Postgres primitives that already work across instances. What blocks
running two copies is a bounded list of concrete defects, audited with
`file:line` evidence in
[`docs/plans/2026-09-05-horizontal-scaling-statelessness/audit.md`](../plans/2026-09-05-horizontal-scaling-statelessness/audit.md)
and scheduled in
[`overview.md`](../plans/2026-09-05-horizontal-scaling-statelessness/overview.md).
Each rule below is written after one of them. Audit numbers in parentheses are
that file's finding numbers; line numbers are as of `e064a136`.

## 1. No module-scope mutable state that a second instance would need

**A value a request or a run depends on lives in Postgres, not in a module
variable.** The owner-bootstrap token is minted per process with `randomUUID()`
(1.2, `api/src/lib/server-context.ts:111-150`): the exchange lands on a random
replica and fails `TOKEN_INVALID`, and `clearBootstrapState` clears one replica
only. The in-process rate-limit `Map` (1.3, `api/src/lib/rate-limit.ts:56-77`)
makes the effective limit `max × N` and is never pruned, and it is the only
limiter for thread messages, mailbox discovery and agent mutations. The
cloud-browser CDP connect URL exists only in the worker that ran `browser_open`
(8.1, `worker/src/run/browser-cloud/session-pool.ts:13-16, 33, 46-80`), so a run
that suspends for an approval is re-claimed by a worker where `acquireCdp`
returns null and the session bills until its TTL.

**Corollary.** Put the state in Postgres: a row claimed with a conditional
`UPDATE … WHERE … RETURNING`, or an existing shared table (`rate_limit_buckets`
already implements the token bucket). A cache is allowed only when it is
read-through, bounded, carries a TTL, and is **never** the authority for a
decision — `knowledge-query-embedding.ts` (4.4) and the 30 s UOA roster-subject
cache (3.1) are the passing shape, and the second one documents its staleness
window in the module because the staleness is user-visible.

## 2. Every periodic job claims its work, or runs under `withSweepLock`

**A sweep with no claim runs N times.** `maybeSyncRegistry` guards a
multi-minute walk with a process-local flag (5.9,
`worker/src/control/registry-sync-sweep.ts:89-132`) and every instance fires a
60 s post-boot kickoff, so a scale-out walks the registry N times. The four API
maintenance sweeps have no leader at all (2.6,
`api/src/services/api-maintenance.ts:44-63`); `realtime_events` pruning is gated
by an in-process `lastPruneAt` (2.3, `packages/runtime/src/realtime.ts:170,
380-391`); `sweepStrandedReconciliations` increments `step` unconditionally
(5.5, `worker/src/control/automatic-membership/revalidate.ts:97-110`), so N
instances mint N different idempotency keys and N reconcile jobs.

**Corollary.** Choose one of four primitives, and say which in a comment:

- **Conditional `UPDATE`** — compare-and-set on a `claimed_at`/`status` column
  and act only on the rows the statement returned. The dashboard and
  board-source sweeps already do this.
- **`FOR UPDATE SKIP LOCKED`** — per-row leases when the sweep processes a
  batch and each row is independent work.
- **A window-bucketed idempotency key** — put the window (`…:2026-09-05`) in
  the key so N instances enqueueing in the same tick collapse to one job.
- **`withSweepLock`** — for a sweep whose body is one indivisible walk. Added
  to `@nessie/db` in Phase 2.9; the contract is: it takes a stable lock name,
  hashes it to a bigint, and calls `pg_try_advisory_lock` on that hash. If the
  lock is held the tick is **skipped**, not queued — a blocking
  `pg_advisory_lock` would pile every replica's ticks behind the holder and
  turn a slow sweep into a connection leak. It releases in a `finally`, and the
  caller treats "skipped" as a normal outcome, never an error.

## 3. Every enqueue carries an idempotency key

**Or the handler's writes are idempotent through a unique constraint, and the
topic says so in a comment.** Board-source inbound items are created
read-then-insert with the external-link lookup outside the transaction and no
constraint on `(sourceId, externalId)` (9.1,
`packages/team-admin/src/board-source-apply.ts:148-231`), and the intake route
enqueues with no key (`api/src/routes/board-sources/webhooks.ts:43-53`), so a
provider retry becomes a second job, two workers each create a `Task`, and the
loser's task is an orphan nobody sees.

**Corollary.** `enqueue` upserts on `idempotency_key`
(`packages/db/src/queue.ts:24-49`) — the mechanism exists, the discipline is
choosing a key that is an external fact rather than a clock reading: the
provider's delivery id, `run:<id>`, `mailbox:<messageId>`. The audit's
"Enqueue sites without an idempotency key" list is the current debt.

**A key on the enqueue is only half of it.** It coalesces two *enqueues*; it
says nothing about the same *job row* being handed out twice — a dropped ack
during a drain, a lease expiry, a nack-and-retry — which is exactly what N
workers make routine. A handler whose writes are not already idempotent
therefore claims its work before it acts. Push delivery (5.13) is the worked
example: `push_deliveries` looked like a dedupe but is an outcome log written
*after* the provider answers, with no unique key and its own retention, so
`worker/src/control/push-send-claim.ts` inserts a `push_send_claims` row with a
unique `(organization_id, notification_key, endpoint_key)` before any provider
call. `notification_key` mirrors the topic's enqueue key one-for-one
(`push:message:<id>`); the loser of the claim **skips the work and the job still
succeeds**, because a job whose work is already done is not a failed job. Put
the claim on its own table rather than on the log when the log is nullable
where you would need the key, carries no column for the thing being claimed, or
is pruned on a schedule that would re-arm the duplicate — all three were true
of `push_deliveries`.

**A claim taken before the side effect must have a state, or it is a silent
drop.** A claim that is never released is at-most-once, and at-most-once is not
a trade every effect can make: a push claim held after a failed send means an
incoming call's ring is suppressed forever, and a ring has no surface that
retries later. So `push_send_claims` carries `sending` / `sent`. Only a
**confirmed** outcome makes the claim permanent; a definitive failure or an
exception deletes it so the next redelivery genuinely retries; and a `sending`
row left by a killed process is taken over once it is older than a stated
horizon — inside the claim statement, as an `INSERT … ON CONFLICT DO UPDATE …
WHERE`, never a read-then-write. Choose that horizon between the longest
legitimate in-flight attempt and the queue's own 300 s lock TTL: at or beyond
the lock TTL, the first redelivery after a kill still sees a "fresh" claim and
drops the work. Say in the module which way the residual risk falls — for a
notification it is a rare duplicate, never a silent loss. And give the claim
table a reaper, because nothing else deletes a permanent claim
(`worker/src/control/push-claim-sweep.ts`). The full push contract is in
[docs/web-push.md](../web-push.md) → "One notification, one device, one send".

## 4. Every long-running handler is resumable

**A fencing token on the run and a checkpoint at each iteration boundary.** A
re-claimed `run.execute` used to replay the whole run from the prompt (5.2):
`claimRunForExecution` admits `running` by design and `persistRunCheckpoint` was
written only on budget stop and approval suspend, never on a crash. Tools that
had already sent email or created tasks ran again, and inference usage was
recorded twice. Nothing fenced the run either — lock-renewal failures were only
logged (5.3) — so a second worker could execute a run the first was still
executing.

**Corollary, as built.** `runs.executor_token` is set by
`claimRunForExecution` in a conditional `UPDATE` (pending, or a stale
heartbeat) and carried on every terminal write, so a stale executor's write
matches no row. Beside it:

- **The crash checkpoint** (`worker/src/run/execute/crash-checkpoint.ts`) is
  written at every loop-iteration boundary, immediately before each tool batch,
  and as each tool in that batch settles. It carries the assembled transcript,
  the iteration count, the live invocation accumulator, spend and wall-clock so
  far, compaction and loop-detection counters, the circuit-breaker and retry
  counters (failures belong to the run, so a crash-looping run neither retries
  forever nor gets a clean breaker on each re-claim), the results of tool calls
  that already ran, and the batch that was dispatching. It rides on
  `run_checkpoints` — already unique on `run_id`, which is the one-row-per-run
  invariant — in its own columns, so it never collides with the model-written
  note a budget stop or a suspension leaves for a person.
- **Every write is fenced on the run row**, not on the checkpoint row: the
  statement proposes a row only while `runs.executor_token` still equals the
  claiming token, so a fenced-out executor's checkpoint write affects zero rows.
  The fence covers the whole statement, not just its `SELECT` half — the run row
  is locked `FOR NO KEY UPDATE` in a CTE, so a takeover committing mid-statement
  cannot leave the `ON CONFLICT DO UPDATE` overwriting the new holder's state.
  Clearing is fenced the same way, on the executor that wrote the state or still
  holds the run; only a status written from outside any execution clears
  unfenced, and that caller is the one ending the run.
- **The persists are serialised.** Same-batch tool calls settle together, so
  their writes would otherwise commit out of order and a state snapshotted
  before the last record could land last — dropping that record and re-running
  its tool. After N concurrent records the durable row holds all N.
- **What the record guarantees, exactly.** A tool whose result reached durable
  storage never runs again. The window the record alone cannot cover is between
  a tool's side effect committing at the provider and its record committing in
  Postgres; that window is closed by the ledger below.
- **A side-effecting call is claimed before it is dispatched.**
  `run_tool_effects` is unique on `(run_id, tool_call_id)` and carries the tool
  name, a state, the settled result and its timestamps.
  `worker/src/run/execute/tool-effect-ledger.ts` commits a `dispatched` row **on
  its own, before** the call runs — folded into any longer transaction it would
  become durable only after the side effect, which is the window it exists for.
  **Only the absence of a row lets a call run.** A later execution reads:
  - **no row** — the call never started, and runs normally;
  - **`completed`** or **`failed`** — the tool RETURNED, reporting success or
    reporting failure, so the outcome was observed and its result is durable.
    Either way the call is answered from that recorded result, without
    re-authorising and without running again. It is the same answer the crash
    checkpoint gives for the same result on its fast path, and the two are
    required to agree. (A model that wants to retry a failed call issues a new
    call, with a new id, which has no row.)
  - **`dispatched`** or **`interrupted`** — the outcome is genuinely unknown, and
    the call is **not** repeated. `dispatched` is a claim nothing ever settled;
    `interrupted` is a dispatch that **threw**. A throw is not a failure: the
    tool reported nothing at all, and the claim was already committed, so the
    call may well have reached the far side and come apart afterwards — an
    executor command that ran on the person's machine before a later audit write
    hit a transient database error, an MCP call the server executed whose
    response was lost to a timeout. Both are answered with the same tool result,
    which tells the model that the call was started, that its outcome was never
    recorded, and that it has deliberately not been retried, so the agent checks
    rather than acting on a fabricated success or failure. An unrecognised state
    — a row from a newer deploy — is read the same way, which is the safe read of
    a state this code cannot interpret.

  Because every row that exists answers, there is no fall-through on which a
  claimed call is executed a second time. There used to be: a row the ledger
  declined to answer ran the tool again **without a fresh claim**, and since the
  settle is scoped to `dispatched` it matched no row — so the repeat went
  unrecorded and a third execution was free to run the call a third time.

  A throw raised *before* the transport (an authorization gate hitting a dead
  database, say) is indistinguishable from one raised after it and is treated as
  unknown too. That costs a call the agent can make again, and the
  unknown-outcome text asks it to; the opposite mistake costs a duplicate nobody
  can take back.
- **The claim is keyed on the provider's tool-call id, and the key is checked.**
  An **empty** id is not a key — every id-less call in the run would collide on
  one row and be answered from the first one's output — so a call without an id
  falls through and runs unclaimed, which is what a run with no idempotency to
  offer honestly is. A **reused** id is caught by comparing the stored tool name:
  a conflicting row whose `tool_name` is not this call's name describes somebody
  else's call, so it is reported to the model as a collision and the tool does
  **not** run. Replaying the row would answer this call with a stranger's output;
  running it would write this call's outcome over the other call's row and lose
  the guarantee for both.
- **Precedence between the two, and it is structural.** The crash checkpoint's
  recorded results are the fast path: the recorder wraps the ledger, so a call
  this run already recorded is answered in memory and never reaches a query. The
  ledger is the durable backstop, and only ever sees a call the checkpoint has
  no record of — a crash before its write landed, state too large to persist, a
  process that never saw the checkpoint at all. Both are keyed by the provider's
  tool-call id within the run, so they cannot disagree about what "this call"
  means.
- **Scope, and why it is not every tool.** Claimed: a builtin that is not `safe`
  **and** whose category is one whose effects leave the agent's own workspace
  (`EFFECTFUL_TOOL_CATEGORY_IDS` in `@nessie/schemas` — mail, calendar, agent
  mailbox, conversation, channels, calls, projects and tickets, scheduling,
  agents, apps, browser, executors), plus everything structurally
  approval-gated, plus every MCP, HTTP-connector and executor dispatch, whose
  names are per installation and which leave Nessie by construction. Not
  claimed: read-only tools, the builtin tool-spec meta tool (it only rewrites
  this run's own view of its tool list and reaches nothing outside Nessie), and
  the agent's own workspace — knowledge, files, dashboards, workflows, to-dos,
  preferences — where a duplicate is visible to the agent and correctable on its
  next turn, and where the writes are frequent enough that a row per call would
  be paid where it buys least. Membership is by declared category, never a
  hand-kept id list, so a new tool inherits the decision from where it already
  had to say it belongs.
- **The claim decision asks the live tool view, not a copy of it.** Whether a
  call is external is a *function* over `mcpView.handledNames` and
  `executorToolset.handledNames` (`externalDispatchPredicate`), evaluated per
  call, because `agent-loop.ts` routes the dispatch by asking those same two
  objects at the same moment. A set snapshotted at loop setup would be a second
  source of truth, and the day the two disagreed the disagreement would be a
  tool dispatched to a connector with no claim behind it. The MCP view is
  mutable by the run itself — `mcp_load_tools` / `mcp_drop_tools` rewrite what
  the model can see mid-run — and `handledNames` deliberately stays the wider,
  stable set of everything the view will dispatch, loaded or not, so a name the
  model remembered from `mcp_find_tools` is still claimed. That property is
  pinned by its own test in `mcp-toolset-deferred.test.ts`; the ledger does not
  assume it.
- **One exception the category rule does not catch: `delegate`.** It declares
  `safe: true`, so the `!safe` half of the test excludes it even though its
  category is effectful. Its sub-agent is a nested loop for discovery, but the
  toolset it inherits is the parent's builtins minus `delegate` itself, so a
  sub-agent can in principle call an effectful tool. A resumed run therefore
  re-issues a delegation whose result the checkpoint never recorded, and the
  sub-agent's own calls are not separately claimed. That is not a regression —
  before any of this, every tool re-ran — but it is the one place this
  invariant's guarantee stops short, and whether `delegate` should still call
  itself safe is plan row 3.6.
- **Retention is fused to the status chokepoint.** `updateRunStatus` deletes a
  run's claims on every terminal and suspended transition, beside the crash
  state it already sheds: a terminal run is never resumed, and a suspended one
  is continued by a NEW run whose tool calls carry new ids, so from that
  statement onwards nothing can consult them. The `ON DELETE CASCADE` on
  `run_id` is the backstop for a run deleted outright.
- **What remains true.** Nothing short of a distributed transaction with the
  provider makes a side effect and its record atomic, so the ledger does not
  make a tool exactly-once: it makes the *ambiguity* durable and visible instead
  of silently resolving it as "run it again". A call interrupted in that window
  is reported to the agent as unknown, and the decision is the agent's. A
  re-entered batch also still re-emits `agent.tool.start`/`end`, so a tool that
  ran once can leave two `ToolCall` telemetry rows.
- **Resume is in place, not a continuation.** `claimRunForExecution` reports the
  pre-claim status; a `running` one means a takeover, so `executeRunJob` loads
  the crash state and the loop restores the transcript, iteration count,
  accumulator and budget instead of starting from the prompt. A tool call whose
  result is recorded is answered from the record without re-authorising or
  re-dispatching, and a mid-dispatch batch is re-entered rather than re-asked of
  the provider. `updateRunStatus` sheds the crash state on every terminal and
  suspended transition, so no finished run leaves resumable state behind.
- **Drain rides the queue's own signal.** `handler(job, { signal })` reaches
  `runAgenticLoop`; when it fires, the in-flight inference or tool batch has
  `NESSIE_RUN_DRAIN_GRACE_MS` (default 5 s) to land, then the loop throws
  `RunDrainedError`. The run stays `running`, its token and heartbeat are
  cleared so the next worker claims it on its next poll rather than waiting out
  the takeover window, and the job is nacked with reason `worker_drain`.

What this finding still owes, proved by the two-instance chaos smoke:

- **The handler is signalled at the drain deadline, not at its start.**
  `drainQueueSubscriptions` (`worker/src/lifecycle.ts`) stops the subscriptions
  and waits; the per-job `AbortSignal` fires only when the deadline passes and
  `subscription.abandon` runs, and `stop()` then closes the pool without waiting
  for the abandoned handler to unwind. So the loop reaches its checkpoint path
  with the process already exiting, and `releaseRunForDrain` never lands: the
  successor claims the released job, finds the run still carrying a fresh
  heartbeat, and skips it. The chaos smoke's check (b) fails on exactly this,
  and did before this phase too. The fix is a second `AbortController` for
  in-flight handlers, aborted at the *start* of the drain, with the drain
  awaiting `subscription.done` after abandoning — invariant 6's territory.

## 5. Boot connects and listens — nothing else

**Seeding, backfills and reconciliation belong to the post-migrate job.**
`seedDefaultPolicies` used to run on every replica at boot as a
count-then-create with no lock and no unique constraint on `PolicyRule` (1.4):
concurrent boots inserted the default set N times per organisation, and
duplicate rules at equal priority made `resolveDecision` order-dependent — a
permission answer that depended on row order. Boot also did O(orgs + agents)
sequential advisory-locked round trips before `listen()` (1.7), so cold start
scaled with tenant size and simultaneous boots serialised on the locks.

**Corollary.** Policy seeding, the protected-grant backfill, PA default grants
and the credential sweep run from `runReconcile`
(`api/src/db/reconcile-cli.ts`), invoked as
`pnpm --filter @nessie/api reconcile` after `migrate deploy` — in
`infrastructure/compose/redeploy.sh`, before the rollout, and in the first-deploy
sequence. `buildApp` and `startApiServer` do none of it; boot connects,
validates read-only config and listens.

**The one exception is `local` mode**, where `startApiServer` calls
`runReconcile` before `listen()`. A developer instance has no deploy step to
hang the job off and is single-instance by construction — it already embeds the
worker in-process for the same reason. Nothing else may take this exception:
`hosted` and `selfHosted` run the job from the deploy.

**Whatever must stay at boot takes `pg_advisory_xact_lock` on the organisation
and is backed by a partial unique index, so the lock is an optimisation and the
index is the guarantee.** Default policy rules carry a stable
`PolicyRule.seedKey` (`default:channel:view:allow:*` and friends), written with
`createMany({ skipDuplicates: true })` and constrained by
`policy_rules_organization_id_seed_key_key` on `(organization_id, seed_key)`
`WHERE seed_key IS NOT NULL`. The index is deliberately **not** over the rule's
semantic columns: a person may legitimately author two rules that differ only in
`conditions` or `priority`, and `seed_key` is NULL for every rule a person
wrote, so nothing they author is constrained. The lock is
`pg_advisory_xact_lock(hashtextextended('policy-seed:' || organizationId, 0))`,
taken by `seedDefaultPolicies` itself, so the login path — `ensureTeamPrincipal`
seeding a freshly materialized organisation inside its own transaction — and the
reconcile job serialise on the same key.

## 6. `SIGTERM` drains within the configured grace

**Sixty seconds, and the process leaves nothing half-written.** Node's default
`SIGTERM` exits immediately, so in-flight requests reset mid-transaction and
SSE/WS clients get no close frame. `app.close()` alone is not the fix either —
Fastify 5.8's `forceCloseConnections` defaults to `'idle'`, so it hangs on an
open stream. The API (1.1) and the gateway (8.3) now drain, in
`api/src/lifecycle.ts` and `gateway/src/index.ts`, each only when started as the
main module so an embedder keeps its own signals. The worker still does not, and
is worse: `stop()` aborts, clears timers and closes the pool while a handler is
still running, and the abort path returns without ack or nack (5.1,
`worker/src/index.ts:1191-1226`), so a 20-minute run dies mid-inference with its
terminal writes throwing on a closed pool.

**Corollary.** The API marks itself draining so `/api/health/ready` answers 503,
writes `event: shutdown` with `retry: 2000` and ends every SSE connection,
closes every WebSocket with 1012, then calls `app.close()` under a hard exit
timer (`NESSIE_SHUTDOWN_TIMEOUT_MS`, default 25 s) set below the platform grace.
The worker sets a draining flag first so no topic claims again, passes the
`AbortSignal` into `handler(job)` so the agentic loop reaches its
cancel/checkpoint path, awaits in-flight handlers under a deadline, and acks or
nacks before the pool closes. Drain is solved by checkpointing inside sixty
seconds, not by asking the platform for a longer grace.

**That signal is raised when the drain BEGINS, never at its deadline**, and the
distinction is the whole point: a warning that arrives when the time is already
gone buys a long run nothing. `PgQueueProvider`'s `stop()` therefore aborts the
in-flight job's `context.signal` in the same call that stops the claim loop
(`DRAIN_STARTED_REASON`), and the abort is a warning rather than a verdict — a
handler that ignores it runs to completion and is acked exactly as before, and
only the deadline's `abandon()` takes a job away. **And nothing a handler writes
through may be closed while it is still writing.** `drainQueueSubscriptions`
awaits every subscription's `done` under `NESSIE_WORKER_DRAIN_TIMEOUT_MS`,
abandons what is left (which nacks, so a successor re-claims at once rather than
waiting out the five-minute lock), then waits a second, shorter window
(`DEFAULT_WORKER_ABANDON_SETTLE_MS`) for those handlers to fall out before
`stop()` closes the transport, the pool and the Prisma client. Returning at the
nack instead is what left a run's release write executing against a closing pool,
so a successor saw a run "held by a live executor" that had already exited. The
settle window is bounded and its expiry is reported, because a handler parked in
an uninterruptible await must not hold `SIGTERM` open until the platform
`SIGKILL`s the process.

## 7. No local disk beyond per-request scratch the same request deletes

**A file one instance wrote is not there for the next call.** `filesystem` is
the default storage provider and nothing forbids it outside `local` (1.10/6.1,
`packages/config/src/index.ts:369-373`), so a deployment that forgets
`NESSIE_STORAGE_PROVIDER` writes uploads to ephemeral per-instance disk
silently. The `file_write`/`file_read`/`file_glob` builtins do raw `node:fs` I/O
on the worker's own disk under an operator-configured `allowedRoots` (6.2,
`worker/src/run/builtin-handlers/file-write.ts:60-71`), so a write on one worker
is invisible to the next tool call on another. The `docker` execution provider
shells out to the local daemon and its terminate job is routed to any worker
(6.3/8.2, `worker/src/control/execution/docker-provider.ts:105-177`).

**Corollary.** Boot is **fatal** outside `local` mode when storage is
`filesystem`, when the `docker` execution provider is enabled, or when a
toolset bundle configures `allowedRoots`. Fail at boot, not at the first tool
call — the silent version of this defect is data written to a disk that
disappears.

## 8. Instance identity is a UUID minted at boot, never `HOSTNAME`

**And every row keyed by it carries a heartbeat and is reaped.**
`execution_runners` rows are keyed by `HOSTNAME`, upserted every 30 s and never
deleted (5.7, `worker/src/index.ts:294, 834-836`,
`worker/src/control/execution/runners.ts:12-45`). With unique hostnames the
table grows two rows per boot forever; with `HOSTNAME` unset every instance
shares one label and instances renew each other's leases — the worst outcome,
because it looks like it works.

**Corollary.** Mint `randomUUID()` once at boot and carry it on the process's
context object (not a module `let` — see invariant 1). Every row keyed by it
gets a heartbeat column, and the lease sweep deletes rows whose heartbeat is
older than an hour.

## 9. Realtime publishes under a per-scope lock, so id order is commit order

**And a listener never advances a connection watermark past an id it did not
deliver.** The defect (2.1) was that insert and `NOTIFY` were two autocommit
statements on two pools, so notifications could arrive out of id order: the
per-connection watermark then dropped the lower id permanently, and because the
client's `Last-Event-ID` had already advanced past it, replay (`id > $2`) never
returned it either — the message was gone, not late. Two publishers made this
rare; N make it routine.

**One transaction is not sufficient, and this is the part worth remembering.**
Postgres delivers notifications in **commit** order, but `id`/`sequence` come
from a sequence at **insert** time. Two concurrent transactions can still commit
in the opposite order of their ids, and the listener sees the higher id first.
The fix is to make id order *equal* commit order within the scope a watermark
covers: hold `pg_advisory_xact_lock` on that scope from **before** the INSERT
until COMMIT, so the publishers sharing a watermark serialise and the sequence
is handed out and committed in the same order. The lock is released by the
COMMIT or ROLLBACK itself, so a crashed publisher cannot wedge a scope.

**Corollary.** A durable publish is one transaction on **one** pooled client:
`BEGIN`, `pg_advisory_xact_lock(hashtextextended(<scope>, 0))`, the INSERT, the
`pg_notify` carrying the returned id, `COMMIT` — `ROLLBACK` on any error, the
client always released
(`packages/runtime/src/realtime-publish.ts`). The scope is the span of the
watermark it protects, not a global lock: `realtime:thread:<threadId>` for the
SSE lane (`ThreadSseConnection.lastSequence`) and
`realtime:org:<organizationId>` for the WS lane
(`UserSseConnection.lastEventId`, which replays one organization's events for
one user). The **transport is the only writer** for both lanes — the api hub
does not persist through Prisma, because a Prisma insert cannot join that
transaction or take that lock; `api/src/services/realtime-events.ts` is replay
reads only. An **ephemeral** publish (`publishSseEphemeral`) writes no row and
moves no watermark, so it is a plain `NOTIFY` with no lock.

With the lock in place a notification at or below a connection's watermark can
only be the same event delivered twice — a LISTEN reconnect, or an old
publisher mid rolling deploy — so the listener skips it, leaves the watermark
where it is, and logs the pair of numbers at **warn** level so a publisher
regression is visible instead of silent (`api/src/realtime/hub.ts`). It never
moves a watermark past an id it did not write. On LISTEN reconnect, re-read the
backlog for every registered connection from its own watermark.

**A notification must be inert to the build it is replacing.** Deploys are
blue-green, so a replica running the previous image LISTENs on the same channel
for the length of a swap and receives everything a new one publishes. Its
fan-out runs in an *unawaited* promise and reads three fields unchecked —
`kind`; then `eventId`, and if that is a string it dereferences `message`; then
`scopes.filter`, once per WebSocket connection — so a `TypeError` there is an
unhandled rejection, and Node 22 ends the process. A new envelope shape
therefore carries nothing at its top level that an older listener dereferences.
The compact `sse-ref`/`ws-ref` forms keep everything they carry under `ref` and
hold an empty `scopes` beside it, so the old fan-out finds no event id, never
reaches `message`, matches no connection and delivers nothing; the row is
committed either way and the client's next reconnect replays it. Widen a
notification payload the same way, and remove such a shim only once no deployed
replica predates the shape.

## How to verify

- **`infrastructure/compose/docker-compose.multi.yml`** — an override that runs
  `api` × 2 and `worker` × 2 against one Postgres and one MinIO, with Caddy
  round-robining the API. **`pnpm dev:multi`** brings it up locally.
- **CI job `multi-instance-smoke`** — the mock-LLM smoke driven through that
  two-instance stack, plus a chaos step that sends `SIGTERM` to one worker
  mid-run and one API mid-stream and asserts: no duplicate messages, no run
  left in `running`/`waiting_approval` without a live lease, and SSE resumes
  with no sequence gap. Advisory until Phase 3 lands, a required check after.
- **Every PR that fixes a finding extends that smoke with the scenario that
  would have caught it**, and takes its file off the lint allowlist below in
  the same change.

The harness and the CI job are Phase 0.3 and 0.4 and land beside this file;
until they do, the names above are the contract, not a description.

## The ratchet

The root [`eslint.config.js`](../../eslint.config.js) carries a
horizontal-scaling block over `api/src/**/*.ts` and `worker/src/**/*.ts`. Like
the egress block it sits beside, **the lint is not the boundary** — Postgres is,
and this file is the rule. It exists so the tree cannot quietly grow a new
per-process authority while Phases 1–5 remove the ones that exist.

It bans two things at module scope: `let` (a memo, a cached client or a
did-we-already-do-this flag is per process by definition) and a **zero-argument**
`new Map()`/`new Set()`/`new WeakMap()`. The argument count is what separates a
store from a constant: a mutable store is created empty and filled at runtime,
while `new Set(['a', 'b'])` is a frozen lookup table and stays legal, as does an
empty collection annotated `ReadonlySet`/`ReadonlyMap`, which cannot be filled
through that binding.

Two things the ratchet does **not** catch, stated so a green lint is not read as
a proof: the selectors anchor on the program root, so per-process state held in
a closure inside a once-per-process factory is invisible to them —
`bootstrapTokenState` (1.2) and the `buckets` map inside the rate limiter (1.3)
are both that shape and neither trips the rule. Widening to every function-scoped
`let` would flag the whole tree. Judge new code against the invariants above, not
against the lint.

Every current offender is on an explicit allowlist in that block, each entry
carrying either the audit finding that owns its fix or the reason it is
genuinely per process. **The allowlist only shrinks.** A file leaves it in the
change that removes its last offense; a file joins it only with a finding number
or a per-process justification written beside it.
