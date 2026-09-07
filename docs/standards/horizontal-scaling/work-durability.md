# Work durability

How work survives the instance that was doing it — claimed, keyed, and resumable rather than owned by one process.

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
- **`withSweepLock`** — for a sweep whose body is one indivisible walk. Lives
  in `@nessie/db` (`packages/db/src/sweep-lock.ts`) as
  `withSweepLock(pool, name, fn, options?)`, returning `{ ran: true, result }`
  or `{ ran: false }`. It hashes the stable lock name to a bigint with
  Postgres' own `hashtextextended(name, 0)` — in SQL, so every caller maps a
  name to the same key with no shared hashing helper — and takes
  `pg_try_advisory_lock` on it. Four properties are load-bearing.
  **`try`:** if the lock is held the tick is **skipped**, not queued — a
  blocking `pg_advisory_lock` would pile every replica's ticks behind the
  holder and turn a slow sweep into a connection leak — and the caller treats
  "skipped" as a normal outcome, never an error. A tick that cannot get a
  connection out of the pool within `options.acquireTimeoutMs` (10 s) is a
  skip too, for the same reason and by the same contract; nothing here bounds
  the *body*.
  **Session-scoped, on a dedicated connection:** the lock is taken on one
  pooled client, that client is held for as long as `fn` runs, and the lock is
  released by a `pg_advisory_unlock` in a `finally` — or, if the process dies,
  by Postgres when the connection drops. This is why the argument is a `pg`
  `Pool` and not a `PrismaClient`: Prisma hands a connection back between
  statements, so it cannot hold a session lock at all. The transaction-scoped
  `pg_try_advisory_xact_lock` this replaced could not keep its promise. It was
  taken inside a Prisma interactive transaction, and when the body outlived
  that transaction's `timeout` Prisma aborted the transaction — releasing the
  lock — while `fn`, a plain promise nobody can cancel, kept running on the
  caller's own connection. The next replica's tick then took the lock and
  started a second body beside the first: the exact duplicate the helper
  exists to prevent. **A body that outlives its lock is now impossible**; the
  lock ends when the body does.
  **The lock connection only holds the lock:** `fn` runs against the caller's
  ordinary client, so a long walk does not accumulate a transaction's worth of
  row locks. **A connection that could not be unlocked is destroyed, not
  returned:** `client.release(err)`, because a session lock outlives the
  statement that failed, and handing that connection back would lock the sweep
  out of the whole cluster until the pool happened to recycle it.
  Callers that write through Prisma pass a pool alongside it — the API's four
  maintenance sweeps take the realtime hub's (`api/src/index.ts`), the
  registry walk takes the worker's (`worker/src/index.ts`) — rather than
  opening another pool on the same URL.

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

**A receiver enqueues and acks; it does not do the work first.** Every HTTP
receiver in this codebase answers the caller as soon as it has decided the
delivery is real — `board-sources/webhooks.ts`, `comms-webhooks.ts`,
`POST /api/events` — and two did not: trigger webhook intake dispatched the
whole fire inline, and the DeepSignal insight receiver walked a team's linked
members and wrote a digest transaction each (9.2). Neither was racy; both were
wrong at N. Latency scaled with fan-out, and — the part the audit rated INFO —
an instance recycled mid-request had already accepted an event a sender will
never send again. Autoscaling makes that recycling routine rather than
exceptional.

**What must not move is the caller's answer to "did this reach anything".** A
receiver that starts answering 202 for deliveries it will silently drop has
traded a visible misconfiguration for an invisible one, and a webhook sender has
no other channel. So the split is: validation and routing stay synchronous —
a malformed body is a 4xx and is never enqueued; `trigger-intake.ts` resolves
`resolveTriggerFireReadiness` before it queues, so a paused trigger and an agent
bound to no channel are still the 409s they were; the DeepSignal receiver
resolves the payload's enabled team, one indexed lookup, and answers
`accepted: false` when it names none — and only the fan-out is queued. What the
caller loses is what the ack cannot honestly carry: an id for a row that does not
exist yet. `POST /api/triggers/webhook` returns the `dedupeKey` its delivery will
be keyed by instead of the delivery record and `runId` it used to return, and the
insight receiver returns `insightId` and `existing` instead of a `delivered`
count.

