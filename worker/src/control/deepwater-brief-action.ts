import type { Prisma } from '@prisma/client'
import {
  DEEP_WATER_ACTION_RETRY_WINDOW_MS,
  QueueRetryAfterError,
  applyDeepWaterLaunchTicket,
  applyDeepWaterScopeResult,
  applyDeepWaterStatusRead,
  failUnstartedDeepWaterBrief,
  isLauncherCancelInFlight,
  isPendingActionInFlight,
  readDeepWaterBriefRun,
  refreshDeepWaterRunIdentity,
  revertDeepWaterLaunch,
  settleDeepWaterPersonAction,
  type DeepWaterBriefRun,
  type DeepWaterProjectionOutcome,
} from '@nessie/runtime'
import {
  LedgerResearchStatusDtoSchema,
  LedgerResearchTicketSchema,
  LedgerScopeResultSchema,
  deepWaterScopeStartLedgerArgs,
  toLedgerBriefSettings,
  type DeepWaterBriefActionJobPayload,
  type DeepWaterPendingActionErrorCode,
} from '@nessie/schemas'

import {
  callDeepWaterLedgerTool,
  deepWaterSystemAttribution,
  isTransientLedgerRefusal,
  type DeepWaterLedgerOutcome,
} from '../run/deepwater-ledger-call.js'
import { runDeepWaterTransaction, type DeepWaterAnnouncements } from './deepwater-announce.js'
import { pendingActionErrorForLedger, revertsLaunch } from './deepwater-brief-action-errors.js'
import {
  DEEP_WATER_CANCEL_GAVE_UP,
  DEEP_WATER_CANCEL_NOT_SENDABLE,
  auditDeepWaterCancelOutcome,
  deepWaterCancelOutcome,
  finishLauncherCancel,
  isAuditedDeepWaterCancel,
  type DeepWaterCancelOutcome,
} from './deepwater-cancel-outcome.js'
import { ensureDeepWaterResearchCard } from './deepwater-messages.js'
import type { DeepWaterWatchDeps } from './deepwater-watch.js'

/**
 * A person's brief action, carried out by the worker (Water plan nessie.md
 * §7.3, contract D10): the API recorded it as the action in flight and
 * enqueued it; this job makes the one Ledger call it stands for — open, reply,
 * launch or cancel — over the run's own team connector, as the acting person
 * with the live identity the request carried, and applies the answer.
 *
 * - An answer goes through the same projection every Ledger read uses, so the
 *   ack, the watch and a replay converge on one state in any order.
 * - Ledger's refusal ends the action with a code the brief dialog words; a
 *   refused opening fails the brief, since it never existed.
 * - A transient failure (Ledger unreachable, a 5xx, a timeout) retries with the
 *   same tool-call id, which Ledger replays rather than repeats — for at most
 *   30 minutes from when the action was accepted (amendments N5, the job's
 *   `acceptedAt`), then the action ends as `unavailable`.
 * - Every call is cost-free control-plane work; the planner's paid turn runs in
 *   Water under Ledger job compute (contract §8).
 */

const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000

const retryDelayMs = (attempt: number): number =>
  Math.min(RETRY_BASE_MS * 2 ** Math.max(attempt - 1, 0), RETRY_MAX_MS)

const log = (run: DeepWaterBriefRun, payload: DeepWaterBriefActionJobPayload, what: string): void => {
  console.info(`[deep-water] brief action ${payload.action.kind} ${payload.actionId} on run ${run.id}: ${what}`)
}

