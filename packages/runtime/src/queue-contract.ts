// What the queue is, with no statement in sight. `queue.ts` is how Postgres
// does it and re-exports everything here, so a consumer keeps importing the
// queue from one place.

export type QueueJob = {
  attempt: number
  enqueuedAt: string
  id: string
  maxAttempts: number
  payload: unknown
  topic: string
}

// One worker's hold on a row, not the row. `claimNextJob` increments `attempt`
// on every claim and returns it, so `(id, attempt)` is the claim's identity: a
// superseded owner still knows the id, but never the attempt the row carries
// now. Every statement that speaks for a claim — renewal and both settles — is
// fenced on the pair, so a settle from a worker whose lease expired and whose
// job another instance re-claimed matches zero rows instead of flipping a job
// somebody else is running back to `pending`, or marking it `done` mid-run.
export type QueueJobClaim = {
  attempt: number
  id: string
  topic: string
}

export type QueueHandlerContext = {
  // Aborted when the subscription's own signal aborts, when the job's lock is
  // lost, or when a drain BEGINS — not when it runs out of time. A long handler
  // (an agentic run) should reach its cancel/checkpoint path on it, and it only
  // gets to do that if it is told at the start of the grace window rather than
  // at the end of it.
  //
  // What ignoring it costs depends on WHY it aborted, and the three reasons
  // differ:
  //
  // - **Drain begun.** A warning, not a verdict. A handler that ignores it runs
  //   to completion and is acked exactly as before.
  // - **Lock lost.** The job is already gone. Two consecutive renewal failures
  //   abort the handler precisely because the claim is no longer ours, and the
  //   settle that follows is a nack, not an ack — so ignoring this one does not
  //   keep the claim, it only wastes the rest of the work. If a successor has
  //   re-claimed the row, even that nack is refused by the fence.
  // - **Deadline (`abandon`).** The job is taken away outright.
  signal: AbortSignal
}

export type QueueHandler = (job: QueueJob, context: QueueHandlerContext) => Promise<void>

// The handle `subscribe` hands back. `stop()` is the graceful half of a drain:
// the loop takes no new job, the job it holds is told the drain has begun (its
// `context.signal` aborts), and `done` resolves once that job has been acked or
// nacked. `abandon()` is the ungraceful half, for a caller that has run out of
// patience.
export type QueueSubscription = {
  abandon(reason: string): Promise<void>
  done: Promise<void>
  stop(): void
}

export interface QueueProvider {
  // Both settles take the claim, never a bare job id, and both report whether
  // the write applied. `false` says this worker no longer owns the row — swept,
  // dead-lettered, or re-claimed by another instance — exactly as `renewLock`
  // reports a renewal that matched no row. There is deliberately no unfenced
  // overload: a caller that cannot name the attempt it claimed is not entitled
  // to settle the job.
  acknowledge(claim: QueueJobClaim): Promise<boolean>
  nack(claim: QueueJobClaim, reason?: string): Promise<boolean>
  subscribe(
    topic: string,
    handler: QueueHandler,
    options?: { pollIntervalMs?: number; signal?: AbortSignal },
  ): QueueSubscription
}

export const LOCK_RENEWAL_FAILED_REASON = 'lock_renewal_failed'
export const LOCK_EXPIRED_AT_MAX_ATTEMPTS_REASON = 'lock_expired_at_max_attempts'
// `signal.reason` when the abort came from the drain starting rather than from
// a lost lock or an exhausted deadline. A handler that wants to tell "wind down
// and hand the work back" apart from "you no longer hold this row" reads it.
export const DRAIN_STARTED_REASON = 'worker_drain_started'
