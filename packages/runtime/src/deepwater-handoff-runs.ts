import { Prisma, type PrismaClient } from '@prisma/client'
import type { ProductIntegrationRunStatus } from '@nessie/schemas'

import { DEEP_WATER_PRODUCT_SLUG, toRecord } from './integration-runs-mapping.js'

export const DEEP_WATER_START_FAILURE_DETAIL =
  'Deep Water research could not be started.'
export const DEEP_WATER_START_RECOVERY_DETAIL =
  'Deep Water research start could not be confirmed. Recovery is required.'

export type DeepWaterStartTicketStatus =
  | 'running'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'timed_out'

export type DeepWaterHandoffRun = {
  externalRunId: string | null
  failureEligible: boolean
  id: string
  startArguments: Record<string, unknown> | null
  startEligible: boolean
  startTicketStatus: DeepWaterStartTicketStatus | null
  startToolCallId: string | null
  status: ProductIntegrationRunStatus
}

export type DeepWaterHandoffLookup =
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'found'; run: DeepWaterHandoffRun }

export type DeepWaterHandoffRunLocator = {
  messageId: string
  organizationId: string
  runId: string
  teamId: string
  threadId: string
}

type DeepWaterHandoffRunRow = {
  cost_amount: Prisma.Decimal | number | string | null
  external_run_id: string | null
  id: string
  knowledge_page_id: string | null
  result_json: unknown
  source_count: number | null
  status: ProductIntegrationRunStatus
}

const isFailureEligibleHandoff = (row: DeepWaterHandoffRunRow): boolean => {
  const result = toRecord(row.result_json)
  return (row.status === 'queued' || row.status === 'running')
    && row.external_run_id === null
    && row.cost_amount === null
    && row.source_count === null
    && row.knowledge_page_id === null
    && !Object.hasOwn(result, 'reportUrl')
}

const START_TICKET_STATUSES = new Set<DeepWaterStartTicketStatus>([
  'running',
  'complete',
  'failed',
  'cancelled',
  'timed_out',
])

const startTicketStatusFromResult = (
  result: Record<string, unknown>,
): DeepWaterStartTicketStatus | null =>
  typeof result.startTicketStatus === 'string'
    && START_TICKET_STATUSES.has(result.startTicketStatus as DeepWaterStartTicketStatus)
    ? result.startTicketStatus as DeepWaterStartTicketStatus
    : null

/**
 * Resolve only an unambiguous DeepWater run attached to the current handoff
 * message and execution tenancy. Existing external/accounting/report/Knowledge
 * evidence makes a row ineligible for start-failure enforcement.
 */
export const findDeepWaterHandoffRun = async (
  prisma: PrismaClient,
  locator: DeepWaterHandoffRunLocator,
): Promise<DeepWaterHandoffLookup> => {
  const rows = await prisma.$queryRaw<DeepWaterHandoffRunRow[]>(Prisma.sql`
    SELECT
      "id",
      "status",
      "external_run_id",
      "cost_amount",
      "source_count",
      "knowledge_page_id",
      "result_json"
    FROM "product_integration_runs"
    WHERE "id" = CAST(${locator.runId} AS uuid)
      AND "message_id" = CAST(${locator.messageId} AS uuid)
      AND "organization_id" = CAST(${locator.organizationId} AS uuid)
      AND "team_id" = CAST(${locator.teamId} AS uuid)
      AND "thread_id" = CAST(${locator.threadId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
    LIMIT 2
  `)

  if (rows.length === 0) return { kind: 'none' }
  if (rows.length !== 1 || !rows[0]) return { kind: 'ambiguous' }
  const result = toRecord(rows[0].result_json)
  const startToolCallId = typeof result.startToolCallId === 'string'
    && result.startToolCallId.trim().length > 0
    ? result.startToolCallId
    : null
  const startArguments = result.startArguments
    && typeof result.startArguments === 'object'
    && !Array.isArray(result.startArguments)
    ? result.startArguments as Record<string, unknown>
    : null
  const failureEligible = isFailureEligibleHandoff(rows[0])
  return {
    kind: 'found',
    run: {
      externalRunId: rows[0].external_run_id,
      failureEligible,
      id: rows[0].id,
      startArguments,
      startEligible: rows[0].status === 'queued' && failureEligible,
      startTicketStatus: startTicketStatusFromResult(result),
      startToolCallId,
      status: rows[0].status,
    },
  }
}