**A handle the ack hands out has to resolve — including when the recheck
refuses.** Both handlers re-ask their synchronous question when the job is
claimed, because a trigger can be paused or unbound and a team disabled between
the 202 and the fire: acting on the permission the receiver saw is acting on
stale permission. Rechecking is right. Being *silent* about it is not, for a
caller holding a handle. A webhook fire stopped by the recheck used to write no
row at all, so the `dedupeKey` the 202 promised would name a delivery resolved
to nothing, forever, and an operator investigating found a **succeeded** queue
job and no trace of the fire — indistinguishable from one still in flight. So
every claim-time refusal writes a terminal `skipped` delivery under that exact
key, carrying the readiness reason (`TriggerFireSkipReason`: `trigger_paused`,
`agent_not_bound`, `workflow_installation_not_ready`) the receiver's own 409
would have carried a second earlier — the same vocabulary on both sides, one
enum in `@nessie/schemas`. The single case with nowhere to write is a trigger
*deleted* in the window: the delivery cascade took its rows, and the trigger's
own 404 is the answer. The DeepSignal fan-out needs no equivalent because its
recheck (`resolveEnabledExternalTeam`, `enabled: true`) precedes every write:
a team disabled after the ack receives nothing, and the insight id the ack
returned is DeepSignal's own.

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
- **Both `agents` tools are claimed, and it took giving up `safe: true` to get
  there** (plan row 3.6). `delegate` first, `spawn_subtask` beside it: the same
  wrong flag on the same category, so a fix for one alone would have left the
  worse of the two behind. Taking `delegate` first: its category was already
  `agents`, which `EFFECTFUL_TOOL_CATEGORY_IDS` already judged effectful — the
  `!safe` half of the test excluded it on its own. `safe` is a definition's
  statement that its call only reads, and a delegation does not only read: the
  sub-agent inherits the parent run's resolved builtins minus `delegate` itself
  (`worker/src/run/execute/agent-loop.ts`), so it can send mail, file a ticket
  or ring somebody. The flag was therefore wrong rather than merely
  inconvenient, and correcting it is the whole fix: nothing is added to a
  category and nothing is gated by name.

  Why claiming the *parent's* call is what matters. The crash checkpoint
  already skipped a delegation it had recorded; what it could not cover is the
  window it exists for, and in that window a resumed run re-issued the
  delegation. The second sub-agent's own effectful calls then carried NEW
  tool-call ids that matched no earlier row, so nothing deduped them — the
  duplicate sub-run reached as far as its side effects did. The parent's
  `delegate` call is the one id stable across executions, because it lives in
  the parent's own message history, so a claim on it answers the replay from
  the recorded digest and no second sub-agent is created. The row stores that
  digest — one assistant turn under `DELEGATE_BUDGET` — and replays it whole;
  `MAX_TOOL_RESULT_CHARS` truncation happens where the result enters context,
  on the replay path exactly as on the live one. Cost is negligible against
  what it guards: successful fan-out is capped at
  `NESSIE_MAX_DELEGATES_PER_RUN` (16) per run, and each claim is two statements
  beside a nested loop allowed ninety seconds and a dollar.

  **Where the guarantee still stops: the sub-agent's own calls.** They are
  dispatched inside `runDelegate`, below the seams the ledger wraps, and the
  ids they carry belong to the sub-agent's own conversation rather than to the
  parent run — `authorizeSubAgentTool` does not even have one, passing the
  literal `'sub-agent'`. So a delegation interrupted mid-flight still reports an
  unknown outcome for the whole delegation rather than for the individual call
  inside it that may have landed, which is the honest answer and the one the
  agent can act on. Claiming them separately needs a key that survives the
  sub-run, and is not in this row.

  **`spawn_subtask` is the same defect with worse damage, and the same
  one-line fix.** Same category, same flag, and nothing else was needed either.
  What differs is what a repeat leaves behind. A re-issued `delegate` produced
  a duplicate transient sub-agent; a re-issued `spawn_subtask` writes rows a
  person sees. `runSpawnSubtaskTool` (`worker/src/run/subtask-tools.ts`)
  commits a child `Agent`, its `Run` and its `Task` in one transaction and
  enqueues that run, so the resumed execution produced a second agent in the
  agent list, a second task on the board, and a second execution of the work.
  Nothing collapses the repeat onto the first: the child's name embeds a fresh
  `randomUUID().slice(0, 8)`, so there is no natural key, and the enqueue's
  idempotency key is `subtask:<parent run>:<child agent id>` — built from the
  id the second creation just minted, so the queue's `ON CONFLICT DO NOTHING`
  matches nothing either. Its claim is also cheaper than `delegate`'s in the
  only way that matters: a spawn is rare and heavyweight, so the row is paid
  once beside a whole child run.

  **`spawn_subtask` has no per-run cap of its own**, unlike `delegate`'s
  `NESSIE_MAX_DELEGATES_PER_RUN` (16) enforced by `createDelegateGate`. What
  bounds it is depth, not count: `SUBTASK_CHILD_DENIED_TOOL_IDS`
  (`worker/src/run/tool-policy.ts`) refuses the tool to any agent with a
  `parentAgentId`, so children cannot spawn children, and above that only the
  run's own `maxToolCalls`/`maxIterations` backstop applies. That recursion
  guard is structural authorization and is independent of the ledger: it is
  consulted before dispatch, on the parent's `parentAgentId`, and a claimed
  call that is answered from its row never reaches a tool at all. Claiming
  therefore neither weakens nor leans on it. The absence of a fan-out cap is
  noted, not fixed here — it is a budget question, and the ledger's job is to
  stop the *same* spawn happening twice.
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
- **Row state a run leaves outside the run gets an out-of-process reaper.** A
  status only the executing process can advance is a status a `SIGKILL` freezes
  for ever, and under autoscaling that kill is routine. `run_document_sessions`
  is the worked example (2.5): all four terminalisers — the recorder's own, both
  save paths and the failure path — run inside the worker writing the document,
  so a killed worker left a `streaming` row the API counted as active for ever.
  `worker/src/control/document-session-reaper.ts` closes it, and the shape is
  the reusable part. **Liveness, not age:** it waits out
  `claimRunForExecution`'s own takeover window, so it never calls an executor
  dead before the run claim would — reaping on age alone kills a legitimately
  long generation. **A heartbeat is a claim's liveness, not a process's:** it
  stops whenever the executor token is nulled, which `updateRunStatus` does on
  every suspension and `releaseRunForDrain` on every orderly hand-back, so a
  stale or null heartbeat says "parked" or "draining" as readily as "dead".
  Hence `pending`, `waiting_approval`, `waiting_input` and a `running` run with a
  NULL heartbeat are never reaped out of; each leaves that state eventually, and
  the terminal arm collects what they stranded. **A terminal state that says what
  happened:** `failed` with `errorReason: 'executor_lost'`, which the API's
  summary and the popup both render, because a document that silently vanishes is
  the same failure as one that never finishes. **Bounded and per-row isolated:**
  an ordered bounded batch with no per-row `try`/`catch` means a deterministically
  failing row is first again on every pass and the sweep never progresses.

