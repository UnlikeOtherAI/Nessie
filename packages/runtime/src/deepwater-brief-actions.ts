import { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  DEEP_WATER_BRIEF_ACTION_TOPIC,
  DeepWaterBriefActionJobPayloadSchema,
  DeepWaterFailureCodeSchema,
  DeepWaterScopeStateSchema,
  deepWaterBriefActionJobKey,
  type DeepWaterBriefActionJobPayload,
  type DeepWaterPendingActionErrorCode,
  type DeepWaterPendingActionKind,
} from '@nessie/schemas'

import { deepWaterWatchDelayMs, isPendingActionInFlight } from './deepwater-brief-registers.js'
import {
  deepWaterBriefJson,
  lockDeepWaterBriefRun,
  type DeepWaterBriefDb,
  type DeepWaterBriefRun,
} from './deepwater-brief-run-record.js'

/**
 * A person's action on a brief (open, reply, launch, cancel) is persisted and
 * enqueued in one transaction by the API, and carried out by the worker — the
 * only process that calls Ledger (Water plan contract D10). One action is in
 * flight per brief; `scope_json.pendingAction` is that action.
 */

/** How soon the Ledger watch looks at a brief after a person acted on it (amendments-fable F1). */
export const DEEP_WATER_ACTIVE_WATCH_DELAY_MS = 5_000

/**
 * How long an action's job keeps retrying a Ledger that cannot be reached,
 * from when Nessie accepted the action (amendments N5); then it gives up.
 */
export const DEEP_WATER_ACTION_RETRY_WINDOW_MS = 30 * 60_000

/**
 * Brief actions retry transient Ledger failures with `QueueRetryAfterError`,
 * which does not consume attempts; this bounds genuine handler crashes.
 */
const BRIEF_ACTION_MAX_ATTEMPTS = 3

const ACTION_KIND_FOR_JOB: Record<DeepWaterBriefActionJobPayload['action']['kind'], DeepWaterPendingActionKind> = {
  scope_start: 'scope_start',
  reply: 'reply',
  launch: 'launch',
  cancel: 'cancel',
}

/** A brief action as a route asks for it; the time it is accepted is stamped under the row lock. */
export type DeepWaterBriefActionRequest = Omit<DeepWaterBriefActionJobPayload, 'acceptedAt'>

/** Enqueue a brief action inside the caller's transaction; a replayed key is a no-op. */
export const enqueueDeepWaterBriefAction = async (
  tx: DeepWaterBriefDb,
  payload: DeepWaterBriefActionJobPayload,
): Promise<boolean> => {
  const parsed = DeepWaterBriefActionJobPayloadSchema.parse(payload)
  return enqueueQueueJob(tx, {
    idempotencyKey: deepWaterBriefActionJobKey(parsed.runId, parsed.actionId),
    maxAttempts: BRIEF_ACTION_MAX_ATTEMPTS,
    payload: parsed,
    topic: DEEP_WATER_BRIEF_ACTION_TOPIC,
  })
}

export type DeepWaterPersonActionStart =
  | { kind: 'started'; run: DeepWaterBriefRun }
  /**
   * This actionId was accepted before — it is in flight, finished, or settled
   * with an error — so the request is a replay and nothing is re-armed.
   */
  | { kind: 'replay'; run: DeepWaterBriefRun }
  /** Another action is in flight (or the brief is still opening and cannot be cancelled yet). */
  | { kind: 'busy'; run: DeepWaterBriefRun }
  | { kind: 'not_found' }

/** Was this action accepted before? Its queue job key outlives the job. */
const wasActionAccepted = async (tx: DeepWaterBriefDb, runId: string, actionId: string): Promise<boolean> => {
  const rows = await tx.$queryRaw<Array<{ accepted: boolean }>>(Prisma.sql`
    SELECT true AS "accepted" FROM "queue_jobs"
    WHERE "idempotency_key" = ${deepWaterBriefActionJobKey(runId, actionId)}
  `)
  return rows.length > 0
}

