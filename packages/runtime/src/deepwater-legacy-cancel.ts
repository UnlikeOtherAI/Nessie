import { Prisma } from '@prisma/client'

import type { DeepWaterPendingActionErrorCode } from '@nessie/schemas'

import {
  DeepWaterLauncherLedgerCancelSchema,
  type DeepWaterBriefDb,
  type DeepWaterBriefRun,
  type DeepWaterLauncherLedgerCancel,
} from './deepwater-brief-run-record.js'
import { recordDeepWaterLocalCancel, wasDeepWaterCancelAccepted } from './deepwater-local-cancel.js'
import { DEEP_WATER_PRODUCT_SLUG } from './integration-runs-mapping.js'

/**
 * Cancelling a launcher run — a DeepWater product run from before research
 * briefs (`uoa_identity IS NULL`) — from the brief API (Water plan amendments
 * N8.5, N9.6). Launcher runs still hold a team's connector and block its
 * contract upgrade, so an owner must be able to clear them without the
 * Personal Assistant chat they were handed to.
 *
 * - A run Ledger never received is cancelled here, locally: a `queued` run
 *   whose handoff never recorded a start call, or one parked in `needs_setup`.
 * - A run with a Ledger research id is cancelled through Ledger first; the
 *   worker records it with `recordLegacyDeepWaterCancel` once Ledger agrees,
 *   or with `recordLegacyDeepWaterCancelFailure` when Ledger refused it or
 *   could not be asked, so the run's view says why it is still open. The
 *   latest such cancel is the run's `result_json.ledgerCancel` register.
 * - A `running` run with no research id may have a start in flight to Ledger
 *   at this moment, so nothing can safely cancel it: the handoff's own retry
 *   resolves it first.
 *
 * A request is judged a replay before the run's state: a retry whose first
 * answer was lost finds the run already cancelled by its own action.
 */

export type LegacyDeepWaterCancelRoute = 'local' | 'ledger' | 'not_cancellable' | 'replay'

const OPEN_STATUSES = ['queued', 'running', 'needs_setup'] as const

/** What decides how a launcher run can be cancelled. */
export type DeepWaterLauncherCancelRow = { status: string; externalRunId: string | null; startRecorded: boolean }

const readDeepWaterLauncherCancelRow = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string },
): Promise<DeepWaterLauncherCancelRow | null> => {
  const rows = await tx.$queryRaw<Array<{ status: string; external_run_id: string | null; start_recorded: boolean }>>(
    Prisma.sql`
      SELECT "status"::text AS "status", "external_run_id",
        COALESCE("result_json" ? 'startToolCallId', false) AS "start_recorded"
      FROM "product_integration_runs"
      WHERE "id" = CAST(${input.runId} AS uuid)
        AND "organization_id" = CAST(${input.organizationId} AS uuid)
        AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
        AND "uoa_identity" IS NULL
      FOR UPDATE
    `,
  )
  const row = rows[0]
  return row ? { status: row.status, externalRunId: row.external_run_id, startRecorded: row.start_recorded } : null
}

/**
 * How a launcher run can be cancelled, from its row alone — the rule the
 * cancel route applies under the row lock, and the one the view's Cancel is
 * offered by, so a Cancel is never offered that the route must refuse.
 */
export const deepWaterLauncherCancelRoute = (
  row: DeepWaterLauncherCancelRow,
): Exclude<LegacyDeepWaterCancelRoute, 'replay'> => {
  if (!(OPEN_STATUSES as readonly string[]).includes(row.status)) return 'not_cancellable'
  if (row.externalRunId !== null) return 'ledger'
  if (row.status === 'needs_setup') return 'local'
  if (row.status === 'queued' && !row.startRecorded) return 'local'
  return 'not_cancellable'
}