- **A reaper is not a fence, so the row it reaps needs a claim of its own** —
  the same table, as the worked example twice (5.14). The four terminalisers
  wrote `run_document_sessions` by id, so an executor fenced out of its run could
  still write the session, and the two saves ended with an unconditional `update`
  that would turn a reaped `failed` back into `saved`. **The claim names the
  execution; the run says whether it still holds it:** `claim_token` stores
  `runs.executor_token` as it stood when the session opened, and every write asks
  for both halves in one statement (`run/execute/document-session-claim.ts`) —
  the two-sided fence `crash-checkpoint.ts` writes, buying what the queue buys
  with `(id, attempt)`. Identity alone would never notice a takeover, so the
  reaper stops inferring abandonment from the run and reaps only a session whose
  claim is not live, with the two executor-is-coming states named explicitly:
  before this, a session stranded by a takeover sat on a `running`, heartbeating
  run and waited out the whole resumed run. **The fence is the claim, never the status:** conditioning
  the saves on `status = 'saving'` looks like the same fix and is the wrong one,
  because by then the bytes are verified, the attachment stored and the page
  created, so a save that completes IS a document in the knowledge base under a
  pageId the agent reports in chat. A merely stalled executor still holds its run
  and its save must beat the reap — there, the reap is the stale statement. Only
  a superseded writer is refused, and a refusal is logged with both tokens. **Its completed side effects are kept:** the page
  and attachment stay, because the document is real, a fenced-out executor is the
  worst process in the deployment to issue deletes, and `run_tool_effects` already
  carries the outcome across the takeover so the successor answers from
  the record instead of writing a second page. Nothing is orphaned — the page is
  a `.md` document in its space, reachable like any other; what is left wrong is
  the popup's row, and repairing *that* is a product decision about what the
  document window should say, not an engineering one.

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