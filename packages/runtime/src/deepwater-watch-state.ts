import { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  DEEP_WATER_RUN_WATCH_TOPIC,
  DEEP_WATER_START_IDENTITY_CHANGED,
  DEEP_WATER_START_UNCONFIRMED,
  DeepWaterRunWatchJobPayloadSchema,
  DeepWaterScopeStateSchema,
  deepWaterRunWatchJobKey,
  type DeepWaterTurnRegister,
} from '@nessie/schemas'

import {
  deepWaterWatchDelayMs,
  isPendingActionInFlight,
  isSettledTurnStatus,
} from './deepwater-brief-registers.js'
import {
  deepWaterBriefJson,
  lockDeepWaterBriefRun,
  type DeepWaterBriefDb,
  type DeepWaterBriefRun,
} from './deepwater-brief-run-record.js'
import { DEEP_WATER_PRODUCT_SLUG } from './integration-runs-mapping.js'

/**
 * The state behind Nessie's watch of open DeepWater runs through Ledger (Water
 * plan amendments-fable F1, amendments N4, N5): which runs are due a read, the
 * one-time reap of a brief Ledger never confirmed, the rule for an action
 * whose job is gone, and the per-turn claim that decides whether an agent is
 * woken. Each is one conditional statement or runs under the product run's row
 * lock, so two workers, a replayed job or a late read can never do it twice.
 */

/** A brief Ledger never confirmed is given up after a day (N5a). */
export const DEEP_WATER_START_CONFIRM_WINDOW_HOURS = 24

/** At most eight agent wakes per brief (operator decision 7). */
export const DEEP_WATER_AGENT_WAKE_CAP = 8

const CONFIRM_WINDOW = Prisma.sql`(CAST(${DEEP_WATER_START_CONFIRM_WINDOW_HOURS} AS integer) * interval '1 hour')`

/** The claim sets the backoff; a completed read then sets its own cadence (F1). */
const BACKOFF = Prisma.sql`least(greatest((now() - r."ledger_observed_at") / 2, interval '10 minutes'), interval '6 hours')`

export type DeepWaterWatchClaim = { runId: string; organizationId: string; reconcileSeq: number }

/**
 * Claim the runs due a read and enqueue one watch job for each, in one
 * transaction: attached briefs and researches still open, and agent-origin
 * briefs whose `research_scope_start` result was lost (no research id yet),
 * which the watch replays with the agent's own stable tool-call id until the
 * reap gives them up. A blocked run waits for its requester's Retry — an
 * unattached one only until the reap ends it. Each job is keyed by the claim's
 * sequence and runs once; the next claim is the retry.
 */
export const claimDueDeepWaterWatchRuns = async (
  tx: DeepWaterBriefDb,
  input: { limit: number },
): Promise<DeepWaterWatchClaim[]> => {
  const claim = (due: Prisma.Sql) => tx.$queryRaw<Array<{ id: string; organization_id: string; reconcile_seq: number }>>(Prisma.sql`
    WITH due AS (${due})
    UPDATE "product_integration_runs" r
    SET "reconcile_seq" = r."reconcile_seq" + 1,
        "reconcile_after" = now() + ${BACKOFF}
    FROM due
    WHERE r."id" = due."id"
    RETURNING r."id"::text AS "id", r."organization_id"::text AS "organization_id", r."reconcile_seq"
  `)
  const attached = await claim(Prisma.sql`
    SELECT "id" FROM "product_integration_runs"
    WHERE "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND "uoa_identity" IS NOT NULL
      AND "external_run_id" IS NOT NULL
      AND "status" IN ('drafting', 'running', 'needs_setup')
      AND "delivery_blocked_reason" IS NULL
      AND "reconcile_after" <= now()
    ORDER BY "reconcile_after"
    FOR UPDATE SKIP LOCKED
    LIMIT ${input.limit}
  `)
  const unattached = await claim(Prisma.sql`
    SELECT "id" FROM "product_integration_runs"
    WHERE "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND "uoa_identity" IS NOT NULL
      AND "external_run_id" IS NULL
      AND "status" = 'queued'
      AND "origin_kind" = 'agent'
      AND "origin_run_id" IS NOT NULL
      AND "delivery_blocked_reason" IS NULL
      AND "created_at" > now() - ${CONFIRM_WINDOW}
      AND "reconcile_after" <= now()
    ORDER BY "reconcile_after"
    FOR UPDATE SKIP LOCKED
    LIMIT ${input.limit}
  `)
  const claims = [...attached, ...unattached].map((row) => ({
    runId: row.id,
    organizationId: row.organization_id,
    reconcileSeq: row.reconcile_seq,
  }))
  for (const claimed of claims) {
    await enqueueQueueJob(tx, {
      idempotencyKey: deepWaterRunWatchJobKey(claimed.runId, claimed.reconcileSeq),
      maxAttempts: 1,
      payload: DeepWaterRunWatchJobPayloadSchema.parse(claimed),
      topic: DEEP_WATER_RUN_WATCH_TOPIC,
    })
  }
  return claims
}

