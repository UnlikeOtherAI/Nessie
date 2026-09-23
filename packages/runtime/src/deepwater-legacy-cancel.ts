import { Prisma } from '@prisma/client'

import type { DeepWaterBriefDb, DeepWaterBriefRun } from './deepwater-brief-run-record.js'
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
 *   worker records it with `recordLegacyDeepWaterCancel` once Ledger agrees.
 * - A `running` run with no research id may have a start in flight to Ledger
 *   at this moment, so nothing can safely cancel it: the handoff's own retry
 *   resolves it first.
 *
 * A request is judged a replay before the run's state: a retry whose first
 * answer was lost finds the run already cancelled by its own action.
 */

export type LegacyDeepWaterCancelRoute = 'local' | 'ledger' | 'not_cancellable' | 'replay'

const OPEN_STATUSES = ['queued', 'running', 'needs_setup'] as const

type LegacyRow = { status: string; externalRunId: string | null; startRecorded: boolean }

const readLegacyRow = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string },
): Promise<LegacyRow | null> => {
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

const routeFor = (row: LegacyRow): LegacyDeepWaterCancelRoute => {
  if (!(OPEN_STATUSES as readonly string[]).includes(row.status)) return 'not_cancellable'
  if (row.externalRunId !== null) return 'ledger'
  if (row.status === 'needs_setup') return 'local'
  if (row.status === 'queued' && !row.startRecorded) return 'local'
  return 'not_cancellable'
}

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
  const row = await readLegacyRow(tx, input)
  if (!row) return null
  if (await wasDeepWaterCancelAccepted(tx, input.runId, input.actionId)) return 'replay'
  const route = routeFor(row)
  if (route !== 'local') return route
  await recordDeepWaterLocalCancel(tx, { runId: input.runId, actionId: input.actionId })
  return 'local'
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

/** Is this a launcher run a person could still ask to cancel, as far as the row alone shows? */
export const isOpenLegacyDeepWaterRun = (run: Pick<DeepWaterBriefRun, 'scopeState' | 'status'>): boolean =>
  run.scopeState === null && (OPEN_STATUSES as readonly string[]).includes(run.status)