/**
 * Record a person's action as in flight and enqueue it, atomically. The
 * `precondition` runs under the row lock, so a route's checks (the requester,
 * the brief still drafting, the revision it was edited against) are decided
 * on the same state the action is recorded on; it throws to refuse.
 *
 * Each actionId is carried out once (contract §1): its queue job key outlives
 * the job, so a request whose key is already there is a replay whether that
 * action is still in flight, finished, or failed — it is never recorded as in
 * flight again with no job to finish it. That is decided first, before the
 * busy check and the `precondition`: a retry whose first response was lost
 * finds the brief moved on by its own action (a newer revision, launched, or
 * another action now in flight), and judging it against that state would
 * refuse it — and a refused person resends with a new actionId, paying for a
 * second planner turn.
 *
 * A cancel is accepted while another action is in flight: stopping a brief
 * must never wait on the planner. It replaces that action, whose own late ack
 * then finds nothing to settle. The one exception is the opening
 * `scope_start` before Ledger acknowledged it: until then there is no research
 * id to cancel, and the brief may be opening in Ledger at that moment, so a
 * cancel accepted then would leave a paid planner turn with nothing to stop
 * it. The cancel is refused as busy for those few seconds.
 *
 * The job's `acceptedAt` is stamped here, from the same clock read as the
 * action's `since`.
 */
export const beginDeepWaterPersonAction = async (
  tx: DeepWaterBriefDb,
  input: {
    job: DeepWaterBriefActionRequest
    precondition?: (run: DeepWaterBriefRun) => void
  },
): Promise<DeepWaterPersonActionStart> => {
  const locked = await lockDeepWaterBriefRun(tx, { organizationId: input.job.organizationId, runId: input.job.runId })
  if (!locked) return { kind: 'not_found' }
  const { run, now } = locked
  const job = DeepWaterBriefActionJobPayloadSchema.parse({ ...input.job, acceptedAt: now.toISOString() })
  if (run.scopeState === null) {
    throw new Error(`DeepWater run ${run.id} is a legacy launcher run, not a research brief`)
  }
  // Under the row lock every acceptance of this run has committed or is still
  // waiting behind us, so the key read here is the whole answer.
  if (await wasActionAccepted(tx, run.id, job.actionId)) return { kind: 'replay', run }
  const current = run.scopeState.pendingAction
  if (isPendingActionInFlight(current)) {
    if (job.action.kind !== 'cancel') return { kind: 'busy', run }
    if (current.kind === 'scope_start' && run.externalRunId === null) return { kind: 'busy', run }
  }
  input.precondition?.(run)

  if (!await enqueueDeepWaterBriefAction(tx, job)) {
    // An action is accepted only under this row's lock, or in the transaction
    // that creates the row (the opening `scope_start`), so a key that appeared
    // since the read above is a broken invariant, not a replay to wave through.
    throw new Error(`DeepWater action ${job.actionId} on run ${run.id} was accepted outside the run's lock`)
  }
  const state = DeepWaterScopeStateSchema.parse({
    ...run.scopeState,
    pendingAction: {
      kind: ACTION_KIND_FOR_JOB[job.action.kind],
      actionId: job.actionId,
      since: job.acceptedAt,
      turnId: null,
      error: null,
    },
  })
  await tx.productIntegrationRun.update({
    where: { id: run.id },
    data: {
      scopeJson: deepWaterBriefJson(state),
      reconcileAfter: new Date(now.getTime() + DEEP_WATER_ACTIVE_WATCH_DELAY_MS),
    },
  })
  return { kind: 'started', run: { ...run, scopeState: state } }
}

/**
 * Settle the in-flight action `actionId` with a synchronous Ledger outcome:
 * null clears it, a code records why it ended. Conditional on the action still
 * being the one in flight, so a late job can never re-arm or overwrite an
 * action a read, a newer action or a cancel already settled.
 */