/** How soon a read that failed for a passing reason is tried again while the run moves fast. */
export const DEEP_WATER_TRANSIENT_RETRY_MS = 30_000

/**
 * A watch read failed for a reason that passes — Ledger restarting, a timeout,
 * a transient refusal. The claim already backed the run off by at least ten
 * minutes, which is right for a quiet brief but would leave a person watching
 * a planner turn, or a research that just finished, waiting that long for a
 * blip. So a run whose own cadence is fast (a turn or action in flight, a
 * research running) is read again within 30 s; a quiet one keeps the backoff.
 * Only the claim that issued the read may do this, and it only ever brings the
 * next read earlier. True when it rescheduled.
 */
export const retryDeepWaterWatchSoon = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; reconcileSeq: number },
): Promise<boolean> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  if (!locked || locked.run.reconcileSeq !== input.reconcileSeq) return false
  const { run, now } = locked
  const cadence = deepWaterWatchDelayMs({
    status: run.status,
    state: run.scopeState,
    msSinceLastChange: now.getTime() - run.ledgerObservedAt.getTime(),
  })
  if (cadence > DEEP_WATER_TRANSIENT_RETRY_MS) return false
  const retryAt = new Date(now.getTime() + DEEP_WATER_TRANSIENT_RETRY_MS)
  if (run.reconcileAfter.getTime() <= retryAt.getTime()) return false
  await tx.productIntegrationRun.update({ where: { id: run.id }, data: { reconcileAfter: retryAt } })
  return true
}

/**
 * Stop replaying an agent's lost scope start that Ledger answered with
 * `conflict` (it holds a brief for that call under other arguments): the same
 * call can only get the same answer, so the run waits for the reap instead of
 * repeating it. Only the claim that issued the read may do this, and only
 * while the run is still unattached. True when it held the run.
 */
export const holdDeepWaterScopeStartReplay = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; reconcileSeq: number },
): Promise<boolean> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  if (!locked || locked.run.reconcileSeq !== input.reconcileSeq || locked.run.externalRunId !== null) return false
  // The unattached claim admits a row only inside its confirm window, so a
  // next read due when the window closes is never claimed: the reap ends it.
  const windowCloses = new Date(locked.run.createdAt.getTime() + DEEP_WATER_START_CONFIRM_WINDOW_HOURS * 3_600_000)
  await tx.productIntegrationRun.update({ where: { id: locked.run.id }, data: { reconcileAfter: windowCloses } })
  return true
}

/**
 * Briefs Ledger never confirmed within the window, oldest first (N5a) — blocked
 * ones included. A brief blocked because its requester's sign-in changed waits
 * for their Retry only while the window is open: the reap is what ends every
 * unlaunched brief, and an open one holds the team's DeepWater connector and
 * its agent's DeepWater tools (N8.3, N8.4) for as long as it stays `queued`.
 */
export const findUnconfirmedDeepWaterBriefs = async (
  db: DeepWaterBriefDb,
  input: { limit: number },
): Promise<Array<{ runId: string; organizationId: string }>> => {
  const rows = await db.$queryRaw<Array<{ id: string; organization_id: string }>>(Prisma.sql`
    SELECT "id"::text AS "id", "organization_id"::text AS "organization_id"
    FROM "product_integration_runs"
    WHERE "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND "uoa_identity" IS NOT NULL
      AND "external_run_id" IS NULL
      AND "status" = 'queued'
      AND "created_at" < now() - ${CONFIRM_WINDOW}
    ORDER BY "created_at"
    LIMIT ${input.limit}
  `)
  return rows.map((row) => ({ runId: row.id, organizationId: row.organization_id }))
}

/**
 * Give up a brief Ledger never confirmed, with a person's opening action ended
 * as unavailable: `failed/start_unconfirmed`, or `failed/start_identity_changed`
 * when its requester's changed sign-in stopped it and they did not renew it in
 * time — then what stopped it was their sign-in, not DeepWater, and the caller
 * says so. The block goes with it: an ended brief has nothing left to retry. Null
 * unless this call reaped it — the caller then posts the one notice or wake in
 * this transaction. `delivered_at` stays unset and the attach rule still
 * admits the row (N1), so an acknowledgement that does arrive later attaches
 * and delivers it; the watch itself no longer replays it.
 */
export const reapUnconfirmedDeepWaterBrief = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string },
): Promise<DeepWaterBriefRun | null> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  const state = locked?.run.scopeState
  if (!locked || !state) return null
  const { run, now } = locked
  const cutoff = now.getTime() - DEEP_WATER_START_CONFIRM_WINDOW_HOURS * 3_600_000
  if (run.status !== 'queued' || run.externalRunId !== null || run.createdAt.getTime() >= cutoff) {
    return null
  }
  const failureCode = run.deliveryBlockedReason === 'requester_identity_changed'
    ? DEEP_WATER_START_IDENTITY_CHANGED
    : DEEP_WATER_START_UNCONFIRMED
  const action = state.pendingAction
  const scopeState = DeepWaterScopeStateSchema.parse({
    ...state,
    pendingAction: isPendingActionInFlight(action)
      ? { ...action, error: { code: 'unavailable', at: now.toISOString() } }
      : action,
  })
  await tx.productIntegrationRun.update({
    where: { id: run.id },
    data: {
      status: 'failed',
      failureCode,
      completedAt: now,
      deliveryBlockedReason: null,
      scopeJson: deepWaterBriefJson(scopeState),
    },
  })
  return { ...run, status: 'failed', failureCode, completedAt: now, deliveryBlockedReason: null, scopeState }
}