/** Claim the one allowed start attempt before any Ledger dispatch occurs. */
export const claimDeepWaterHandoffStart = async (
  prisma: PrismaClient,
  locator: DeepWaterHandoffRunLocator & {
    args: Record<string, unknown>
    runId: string
    toolCallId: string
  },
): Promise<boolean> => {
  const argsJson = JSON.stringify(locator.args)
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "product_integration_runs"
    SET
      "status" = 'running'::"ProductIntegrationRunStatus",
      "result_json" = jsonb_set(
        jsonb_set(
          COALESCE("result_json", '{}'::jsonb),
          '{startToolCallId}',
          to_jsonb(${locator.toolCallId}::text),
          true
        ),
        '{startArguments}',
        CAST(${argsJson} AS jsonb),
        true
      ),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${locator.runId} AS uuid)
      AND "message_id" = CAST(${locator.messageId} AS uuid)
      AND "organization_id" = CAST(${locator.organizationId} AS uuid)
      AND "team_id" = CAST(${locator.teamId} AS uuid)
      AND "thread_id" = CAST(${locator.threadId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND "status" = 'queued'
      AND "external_run_id" IS NULL
      AND "cost_amount" IS NULL
      AND "source_count" IS NULL
      AND "knowledge_page_id" IS NULL
      AND NOT (COALESCE("result_json", '{}'::jsonb) ? 'reportUrl')
      AND NOT (COALESCE("result_json", '{}'::jsonb) ? 'startToolCallId')
      AND NOT (COALESCE("result_json", '{}'::jsonb) ? 'startArguments')
    RETURNING "id"
  `)
  return rows.length === 1
}

/**
 * Persist a validated Ledger ticket before returning it to the agent loop.
 * A final-attempt timeout may move the row to `needs_setup` while the
 * uncancelled transport promise is still settling. If that late response
 * contains a valid ticket, revive the Product run to `running` and attach the
 * ticket rather than orphaning accepted paid work. The now-stale recovery
 * detail is cleared in that same update.
 */
export const persistDeepWaterHandoffTicket = async (
  prisma: PrismaClient,
  locator: DeepWaterHandoffRunLocator & {
    externalRunId: string
    runId: string
    ticketStatus: DeepWaterStartTicketStatus
    toolCallId: string
  },
): Promise<boolean> => {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "product_integration_runs"
    SET
      "status" = 'running'::"ProductIntegrationRunStatus",
      "external_run_id" = ${locator.externalRunId},
      "result_json" = jsonb_set(
        CASE
          WHEN "status" = 'needs_setup'
            THEN COALESCE("result_json", '{}'::jsonb) - 'statusDetail'
          ELSE COALESCE("result_json", '{}'::jsonb)
        END,
        '{startTicketStatus}',
        to_jsonb(${locator.ticketStatus}::text),
        true
      ),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${locator.runId} AS uuid)
      AND "message_id" = CAST(${locator.messageId} AS uuid)
      AND "organization_id" = CAST(${locator.organizationId} AS uuid)
      AND "team_id" = CAST(${locator.teamId} AS uuid)
      AND "thread_id" = CAST(${locator.threadId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND "status" IN ('running', 'needs_setup')
      AND ("external_run_id" IS NULL OR "external_run_id" = ${locator.externalRunId})
      AND COALESCE("result_json" ->> 'startToolCallId', '') = ${locator.toolCallId}
    RETURNING "id"
  `)
  return rows.length === 1
}