export const settleDeepWaterPersonAction = async (
  tx: DeepWaterBriefDb,
  input: {
    organizationId: string
    runId: string
    actionId: string
    errorCode: DeepWaterPendingActionErrorCode | null
  },
): Promise<boolean> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  if (!locked?.run.scopeState) return false
  const { run, now } = locked
  const current = run.scopeState?.pendingAction ?? null
  if (!isPendingActionInFlight(current) || current.actionId !== input.actionId) return false

  const pendingAction = input.errorCode === null
    ? null
    : { ...current, error: { code: input.errorCode, at: now.toISOString() } }
  await tx.productIntegrationRun.update({
    where: { id: run.id },
    data: { scopeJson: deepWaterBriefJson(DeepWaterScopeStateSchema.parse({ ...run.scopeState, pendingAction })) },
  })
  return true
}

/**
 * Ledger refused a launch after it had already moved the research to
 * `starting` — an inline Water 409 whose code starts with `scope-` (amendments
 * L3) — so the research is back to `drafting` in Ledger. A watch read may have
 * seen `starting` (reported as `running`) meanwhile and moved the run on, and
 * no later read can tell that revert from a stale read: the projection only
 * advances. So only the launch job that got the refusal moves the run back,
 * clearing `launched_at` and settling its action with `errorCode`, and only
 * while that launch is the action in flight.
 */
export const revertDeepWaterLaunch = async (
  tx: DeepWaterBriefDb,
  input: {
    organizationId: string
    runId: string
    actionId: string
    errorCode: DeepWaterPendingActionErrorCode
  },
): Promise<boolean> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  const scopeState = locked?.run.scopeState
  if (!locked || !scopeState) return false
  const { run, now } = locked
  const action = scopeState.pendingAction
  if (
    !isPendingActionInFlight(action)
    || action.kind !== 'launch'
    || action.actionId !== input.actionId
    || (run.status !== 'drafting' && run.status !== 'running')
  ) {
    return false
  }

  const state = DeepWaterScopeStateSchema.parse({
    ...scopeState,
    pendingAction: { ...action, error: { code: input.errorCode, at: now.toISOString() } },
  })
  const delayMs = deepWaterWatchDelayMs({ status: 'drafting', state, msSinceLastChange: 0 })
  await tx.productIntegrationRun.update({
    where: { id: run.id },
    data: {
      status: 'drafting',
      launchedAt: null,
      scopeJson: deepWaterBriefJson(state),
      ledgerObservedAt: now,
      reconcileAfter: new Date(now.getTime() + delayMs),
    },
  })
  return true
}

/**
 * A brief Ledger definitively refused to open (a scope start or an agent's
 * claim that never got a research id) is failed. It never had a research, so
 * there is nothing to deliver and nothing for the watch to read.
 *
 * The action in flight — a person's opening `scope_start`, the only one an
 * unopened brief can hold — ends with `actionErrorCode` in the same write, so
 * the brief never shows a failed run whose planner is still "replying".
 */
export const failUnstartedDeepWaterBrief = async (
  tx: DeepWaterBriefDb,
  input: {
    organizationId: string
    runId: string
    failureCode: string
    actionErrorCode: DeepWaterPendingActionErrorCode
  },
): Promise<boolean> => {
  const failureCode = DeepWaterFailureCodeSchema.parse(input.failureCode)
  const locked = await lockDeepWaterBriefRun(tx, input)
  const scopeState = locked?.run.scopeState
  if (!locked || !scopeState) return false
  const { run, now } = locked
  if (run.status !== 'queued' || run.externalRunId !== null) return false

  const action = scopeState.pendingAction
  const state = DeepWaterScopeStateSchema.parse({
    ...scopeState,
    pendingAction: isPendingActionInFlight(action)
      ? { ...action, error: { code: input.actionErrorCode, at: now.toISOString() } }
      : action,
  })
  await tx.productIntegrationRun.update({
    where: { id: run.id },
    data: { status: 'failed', failureCode, completedAt: now, scopeJson: deepWaterBriefJson(state) },
  })
  return true
}
