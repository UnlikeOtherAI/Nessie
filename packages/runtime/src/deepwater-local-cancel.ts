import { Prisma } from '@prisma/client'
import {
  DEEP_WATER_RESEARCH_EVENT_TOPIC,
  DEEP_WATER_RUN_WATCH_TOPIC,
  DeepWaterScopeStateSchema,
} from '@nessie/schemas'

import {
  DEEP_WATER_ACTION_RETRY_WINDOW_MS,
  isDeepWaterActionJobLive,
  wasDeepWaterActionAccepted,
} from './deepwater-brief-actions.js'
import { isPendingActionInFlight } from './deepwater-brief-registers.js'
import {
  deepWaterBriefJson,
  lockDeepWaterBriefRun,
  type DeepWaterBriefDb,
  type DeepWaterBriefRun,
} from './deepwater-brief-run-record.js'

/**
 * Cancelling a DeepWater run here, in Nessie, when DeepWater holds nothing to
 * cancel (Water plan amendments N8.5, N9.6): a launcher run it never received
 * (`deepwater-legacy-cancel.ts`), or a research brief it has not named yet —
 * one whose opening failed or was lost. Such a brief still holds its team's
 * connector, and so blocks a disable or a grant revocation, until the reap
 * gives it up a day later; its requester and the team's owners and admins
 * must be able to clear it sooner.
 *
 * A brief is cancelled here only once nothing can still open it in DeepWater:
 * a person's opening action whose job may yet call Ledger, an agent's run
 * that may be sending its `research_scope_start`, or a watch replaying that
 * call would otherwise open a paid brief no row points at. While one may,
 * the cancel is refused as `opening`.
 *
 * A cancel made here records its actionId on the run, so a retried request
 * whose first answer was lost is a replay, as it is for an action the worker
 * carries out (whose queue job key is the record).
 */

/**
 * Was this cancel accepted before: enqueued for the worker (its queue job
 * key), or carried out here (the actionId recorded on the run)?
 */
export const wasDeepWaterCancelAccepted = async (
  db: DeepWaterBriefDb,
  runId: string,
  actionId: string,
): Promise<boolean> => {
  if (await wasDeepWaterActionAccepted(db, runId, actionId)) return true
  const rows = await db.$queryRaw<Array<{ accepted: boolean }>>(Prisma.sql`
    SELECT true AS "accepted" FROM "product_integration_runs"
    WHERE "id" = CAST(${runId} AS uuid) AND "result_json" ->> 'cancelActionId' = ${actionId}
  `)
  return rows.length > 0
}

/** Cancel a run here, recording the actionId that did it. The caller holds the run's row lock. */
export const recordDeepWaterLocalCancel = async (
  db: DeepWaterBriefDb,
  input: { runId: string; actionId: string },
): Promise<void> => {
  await db.$executeRaw(Prisma.sql`
    UPDATE "product_integration_runs"
    SET "status" = 'cancelled',
        "completed_at" = now(),
        "updated_at" = CURRENT_TIMESTAMP,
        "result_json" = COALESCE("result_json", '{}'::jsonb)
          || jsonb_build_object('cancelActionId', CAST(${input.actionId} AS text))
    WHERE "id" = CAST(${input.runId} AS uuid)
  `)
}

type OpeningView = Pick<DeepWaterBriefRun, 'externalRunId' | 'originKind' | 'scopeState'>

/** A person's opening action still in flight on a brief DeepWater has not named. */
const openingAction = (run: OpeningView) => {
  const action = run.scopeState?.pendingAction ?? null
  return run.externalRunId === null
    && run.originKind === 'person'
    && isPendingActionInFlight(action)
    && action.kind === 'scope_start'
    ? action
    : null
}

/**
 * Does a person's brief offer no Cancel yet? While its opening action is in
 * flight DeepWater may be opening it right now — but only inside the window
 * that action's job retries in: past it the job has given up (and ended the
 * action) or died, so the brief offers Cancel and the cancel route, which
 * reads the job itself, decides.
 */
export const isDeepWaterBriefOpening = (run: OpeningView, now: Date): boolean => {
  const action = openingAction(run)
  return action !== null && now.getTime() - Date.parse(action.since) < DEEP_WATER_ACTION_RETRY_WINDOW_MS
}

/** Could something still send this unnamed brief's opening to Ledger? Read under its row lock. */
const mayStillOpen = async (tx: DeepWaterBriefDb, run: DeepWaterBriefRun): Promise<boolean> => {
  if (run.originKind === 'person') {
    const action = openingAction(run)
    return action !== null && await isDeepWaterActionJobLive(tx, run.id, action.actionId)
  }
  // An agent's brief opens from the agent's own run, and after that only from
  // a watch replay of the same call — made by a watch job, or by a DeepWater
  // event's job, which makes the watch's own read; each re-reads the run
  // before it replays, so one enqueued or running now is the only replay left
  // to fear.
  const rows = await tx.$queryRaw<Array<{ dispatching: boolean; replaying: boolean }>>(Prisma.sql`
    SELECT
      EXISTS (
        SELECT 1 FROM "runs"
        WHERE "id" = CAST(${run.originRunId} AS uuid) AND "status" IN ('pending', 'running')
      ) AS "dispatching",
      EXISTS (
        SELECT 1 FROM "queue_jobs"
        WHERE "topic" IN (${DEEP_WATER_RUN_WATCH_TOPIC}, ${DEEP_WATER_RESEARCH_EVENT_TOPIC})
          AND "status" IN ('pending', 'processing')
          AND "payload" ->> 'runId' = ${run.id}
      ) AS "replaying"
  `)
  return rows.some((row) => row.dispatching || row.replaying)
}

export type UnopenedDeepWaterCancel =
  /** Cancelled here. */
  | 'cancelled'
  /** This actionId already cancelled it. */
  | 'replay'
  /** DeepWater named it: cancel it through DeepWater. */
  | 'opened'
  /** DeepWater may be opening it right now; nothing is changed. */
  | 'opening'
  /** It ended before it opened (refused, or given up by the reap). */
  | 'not_cancellable'

/**
 * Cancel a research brief DeepWater has not named yet, under its row lock.
 * Null when it is not a brief of this organisation.
 */
export const cancelUnopenedDeepWaterBrief = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; actionId: string },
): Promise<UnopenedDeepWaterCancel | null> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  const state = locked?.run.scopeState
  if (!locked || !state) return null
  const { run } = locked
  if (await wasDeepWaterCancelAccepted(tx, run.id, input.actionId)) return 'replay'
  if (run.externalRunId !== null) return 'opened'
  if (run.status !== 'queued') return 'not_cancellable'
  if (await mayStillOpen(tx, run)) return 'opening'

  // A settled opening action (it failed, or Ledger stayed unreachable) has
  // nothing left to say on a cancelled brief.
  await tx.productIntegrationRun.update({
    where: { id: run.id },
    data: { scopeJson: deepWaterBriefJson(DeepWaterScopeStateSchema.parse({ ...state, pendingAction: null })) },
  })
  await recordDeepWaterLocalCancel(tx, { runId: run.id, actionId: input.actionId })
  return 'cancelled'
}