/** Move one exhausted unresolved start into an explicit recovery state. */
export const markDeepWaterHandoffRecoveryNeeded = async (
  prisma: PrismaClient,
  locator: DeepWaterHandoffRunLocator & { runId: string },
): Promise<boolean> => {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "product_integration_runs"
    SET
      "status" = 'needs_setup'::"ProductIntegrationRunStatus",
      "result_json" = jsonb_set(
        COALESCE("result_json", '{}'::jsonb),
        '{statusDetail}',
        to_jsonb(${DEEP_WATER_START_RECOVERY_DETAIL}::text),
        true
      ),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${locator.runId} AS uuid)
      AND "message_id" = CAST(${locator.messageId} AS uuid)
      AND "organization_id" = CAST(${locator.organizationId} AS uuid)
      AND "team_id" = CAST(${locator.teamId} AS uuid)
      AND "thread_id" = CAST(${locator.threadId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND "status" IN ('queued', 'running')
      AND "external_run_id" IS NULL
      AND "cost_amount" IS NULL
      AND "source_count" IS NULL
      AND "knowledge_page_id" IS NULL
      AND NOT (COALESCE("result_json", '{}'::jsonb) ? 'reportUrl')
    RETURNING "id"
  `)
  return rows.length === 1
}

/**
 * Quarantine every clean candidate when an exact launch locator resolves to
 * multiple rows. No row id is trustworthy in this state, so final-attempt
 * recovery must remain scoped by the full attachment and tenancy tuple.
 */
export const markAmbiguousDeepWaterHandoffRecoveryNeeded = async (
  prisma: PrismaClient,
  locator: DeepWaterHandoffRunLocator,
): Promise<number> => {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "product_integration_runs"
    SET
      "status" = 'needs_setup'::"ProductIntegrationRunStatus",
      "result_json" = jsonb_set(
        COALESCE("result_json", '{}'::jsonb),
        '{statusDetail}',
        to_jsonb(${DEEP_WATER_START_RECOVERY_DETAIL}::text),
        true
      ),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${locator.runId} AS uuid)
      AND "message_id" = CAST(${locator.messageId} AS uuid)
      AND "organization_id" = CAST(${locator.organizationId} AS uuid)
      AND "team_id" = CAST(${locator.teamId} AS uuid)
      AND "thread_id" = CAST(${locator.threadId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND "status" IN ('queued', 'running')
      AND "external_run_id" IS NULL
      AND "cost_amount" IS NULL
      AND "source_count" IS NULL
      AND "knowledge_page_id" IS NULL
      AND NOT (COALESCE("result_json", '{}'::jsonb) ? 'reportUrl')
    RETURNING "id"
  `)
  return rows.length
}

/**
 * Atomically fail one exact handoff after a definitive no-job outcome. A
 * pre-dispatch caller may settle only an uncorrelated queued row; a delayed
 * Ledger rejection may also settle running/needs_setup with the exact saved
 * tool-call correlation. Existing external/accounting/report evidence remains
 * untouchable.
 */
export const failDeepWaterHandoffStart = async (
  prisma: PrismaClient,
  locator: DeepWaterHandoffRunLocator & {
    runId: string
    toolCallId?: string
  },
): Promise<boolean> => {
  const toolCallId = locator.toolCallId?.trim() || null
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "product_integration_runs"
    SET
      "status" = 'failed'::"ProductIntegrationRunStatus",
      "result_json" = jsonb_set(
        COALESCE("result_json", '{}'::jsonb),
        '{statusDetail}',
        to_jsonb(${DEEP_WATER_START_FAILURE_DETAIL}::text),
        true
      ),
      "completed_at" = COALESCE("completed_at", CURRENT_TIMESTAMP),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${locator.runId} AS uuid)
      AND "message_id" = CAST(${locator.messageId} AS uuid)
      AND "organization_id" = CAST(${locator.organizationId} AS uuid)
      AND "team_id" = CAST(${locator.teamId} AS uuid)
      AND "thread_id" = CAST(${locator.threadId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND (
        (
          CAST(${toolCallId} AS text) IS NULL
          AND "status" = 'queued'
          AND NOT (COALESCE("result_json", '{}'::jsonb) ? 'startToolCallId')
          AND NOT (COALESCE("result_json", '{}'::jsonb) ? 'startArguments')
        )
        OR (
          CAST(${toolCallId} AS text) IS NOT NULL
          AND "status" IN ('running', 'needs_setup')
          AND COALESCE("result_json" ->> 'startToolCallId', '')
            = CAST(${toolCallId} AS text)
        )
      )
      AND "external_run_id" IS NULL
      AND "cost_amount" IS NULL
      AND "source_count" IS NULL
      AND "knowledge_page_id" IS NULL
      AND NOT (COALESCE("result_json", '{}'::jsonb) ? 'reportUrl')
    RETURNING "id"
  `)
  return rows.length === 1
}
