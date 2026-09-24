import { writeAuditEntry } from '@nessie/db'
import {
  recordLegacyDeepWaterCancel,
  recordLegacyDeepWaterCancelFailure,
  type DeepWaterBriefRun,
} from '@nessie/runtime'
import {
  LedgerResearchStatusDtoSchema,
  type AuditAction,
  type DeepWaterBriefActionJobPayload,
  type DeepWaterPendingActionErrorCode,
} from '@nessie/schemas'

import type { DeepWaterLedgerOutcome } from '../run/deepwater-ledger-call.js'
import { runDeepWaterTransaction } from './deepwater-announce.js'
import { pendingActionErrorForLedger } from './deepwater-brief-action-errors.js'
import type { DeepWaterWatchDeps } from './deepwater-watch.js'

/**
 * What became of a cancel Nessie sent through Ledger (Water plan amendments
 * N8.5, N9.6, amendments-fable F3). The API records an owner's cancel as
 * `integration.research.cancel_requested` when it accepts it; only here, with
 * Ledger's answer, is it recorded as `integration.research.cancelled` — with
 * `success` when the research is cancelled, `denied` when Ledger refused, and
 * `error` when Ledger could not be asked or answered outside its contract.
 *
 * A launcher run's cancel that did not go through is also written on the run
 * (`recordLegacyDeepWaterCancelFailure`), so its view says why it is still
 * open; a brief's is already there, as its cancel action's error.
 */

export type DeepWaterCancelOutcome =
  | { kind: 'cancelled' }
  | {
      kind: 'not_cancelled'
      audit: 'denied' | 'error'
      /** The reason the run shows, in the brief dialog's vocabulary. */
      code: DeepWaterPendingActionErrorCode
      /** The audit's reason: Ledger's own code, or what stopped Nessie asking. */
      reason: string
    }

const notCancelled = (
  audit: 'denied' | 'error',
  code: DeepWaterPendingActionErrorCode,
  reason: string,
): DeepWaterCancelOutcome => ({ kind: 'not_cancelled', audit, code, reason })

/** The action gave up: Ledger stayed unreachable for the whole retry window. */
export const DEEP_WATER_CANCEL_GAVE_UP = notCancelled('error', 'unavailable', 'ledger_unreachable')

/** The run could not take the cancel when the job ran (no research id, or no connector). */
export const DEEP_WATER_CANCEL_NOT_SENDABLE = notCancelled('error', 'not_ready', 'not_sendable')

/** Ledger's final answer to `research_cancel` (a transient one is retried, never judged). */
export const deepWaterCancelOutcome = (answer: DeepWaterLedgerOutcome): DeepWaterCancelOutcome => {
  switch (answer.outcome) {
    case 'ok': {
      const parsed = LedgerResearchStatusDtoSchema.safeParse(answer.structured)
      if (!parsed.success) return notCancelled('error', 'rejected', 'answer_outside_contract')
      if (parsed.data.status === 'cancelled') return { kind: 'cancelled' }
      // It ended some other way before the cancel reached it.
      return notCancelled('denied', 'rejected', `research_${parsed.data.status}`)
    }
    case 'refused':
      return notCancelled('denied', pendingActionErrorForLedger(answer.error), answer.error.code)
    case 'identity':
      return notCancelled('error', 'identity_required', 'identity_unavailable')
    case 'connector_missing':
      return notCancelled('error', 'not_ready', 'connector_missing')
    case 'malformed':
      return notCancelled('error', 'rejected', 'answer_outside_contract')
    case 'unavailable':
      return DEEP_WATER_CANCEL_GAVE_UP
  }
}

/**
 * Is this cancel one the audit follows to its end? An owner's or admin's
 * cancel of someone's research, and every launcher run's cancel (only owners
 * and admins may send one). A requester cancelling their own brief is on
 * Ledger's record as themselves, as every other brief action is.
 */
export const isAuditedDeepWaterCancel = (run: DeepWaterBriefRun, payload: DeepWaterBriefActionJobPayload): boolean =>
  payload.action.kind === 'cancel' && (run.scopeState === null || payload.actor.role === 'owner')

const AUDIT_ACTION: AuditAction = 'integration.research.cancelled'

/**
 * Record the cancel's outcome, naming whoever cancelled as the actor. Like
 * every audit write it never takes down the work it describes: a failure is
 * logged, and the run already says what happened.
 */
export const auditDeepWaterCancelOutcome = async (
  deps: Pick<DeepWaterWatchDeps, 'prisma'>,
  run: DeepWaterBriefRun,
  payload: DeepWaterBriefActionJobPayload,
  outcome: DeepWaterCancelOutcome,
): Promise<void> => {
  try {
    await writeAuditEntry(deps.prisma, {
      organizationId: run.organizationId,
      teamId: run.teamId,
      actorType: 'user',
      actorId: payload.actor.userId,
      action: AUDIT_ACTION,
      resourceType: 'product_integration_run',
      resourceId: run.id,
      outcome: outcome.kind === 'cancelled' ? 'success' : outcome.audit,
      reason: outcome.kind === 'cancelled' ? null : outcome.reason,
      metadata: {
        productSlug: 'deep-water',
        requestedByUserId: run.requestedByUserId,
        via: run.scopeState === null ? 'launcher_ledger' : 'owner',
        actionId: payload.actionId,
      },
      requestId: `deep-water-cancel:${payload.actionId}`,
    })
  } catch (error) {
    console.error(`[deep-water] cancel ${payload.actionId} on run ${run.id}: audit write failed`, error)
  }
}

/**
 * Finish a launcher run's cancel with its outcome: record it cancelled once
 * Ledger agrees, or record why not on the run; then audit it.
 */
export const finishLauncherCancel = async (
  deps: DeepWaterWatchDeps,
  run: DeepWaterBriefRun,
  payload: DeepWaterBriefActionJobPayload,
  outcome: DeepWaterCancelOutcome,
): Promise<void> => {
  const target = { organizationId: run.organizationId, runId: run.id }
  const researchId = run.externalRunId
  await runDeepWaterTransaction(deps, async (tx, announce) => {
    const recorded = outcome.kind === 'cancelled' && researchId !== null
      ? await recordLegacyDeepWaterCancel(tx, { ...target, researchId })
      : outcome.kind === 'not_cancelled'
        ? await recordLegacyDeepWaterCancelFailure(tx, { ...target, actionId: payload.actionId, code: outcome.code })
        : false
    if (recorded) announce.run(run)
  })
  if (outcome.kind === 'cancelled') {
    console.info(`[deep-water] launcher run ${run.id}: cancelled through Ledger by ${payload.actor.userId}`)
  } else {
    console.error(`[deep-water] launcher run ${run.id}: Ledger did not cancel it (${outcome.reason}); `
      + 'the run stays open and its view says why')
  }
  await auditDeepWaterCancelOutcome(deps, run, payload, outcome)
}