/** The Ledger tool and arguments one action stands for; null when the run cannot take it. */
const ledgerCall = (
  run: DeepWaterBriefRun,
  action: DeepWaterBriefActionJobPayload['action'],
): { toolName: string; args: Record<string, unknown> } | null => {
  if (action.kind === 'scope_start') {
    // The one builder of an opening call, so a retry with the same tool-call id
    // always matches the fingerprint Ledger keyed the brief to.
    return run.input ? { toolName: 'research_scope_start', args: deepWaterScopeStartLedgerArgs(run.input) } : null
  }
  const id = run.externalRunId
  if (!id) return null
  if (action.kind === 'reply') {
    return {
      toolName: 'research_scope_reply',
      args: {
        id,
        message: action.message,
        ...(action.baseRevision !== undefined ? { base_revision: action.baseRevision } : {}),
        ...(action.pillars !== undefined ? { pillars: action.pillars } : {}),
        ...(action.settings !== undefined ? { settings: toLedgerBriefSettings(action.settings) } : {}),
      },
    }
  }
  if (action.kind === 'launch') {
    return {
      toolName: 'research_scope_launch',
      args: {
        id,
        revision: action.revision,
        ...(action.pillars !== undefined ? { pillars: action.pillars } : {}),
        ...(action.settings !== undefined ? { settings: toLedgerBriefSettings(action.settings) } : {}),
        // Only a person publishes, and only when they chose to (overview §8).
        ...(action.public ? { public: true } : {}),
      },
    }
  }
  return { toolName: 'research_cancel', args: { id } }
}

type Target = { organizationId: string; runId: string; actionId: string }

/** End the action with a code (or clear it with null), announcing the run. */
const settle = async (
  deps: DeepWaterWatchDeps,
  run: DeepWaterBriefRun,
  target: Target,
  errorCode: DeepWaterPendingActionErrorCode | null,
): Promise<void> => {
  await runDeepWaterTransaction(deps, async (tx, announce) => {
    if (await settleDeepWaterPersonAction(tx, { ...target, errorCode })) announce.run(run)
  })
}

/**
 * Apply a successful answer, renewing the requester's captured identity from
 * the live one this action carried (amendments-fable F4) in the same
 * transaction — the person acting again is the remedy a changed-sign-in block
 * names, so the watch resumes.
 */
const applyAnswer = async (
  deps: DeepWaterWatchDeps,
  payload: DeepWaterBriefActionJobPayload,
  apply: (tx: Prisma.TransactionClient, announce: DeepWaterAnnouncements) => Promise<DeepWaterProjectionOutcome>,
): Promise<DeepWaterProjectionOutcome> =>
  runDeepWaterTransaction(deps, async (tx, announce) => {
    const outcome = await apply(tx, announce)
    if (payload.actor.role === 'requester') {
      const renewed = await refreshDeepWaterRunIdentity(tx, {
        organizationId: payload.organizationId,
        runId: payload.runId,
        identity: payload.actor.identity,
      })
      if (renewed.unblocked && outcome.applied) announce.run(outcome.run)
    }
    if (outcome.applied && outcome.changed) announce.run(outcome.run)
    return outcome
  })

const applySuccess = async (
  deps: DeepWaterWatchDeps,
  run: DeepWaterBriefRun,
  payload: DeepWaterBriefActionJobPayload,
  structured: Record<string, unknown>,
): Promise<void> => {
  const target = { organizationId: run.organizationId, runId: run.id }
  const action = payload.action
  if (action.kind === 'scope_start' || action.kind === 'reply') {
    const parsed = LedgerScopeResultSchema.safeParse(structured)
    if (!parsed.success) return malformed(deps, run, payload, 'the scope result is outside the contract')
    const outcome = await applyAnswer(deps, payload, (tx) => applyDeepWaterScopeResult(tx, {
      ...target,
      result: parsed.data,
      ackActionId: payload.actionId,
      turnAuthor: { kind: 'person', userId: payload.actor.userId },
    }))
    if (!outcome.applied && outcome.reason === 'not_attachable') {
      // The brief ended here before DeepWater named it, so nothing points at
      // the research this answer names; it stays idle there until it expires.
      console.error(`[deep-water] brief ${run.id} ended before DeepWater named it; research ${parsed.data.id} is not attached`)
    }
    return log(run, payload, outcome.applied ? `applied (${parsed.data.status})` : `not applied (${outcome.reason})`)
  }
  if (action.kind === 'launch') {
    const parsed = LedgerResearchTicketSchema.safeParse(structured)
    if (!parsed.success) return malformed(deps, run, payload, 'the launch ticket is outside the contract')
    const outcome = await applyAnswer(deps, payload, async (tx, announce) => {
      const applied = await applyDeepWaterLaunchTicket(tx, {
        ...target,
        ticket: parsed.data,
        ackActionId: payload.actionId,
      })
      // A person's research card is posted when the research starts (§7.7).
      if (applied.applied && applied.run.status === 'running') {
        await ensureDeepWaterResearchCard(tx, announce, target)
      }
      return applied
    })
    return log(run, payload, outcome.applied ? `launched (${parsed.data.status})` : `not applied (${outcome.reason})`)
  }
  const parsed = LedgerResearchStatusDtoSchema.safeParse(structured)
  if (!parsed.success) return malformed(deps, run, payload, 'the cancel answer is outside the contract')
  const outcome = await applyAnswer(deps, payload, (tx) =>
    applyDeepWaterStatusRead(tx, { ...target, status: parsed.data }))
  // A research that finished before the cancel reached it is delivered by the
  // watch, which the read rescheduled; nothing here posts its result.
  log(run, payload, outcome.applied ? `cancel answered ${parsed.data.status}` : `not applied (${outcome.reason})`)
}

