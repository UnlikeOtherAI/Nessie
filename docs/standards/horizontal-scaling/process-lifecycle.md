# Process lifecycle

What a process may hold, how it starts, and how it stops. These are the invariants a second copy of a service breaks first.

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
already implements the counter). A cache is allowed only when it is
read-through, bounded, carries a TTL, and is **never** the authority for a
decision — `knowledge-query-embedding.ts` (4.4) and the 30 s UOA roster-subject
cache (3.1) are the passing shape, and the second one documents its staleness
window in the module because the staleness is user-visible.

**A rate limit is that state, and there is one counter store for all of them.**
`packages/db/src/rate-limit-window.ts` owns the `rate_limit_buckets` statement
and every limiter in the deployment goes through it — the API's inbound
brute-force guard (`api/src/services/rate-limit.ts`) and the worker's outbound
UOA pacer (`worker/src/control/automatic-membership/rate-limit.ts`, 5.6, which
was two module-scope token buckets making the deployment-wide cap `20 × N` and
one organisation's `5 × N`). Two policies sit on that one statement and the
choice between them is explicit, never implicit:

- `countRateLimitHit` counts **every** attempt, refusals included, because an
  inbound guard wants the flood visible in the counter the lockout audit reads.
- `takeRateLimitSlot` is the **conditional UPDATE** — `DO UPDATE … WHERE count <
  max` — so a refused caller leaves the counter alone and the row is exactly the
  calls admitted in that window. An outbound pacer needs this: it polls in a
  loop while it waits and must not spend the slots it is waiting for.

**The window comes from the database's clock, not the process's.**
`window_start` is part of the conflict key, so it is the column that decides
whether two replicas are counting the same thing at all. Flooring it from
`Date.now()` meant replicas whose clocks disagreed by a fraction of a window
inserted *different* rows for the same instant and each got a private counter —
one cap per clock, with nothing in the logs to say so, and a badly skewed host
keeping its own allowance indefinitely. Derive it inside the statement, and
derive any expiry cutoff the same way: a fast pruner deleting the live window a
slower replica is still counting in widens the cap just as silently. Fleet clock
sync must never be a correctness input.

Three rules for a pacer built on it. **It waits, it does not throw**, when its
callers are walking a large collection and have nowhere to put a refusal.
**Nothing is held while it sleeps** — each attempt is one statement on a
connection the pool takes straight back, and never a transaction, because a
waiter parked on a pooled connection is how N instances exhaust a pool. **The
wait is bounded, the ceiling is drawn per call, and what happens at it is itself
capped.** An unbounded loop against a contended deployment-wide bucket parks the
job forever, invisibly, because the queue keeps renewing its lock — so there has
to be a ceiling. But a ceiling that simply admits is not a cap: with W waiters
it is `W ÷ ceiling` calls per second, unbounded in W, and if every waiter shares
the same constant they park together and discharge together, which is the same
herd through a different door. The automatic-membership pacer draws its ceiling
uniformly from 30–60 s per call, then competes for a third counted allowance
(2/s deployment-wide) rather than bypassing the limiter, and only proceeds
uncounted at 4× its own draw — still inside the queue's 300 s lock TTL, and at
error level when it happens. Admitting rather than refusing is right here
because no caller has a better "refused" branch than failing a person's
membership grant; a limiter guarding an authorization decision would have to
choose the other way and say so.

**A failure in the limiter's housekeeping must not impersonate a limiter
outage.** The expired-row sweep runs on a fraction of admitted calls, after the
store has already answered; letting its error reach the fail-open handler made a
failed `DELETE` print `FAIL-OPEN … allowing the call` when nothing extra had
been allowed. `FAIL-OPEN` means the cap is off right now. Nothing else may say
it.

What a fixed window guarantees, stated so nobody over-claims it: `max` per
window, and at worst `2 × max` across a sliding window. That bound does not grow
with the replica count, which is the property being bought. State the guarantee
the code actually delivers, not an estimate that holds for one waiter.

**And a number an operator reads is labelled with what it covers.** Postgres
counters fixed enforcement, not reporting: `/api/ops/health` answered with
`RateLimiter`'s in-process tallies (1.13), so on a fleet of N the "limited"
figure was whatever share of a flood reached the replica the operator was talking
to. `summarizeRateLimitWindows` reads each bucket's current window off the shared
rows, and the response keeps `deploymentWide` and `thisInstance` apart — a mixed
bag with no labelling is worse than what it replaced, because a reader cannot tell
which figures to divide by N. Keep a per-process counter only where a fleet-wide
read cannot reach, like `storeErrors`; a failed read answers `available: false`.
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

**Exactly one of acknowledge and nack is ever applied to a job.** The deadline
and the handler both want to settle the row, they issue their statements on
different pooled connections, and nothing orders those two commits — so a
handler resolving in the same tick the deadline fires must not produce both.
`PgQueueProvider` gives each in-flight job a synchronous single-writer gate
(`claimSettle`): whoever takes it issues the only statement, and the loser
issues none. Reading a flag before the acknowledge and never re-checking is what
let a completed job go back to `pending` for a second worker to run when the
nack committed last, and let a row the successor already held flip to `done`
mid-run when the acknowledge did.

**And whichever one is applied must still own the job.** `claimNextJob`
increments `attempt` on every claim and hands it back, so `(id, attempt)` is the
identity of the *claim* rather than of the row, and every statement that speaks
for a claim carries it: `renewLock` and both settles. Matching on the id alone
let a worker whose lease had expired settle a job another instance had already
re-claimed and was running — its nack put that job back to `pending` for a third
worker to pick up beside the second, its acknowledge marked it `done` mid-run,
and the successor's own honest nack later resurrected a completed job. A settle
that matches zero rows is a lost race, not a no-op: it returns `false` and is
logged with the job, the topic and *both* attempts, because the difference
between them is the whole diagnosis. The attempt belongs in the renewal fence
for the same reason — a re-claim leaves the row `processing`, so a status-only
fence let the superseded owner go on renewing, extending its successor's lock
and never learning it had lost, where naming the attempt makes it miss twice and
have its handler aborted. That abort is how a lost claim takes the loser's
in-flight work away; a refused settle is only ever the report that it happened.

**And the shutdown itself is bounded end to end, once.** The settle window buys
nothing if the close that follows it can block forever: `pool.end()` resolves
only when every checked-out client is back, and a handler already written off —
parked on a row lock its successor now holds — never returns its one. The
transports therefore close in order under one shared hard deadline
(`DEFAULT_WORKER_TEARDOWN_TIMEOUT_MS`, 10 s; 25 + 5 + 10 leaves twenty seconds
of the grace unspent), and when that deadline is what ended the shutdown it says
so and names the transport still closing. `stop()` is memoised, because `SIGINT`
and `SIGTERM` are both registered and an operator's Ctrl-C during an
orchestrator's `SIGTERM` drain otherwise ran a second drain and a second
`pool.end()` — which pg rejects, and which the signal handler's floating promise
turned into an unhandled rejection that killed the process mid-shutdown. The
second signal joins the first.

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
