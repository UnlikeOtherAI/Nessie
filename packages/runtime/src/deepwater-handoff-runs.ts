import { Prisma, type PrismaClient } from '@prisma/client'
import type { ProductIntegrationRunStatus } from '@nessie/schemas'

import {
  DEEP_WATER_PRODUCT_SLUG,
  toRecord,
  TRUSTED_DEEP_WATER_REPORT_URL_SOURCE,
  TRUSTED_DEEP_WATER_SOURCE_COUNT_SOURCE,
} from './integration-runs-mapping.js'

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
  ledgerOrigin: string | null
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
  connector_transport_config: unknown
  cost_amount: Prisma.Decimal | number | string | null
  external_run_id: string | null
  id: string
  knowledge_page_id: string | null
  result_json: unknown
  source_count: number | null
  status: ProductIntegrationRunStatus
}

const ledgerOriginFromTransport = (value: unknown): string | null => {
  const url = toRecord(value).url
  if (url === undefined) return null
  if (typeof url !== 'string') throw new Error('Deep Water connector transport URL is invalid')
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Deep Water connector transport URL must use HTTP(S)')
  }
  return parsed.origin
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
      "result_json",
      (
        SELECT "transport_config"
        FROM "mcp_server_instances"
        WHERE "mcp_server_instances"."id" = "product_integration_runs"."connector_id"
      ) AS "connector_transport_config"
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
  const ledgerOrigin = ledgerOriginFromTransport(rows[0].connector_transport_config)
  if (failureEligible && ledgerOrigin === null) {
    throw new Error('Deep Water connector transport URL is missing')
  }
  return {
    kind: 'found',
    run: {
      externalRunId: rows[0].external_run_id,
      failureEligible,
      id: rows[0].id,
      ledgerOrigin,
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
    reportUrl: string | null
    runId: string
    ticketStatus: DeepWaterStartTicketStatus
    toolCallId: string
  },
): Promise<boolean> => {
  const ticketPatch = JSON.stringify({
    ...(locator.reportUrl === null
      ? {}
      : {
          reportUrl: locator.reportUrl,
          reportUrlSource: TRUSTED_DEEP_WATER_REPORT_URL_SOURCE,
        }),
    startTicketStatus: locator.ticketStatus,
  })
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "product_integration_runs"
    SET
      "status" = 'running'::"ProductIntegrationRunStatus",
      "external_run_id" = ${locator.externalRunId},
      "result_json" = (
        CASE
          WHEN "status" = 'needs_setup'
            THEN COALESCE("result_json", '{}'::jsonb) - 'statusDetail'
          ELSE COALESCE("result_json", '{}'::jsonb)
        END
      ) || CAST(${ticketPatch} AS jsonb),
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
      AND (
        CAST(${locator.reportUrl} AS text) IS NULL
        OR COALESCE("result_json" ->> 'reportUrlSource', '')
          <> ${TRUSTED_DEEP_WATER_REPORT_URL_SOURCE}
        OR (
          "result_json" ->> 'reportUrl' = ${locator.reportUrl}
          AND "result_json" ->> 'reportUrlSource' = ${TRUSTED_DEEP_WATER_REPORT_URL_SOURCE}
        )
      )
    RETURNING "id"
  `)
  return rows.length === 1
}

/** Persist evidence count only from Ledger's authenticated report response. */
export const persistDeepWaterHandoffReportSources = async (
  prisma: PrismaClient,
  locator: DeepWaterHandoffRunLocator & {
    externalRunId: string
    runId: string
    sourceCount: number
  },
): Promise<boolean> => {
  if (!Number.isSafeInteger(locator.sourceCount) || locator.sourceCount < 0) {
    throw new Error('Deep Water report source count must be a non-negative integer')
  }
  const sourcePatch = JSON.stringify({
    sourceCountSource: TRUSTED_DEEP_WATER_SOURCE_COUNT_SOURCE,
  })
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "product_integration_runs"
      SET
        "source_count" = ${locator.sourceCount},
        "result_json" = COALESCE("result_json", '{}'::jsonb)
          || CAST(${sourcePatch} AS jsonb),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = CAST(${locator.runId} AS uuid)
        AND "message_id" = CAST(${locator.messageId} AS uuid)
        AND "organization_id" = CAST(${locator.organizationId} AS uuid)
        AND "team_id" = CAST(${locator.teamId} AS uuid)
        AND "thread_id" = CAST(${locator.threadId} AS uuid)
        AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
        AND "external_run_id" = ${locator.externalRunId}
        AND (
          COALESCE("result_json" ->> 'sourceCountSource', '')
            <> ${TRUSTED_DEEP_WATER_SOURCE_COUNT_SOURCE}
          OR (
            "source_count" = ${locator.sourceCount}
            AND "result_json" ->> 'sourceCountSource'
              = ${TRUSTED_DEEP_WATER_SOURCE_COUNT_SOURCE}
          )
        )
      RETURNING "id"
    `)
    if (rows.length !== 1) return false

    // A separate READ COMMITTED statement is intentional. If terminal usage
    // reconciliation held the Product row lock first, this fresh snapshot sees
    // the event it inserted before releasing that lock. If this transaction
    // wins first, reconciliation reads the trusted count after we commit.
    await tx.$executeRaw(Prisma.sql`
      UPDATE "connector_usage_events"
      SET
        "units" = ${locator.sourceCount},
        "unit_type" = 'sources'
      WHERE "organization_id" = CAST(${locator.organizationId} AS uuid)
        AND "team_id" IS NOT DISTINCT FROM CAST(${locator.teamId} AS uuid)
        AND "correlation_id" = ${`${DEEP_WATER_PRODUCT_SLUG}:${locator.runId}`}
        AND "connector_type" = 'mcp'::"ConnectorType"
        AND "target" = ${DEEP_WATER_PRODUCT_SLUG}
    `)
    return true
  })
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