/**
 * Ledger answered outside its contract. That is deterministic — the same call
 * replays the same stored answer — so it is never retried: the action ends as
 * rejected and the error is logged for the contract drift it is.
 */
const malformed = async (
  deps: DeepWaterWatchDeps,
  run: DeepWaterBriefRun,
  payload: DeepWaterBriefActionJobPayload,
  reason: string,
): Promise<void> => {
  console.error(`[deep-water] brief action ${payload.actionId} on run ${run.id}: ${reason}`)
  await settle(deps, run, { ...payload, runId: run.id }, 'rejected')
}

/** A definitive refusal from Ledger (or from Nessie before the call left). */
const refuse = async (
  deps: DeepWaterWatchDeps,
  run: DeepWaterBriefRun,
  payload: DeepWaterBriefActionJobPayload,
  errorCode: DeepWaterPendingActionErrorCode,
  ledgerCode: string | null,
): Promise<void> => {
  const target = { organizationId: run.organizationId, runId: run.id, actionId: payload.actionId }
  if (payload.action.kind === 'scope_start') {
    // The brief never opened, so there is nothing to read or deliver.
    const failureCode = errorCode === 'identity_required'
      ? 'identity_unavailable'
      : ledgerCode?.replace(/[^a-z_]/g, '_').slice(0, 64) || 'start_rejected'
    await runDeepWaterTransaction(deps, async (tx, announce) => {
      const failed = await failUnstartedDeepWaterBrief(tx, { ...target, failureCode, actionErrorCode: errorCode })
      if (failed) announce.run(run)
    })
    return log(run, payload, `opening refused (${ledgerCode ?? errorCode})`)
  }
  if (payload.action.kind === 'launch' && ledgerCode !== null && revertsLaunch(ledgerCode)) {
    // Ledger put the brief back to drafting; only this job knows (L3).
    await runDeepWaterTransaction(deps, async (tx, announce) => {
      if (await revertDeepWaterLaunch(tx, { ...target, errorCode })) announce.run(run)
    })
    return log(run, payload, `launch refused and reverted (${ledgerCode})`)
  }
  await settle(deps, run, target, errorCode)
  log(run, payload, `refused (${ledgerCode ?? errorCode})`)
}

/** Carry out Ledger's final answer to a brief's action. */
const applyAnswerOf = async (
  deps: DeepWaterWatchDeps,
  run: DeepWaterBriefRun,
  payload: DeepWaterBriefActionJobPayload,
  answer: DeepWaterLedgerOutcome,
): Promise<void> => {
  switch (answer.outcome) {
    case 'ok':
      return applySuccess(deps, run, payload, answer.structured)
    case 'refused':
      return refuse(deps, run, payload, pendingActionErrorForLedger(answer.error), answer.error.code)
    case 'identity':
      // Nessie could not sign as this person, so nothing reached Ledger.
      return refuse(deps, run, payload, 'identity_required', null)
    case 'connector_missing':
      return refuse(deps, run, payload, 'not_ready', null)
    case 'malformed':
      return malformed(deps, run, payload, answer.reason)
    case 'unavailable':
      // Transient answers are retried before this is reached.
      throw new Error(`DeepWater brief action ${payload.actionId}: an unavailable answer reached the final step`)
  }
}

