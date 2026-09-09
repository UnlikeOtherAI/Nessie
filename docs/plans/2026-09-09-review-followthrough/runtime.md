# Runtime reliability plans

## 1. Recover retryable runs

**Owner:** Sol, with item 2 under the same lifecycle ownership.

`run-failure-path.ts` intentionally retries fatal tool failures, but
`run-job.ts` stops its heartbeat without releasing its fresh run claim. The
next attempt then acknowledges the job as work held by another executor.

1. Reproduce with the real Postgres queue, including the fresh-heartbeat case.
2. Generalize the existing drain handback into an explicit, fenced handback for
   an intentional retry. Preserve the crash checkpoint and tool-effect ledger.
3. Ensure a superseded worker cannot release the successor's claim and that
   a failed handback leaves recoverable work rather than an acknowledged job.
4. Verify the retry claims the same run immediately, resumes safely and reaches
   a terminal state without repeating a completed side effect.

**Acceptance:** attempt 1 fails with `FatalToolExecutionError`, attempt 2
completes; no orphaned running row or duplicated effect. Include final-attempt,
drain and lost-fence cases. Update run lifecycle and horizontal-scaling docs.

## 2. Commit success once

**Owner:** Sol. Implement beside 1 because both change terminal/retry ownership.

`completion.ts` posts the answer and marks success before several fallible
operations. The outer catch can subsequently terminalize the same run as failed.

1. Identify which answer, run/task state, plan/delegation state and follow-up
   intent must be durable together. Define one monotonic success boundary.
2. Commit that state atomically under the current executor fence. Do not hold
   an interactive database transaction across network or provider operations.
3. Persist required follow-up intents through the existing transactional queue
   or outbox owner, with stable idempotency keys. Notifications may fail after
   commit without rewriting success; required continuations must be retried.
4. Route completion replay and failure handling through the same terminal
   decision. Avoid blanket catches that silently lose work.

**Acceptance:** inject failures at each post-answer phase and restart between
commit and delivery. Exactly one answer and terminal success remain; required
follow-ups eventually complete once. Preserve restricted-reply disclosure and
live-stream ordering. Update run lifecycle, queue and agent communication docs.

## 3. One retry owner per scheduled occurrence

**Owner:** Terra, independent PR/worktree.

`trigger-run.ts` records a failed delivery and retry, while the scheduler also
changes `nextRunAt` to a new occurrence one minute later.

1. Reproduce the failed-dispatch, successful-delivery-retry, subsequent-sweep
   sequence for a one-off trigger and a recurring trigger.
2. Distinguish failure before a delivery exists from failure whose durable
   delivery already owns retries. Return a structural result for that decision.
3. Advance or settle the schedule from its original occurrence once delivery
   ownership is durable. Retain bounded retries for failures before ownership.
4. Preserve conditional scheduler claims, dedupe keys and exhausted-delivery
   visibility; do not introduce a second retry queue.

**Acceptance:** one run/kickoff after sweeping past the retry minute, unchanged
cron/interval cadence, correct one-off terminal state, safe two-replica races.
Update scheduling/retry docs and extend the existing database harness.

## 4. Bounded authorized agent history

**Owner:** Terra. Rebase on any overlapping conversation-read changes first.

`loadAgentMessages` in `api/src/services/agent-read-model.ts` fetches all
candidates and resolves disclosure per message before slicing one page.

1. Establish a bounded database/query budget with mixed restricted/readable
   history. Inventory existing REST and admin pagination consumers.
2. Use the canonical batched disclosure accessor and a stable cursor order
   with an id tie-breaker. Scan only a bounded candidate batch per request.
3. Return a continuation even when a scanned batch contains no visible rows;
   never expose withheld counts. Remove an exact total if computing it requires
   scanning the entire history, updating the shared contract and consumers.
4. Preserve live grants, grant expiry and channel access across page requests.

**Acceptance:** a large history has capped query work; every entitled result
can eventually be paged; restricted content and counts stay hidden. Test
concurrent inserts, tied timestamps and mid-pagination revocation. Verify the
existing agent-history surface and update its disclosure/pagination contract.