export type DeepWaterStaleActionOutcome =
  /** The action did what it was for (a launch the run shows as launched): cleared. */
  | 'finished'
  /** Ledger shows nothing left of it: ended as unavailable, so the person can act again. */
  | 'unavailable'
  /** Ledger still has the planner turn it opened: left for that turn to settle. */
  | 'kept'
  /** It is no longer the action in flight. */
  | 'none'

/**
 * An in-flight action whose job is no longer live (N5 "stale pendingAction"):
 * the caller has checked the job; this decides from the row, under its lock.
 */
export const settleStaleDeepWaterAction = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; actionId: string },
): Promise<DeepWaterStaleActionOutcome> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  const state = locked?.run.scopeState
  if (!locked || !state) return 'none'
  const action = state.pendingAction
  if (!isPendingActionInFlight(action) || action.actionId !== input.actionId) return 'none'
  const { run, now } = locked
  // The run reaches `running` or `needs_setup` only on proof of launch.
  if (action.kind === 'launch' && (run.status === 'running' || run.status === 'needs_setup')) {
    await tx.productIntegrationRun.update({
      where: { id: run.id },
      data: { scopeJson: deepWaterBriefJson(DeepWaterScopeStateSchema.parse({ ...state, pendingAction: null })) },
    })
    return 'finished'
  }
  const turn = state.turn
  if (turn && !isSettledTurnStatus(turn.status) && action.turnId === turn.id) return 'kept'
  await tx.productIntegrationRun.update({
    where: { id: run.id },
    data: {
      scopeJson: deepWaterBriefJson(DeepWaterScopeStateSchema.parse({
        ...state,
        pendingAction: { ...action, error: { code: 'unavailable', at: now.toISOString() } },
      })),
    },
  })
  return 'unavailable'
}

export type DeepWaterTurnWakeDecision =
  | { kind: 'none' }
  /** Wake this agent for the settled turn; count it with `recordDeepWaterAgentWake`. */
  | { kind: 'wake'; turn: DeepWaterTurnRegister; agentId: string }
  /** The cap is reached: post the one notice that says so. */
  | { kind: 'cap_notice'; turn: DeepWaterTurnRegister }

/**
 * The per-turn wake claim (N4, C1): a planner turn wakes its agent author at
 * most once, in turn order, whatever order reads, acks and replays arrive in.
 * Claimed under the row lock by advancing `last_handled_turn_seq`, so a late
 * read of an older turn finds nothing to do. A person's turn only advances it.
 */
export const claimDeepWaterTurnWake = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string },
): Promise<{ run: DeepWaterBriefRun; decision: DeepWaterTurnWakeDecision } | null> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  const state = locked?.run.scopeState
  if (!locked || !state) return null
  const { run, now } = locked
  const turn = state.turn
  const none = { run, decision: { kind: 'none' as const } }
  if (run.status !== 'drafting' || !turn || !isSettledTurnStatus(turn.status)) return none
  if (turn.seq <= (run.lastHandledTurnSeq ?? 0)) return none

  const author = state.turnAuthors[turn.id]
    ?? (turn.authorKind === 'agent' && run.originAgentId ? { kind: 'agent' as const, agentId: run.originAgentId } : null)
  const capReached = author?.kind === 'agent' && run.agentWakeCount >= DEEP_WATER_AGENT_WAKE_CAP
  const capNotice = capReached && run.wakeCapNoticeAt === null
  await tx.productIntegrationRun.update({
    where: { id: run.id },
    data: {
      lastHandledTurnSeq: turn.seq,
      ...(capNotice ? { wakeCapNoticeAt: now } : {}),
    },
  })
  const claimed = { ...run, lastHandledTurnSeq: turn.seq, wakeCapNoticeAt: capNotice ? now : run.wakeCapNoticeAt }
  if (author?.kind !== 'agent') return { run: claimed, decision: { kind: 'none' } }
  if (!capReached) return { run: claimed, decision: { kind: 'wake', turn, agentId: author.agentId } }
  return { run: claimed, decision: capNotice ? { kind: 'cap_notice', turn } : { kind: 'none' } }
}

/** Count a turn wake that was claimed or pended (a duplicate is not counted). */
export const recordDeepWaterAgentWake = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string },
): Promise<void> => {
  await tx.productIntegrationRun.updateMany({
    where: { id: input.runId, organizationId: input.organizationId, productSlug: DEEP_WATER_PRODUCT_SLUG },
    data: { agentWakeCount: { increment: 1 } },
  })
}