/** Make this cancel the run's latest through Ledger. The caller holds the row lock. */
const writeLedgerCancel = (tx: DeepWaterBriefDb, runId: string, value: DeepWaterLauncherLedgerCancel) =>
  tx.$executeRaw(Prisma.sql`
    UPDATE "product_integration_runs"
    SET "result_json" = COALESCE("result_json", '{}'::jsonb)
          || jsonb_build_object('ledgerCancel', CAST(${JSON.stringify(DeepWaterLauncherLedgerCancelSchema.parse(value))} AS jsonb)),
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${runId} AS uuid)
  `)

/**
 * Decide how a launcher run is cancelled, under its row lock, and cancel it
 * here when Ledger never received it. `replay` when this actionId was already
 * accepted — cancelled here, or enqueued for the worker. Null when the run is
 * not a launcher run of this organisation.
 */
export const beginLegacyDeepWaterCancel = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; actionId: string },
): Promise<LegacyDeepWaterCancelRoute | null> => {
  const row = await readDeepWaterLauncherCancelRow(tx, input)
  if (!row) return null
  if (await wasDeepWaterCancelAccepted(tx, input.runId, input.actionId)) return 'replay'
  const route = deepWaterLauncherCancelRoute(row)
  if (route === 'ledger') {
    // This cancel is now the latest: an earlier one's failure no longer says
    // why the run is open while this one is on its way.
    await writeLedgerCancel(tx, input.runId, {
      actionId: input.actionId, state: 'requested', code: null, at: new Date().toISOString(),
    })
  }
  if (route !== 'local') return route
  await recordDeepWaterLocalCancel(tx, { runId: input.runId, actionId: input.actionId })
  return 'local'
}

/**
 * Is this the launcher run's cancel still waiting for Ledger's answer? Not
 * once the run has ended, the cancel has its answer, or a newer cancel was
 * accepted — a redelivered or superseded job then sends and records nothing.
 */
export const isLauncherCancelInFlight = (
  run: Pick<DeepWaterBriefRun, 'status' | 'launcher'>,
  actionId: string,
): boolean => {
  const latest = run.launcher?.ledgerCancel ?? null
  return (OPEN_STATUSES as readonly string[]).includes(run.status)
    && latest !== null
    && latest.actionId === actionId
    && latest.state === 'requested'
}

/**
 * Ledger refused a launcher run's cancel, or could not be asked: record why on
 * the run, so its view shows it, while it is still open and this cancel is
 * still its latest (a newer one speaks for itself). True when recorded.
 */
export const recordLegacyDeepWaterCancelFailure = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; actionId: string; code: DeepWaterPendingActionErrorCode },
): Promise<boolean> => {
  const value = DeepWaterLauncherLedgerCancelSchema.parse({
    actionId: input.actionId, state: 'failed', code: input.code, at: new Date().toISOString(),
  })
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE "product_integration_runs"
    SET "result_json" = "result_json" || jsonb_build_object('ledgerCancel', CAST(${JSON.stringify(value)} AS jsonb)),
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${input.runId} AS uuid)
      AND "organization_id" = CAST(${input.organizationId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND "uoa_identity" IS NULL
      AND "status"::text IN (${Prisma.join([...OPEN_STATUSES])})
      AND "result_json" -> 'ledgerCancel' ->> 'actionId' = ${input.actionId}
  `)
  return updated === 1
}

/**
 * Ledger confirmed it cancelled a launcher run's research: record it, unless
 * the run ended some other way meanwhile. Conditional on the same research id,
 * so a late job can never move another run.
 */
export const recordLegacyDeepWaterCancel = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; researchId: string },
): Promise<boolean> => {
  const updated = await tx.productIntegrationRun.updateMany({
    where: {
      id: input.runId,
      organizationId: input.organizationId,
      productSlug: DEEP_WATER_PRODUCT_SLUG,
      uoaIdentity: { equals: Prisma.DbNull },
      externalRunId: input.researchId,
      status: { in: [...OPEN_STATUSES] },
    },
    data: { status: 'cancelled', completedAt: new Date() },
  })
  return updated.count === 1
}
