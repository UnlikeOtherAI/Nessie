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

import { isPendingActionInFlight } from './deepwater-brief-registers.js'
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
  /** The same actionId is already in flight: a replayed request. */
  | { kind: 'replay'; run: DeepWaterBriefRun }
  /** Another action is in flight. */
  | { kind: 'busy'; run: DeepWaterBriefRun }
  | { kind: 'not_found' }

/**
 * Record a person's action as in flight and enqueue it, atomically. The
 * `precondition` runs under the row lock, so a route's checks (the requester,
 * the brief still drafting, the revision it was edited against) are decided
 * on the same state the action is recorded on; it throws to refuse.
 *
 * A cancel is accepted while another action is in flight: stopping a brief
 * must never wait on the planner. It replaces that action, whose own late ack
 * then finds nothing to settle.
 */
export const beginDeepWaterPersonAction = async (
  tx: DeepWaterBriefDb,
  input: {
    job: DeepWaterBriefActionJobPayload
    precondition?: (run: DeepWaterBriefRun) => void
  },
): Promise<DeepWaterPersonActionStart> => {
  const job = DeepWaterBriefActionJobPayloadSchema.parse(input.job)
  const locked = await lockDeepWaterBriefRun(tx, { organizationId: job.organizationId, runId: job.runId })
  if (!locked) return { kind: 'not_found' }
  const { run, now } = locked
  if (run.scopeState === null) {
    throw new Error(`DeepWater run ${run.id} is a legacy launcher run, not a research brief`)
  }
  const current = run.scopeState.pendingAction
  if (isPendingActionInFlight(current)) {
    if (current.actionId === job.actionId) return { kind: 'replay', run }
    if (job.action.kind !== 'cancel') return { kind: 'busy', run }
  }
  input.precondition?.(run)

  const state = DeepWaterScopeStateSchema.parse({
    ...run.scopeState,
    pendingAction: {
      kind: ACTION_KIND_FOR_JOB[job.action.kind],
      actionId: job.actionId,
      since: now.toISOString(),
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
  await enqueueDeepWaterBriefAction(tx, job)
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
 * A brief Ledger definitively refused to open (a scope start or an agent's
 * claim that never got a research id) is failed. It never had a research, so
 * there is nothing to deliver and nothing for the watch to read.
 */
export const failUnstartedDeepWaterBrief = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; failureCode: string },
): Promise<boolean> => {
  const updated = await tx.productIntegrationRun.updateMany({
    where: {
      id: input.runId,
      organizationId: input.organizationId,
      externalRunId: null,
      status: 'queued',
      uoaIdentity: { not: Prisma.DbNull },
    },
    data: {
      status: 'failed',
      failureCode: DeepWaterFailureCodeSchema.parse(input.failureCode),
      completedAt: new Date(),
    },
  })
  return updated.count === 1
}