export const runDeepWaterBriefAction = async (
  deps: DeepWaterWatchDeps,
  payload: DeepWaterBriefActionJobPayload,
  job: { attempt: number },
): Promise<void> => {
  const run = await readDeepWaterBriefRun(deps.prisma, payload)
  if (!run) return
  const legacy = run.scopeState === null
  const pending = run.scopeState?.pendingAction ?? null
  if (!legacy && (!isPendingActionInFlight(pending) || pending.actionId !== payload.actionId)) {
    // A read, a newer cancel or the stale-action settle already ended it.
    return log(run, payload, 'no longer the action in flight')
  }
  if (legacy && payload.action.kind !== 'cancel') {
    throw new Error(`DeepWater launcher run ${run.id} cannot take a ${payload.action.kind} brief action`)
  }
  if (legacy && !isLauncherCancelInFlight(run, payload.actionId)) {
    // It ended, already has its answer, or a newer cancel speaks for it now.
    return log(run, payload, 'no longer the launcher cancel in flight')
  }
  const target = { organizationId: run.organizationId, runId: run.id, actionId: payload.actionId }
  const audited = isAuditedDeepWaterCancel(run, payload)
  /** End an action Ledger never answered, with what the run and the audit say. */
  const endUnanswered = async (errorCode: 'unavailable' | 'rejected', outcome: DeepWaterCancelOutcome) => {
    if (legacy) return finishLauncherCancel(deps, run, payload, outcome)
    await settle(deps, run, target, errorCode)
    if (audited) await auditDeepWaterCancelOutcome(deps, run, payload, outcome)
  }
  // The window runs from when the action was accepted — never from the queue
  // row's `enqueued_at`, which every retry moves forward.
  if (Date.now() - Date.parse(payload.acceptedAt) >= DEEP_WATER_ACTION_RETRY_WINDOW_MS) {
    console.warn(`[deep-water] brief action ${payload.actionId} on run ${run.id} gave up: Ledger stayed unreachable`)
    return endUnanswered('unavailable', DEEP_WATER_CANCEL_GAVE_UP)
  }

  const call = ledgerCall(run, payload.action)
  if (!call || !run.connectorId) {
    // The API accepts an action only on a run that can take it.
    console.error(`[deep-water] brief action ${payload.actionId}: run ${run.id} cannot take ${payload.action.kind}`)
    return endUnanswered('rejected', DEEP_WATER_CANCEL_NOT_SENDABLE)
  }
  const owner = payload.actor.role === 'owner'
  const answer = await callDeepWaterLedgerTool(deps, {
    organizationId: run.organizationId,
    connectorId: run.connectorId,
    attribution: deepWaterSystemAttribution(run, {
      // An owner cancels as themselves, never as the requester (F3).
      systemComponent: owner ? 'deep-water.owner-cancel' : 'deep-water.brief',
      identity: payload.actor.identity,
      userId: payload.actor.userId,
    }),
    toolCallId: `brief:${run.id}:${payload.actionId}`,
    toolName: call.toolName,
    args: call.args,
  })

  const transient = answer.outcome === 'unavailable'
    || (answer.outcome === 'refused' && isTransientLedgerRefusal(answer.error))
  if (transient) {
    const reason = answer.outcome === 'refused' ? answer.error.code : answer.reason
    log(run, payload, `Ledger unavailable (${reason}); retrying with the same call`)
    throw new QueueRetryAfterError(`DeepWater brief action ${payload.actionId} will retry`, retryDelayMs(job.attempt))
  }
  if (legacy) return finishLauncherCancel(deps, run, payload, deepWaterCancelOutcome(answer))
  await applyAnswerOf(deps, run, payload, answer)
  // An owner's cancel is audited with Ledger's answer, once the run holds it.
  if (audited) await auditDeepWaterCancelOutcome(deps, run, payload, deepWaterCancelOutcome(answer))
}
