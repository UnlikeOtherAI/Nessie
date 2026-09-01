import { Prisma, type PrismaClient } from '@prisma/client'
import {
  type DeepWaterResearchLaunchRequest,
  type DeepWaterResearchRunRecord,
  type ProductIntegrationRunStatus,
} from '@nessie/schemas'
import type { LedgerAttribution } from './ledger.js'
import {
  assertImmutableDeepWaterUpdate,
  type DeepWaterImmutableRunState,
} from './deepwater-run-update-guards.js'
import {
  DEEP_WATER_PRODUCT_SLUG,
  TERMINAL_STATUSES,
  TRUSTED_DEEP_WATER_SOURCE_COUNT_SOURCE,
  compactPreview,
  deepWaterInputJson,
  deepWaterRunReturning,
  mapDeepWaterRunRow,
  requireDeepWaterRunRow,
  toRecord,
  type DeepWaterRunRow,
} from './integration-runs-mapping.js'

export {
  DeepWaterResearchRunConflictError,
  type DeepWaterResearchRunConflictField,
} from './deepwater-run-update-guards.js'

type DeepWaterLaunchOwner = {
  connectorId: string
  input: DeepWaterResearchLaunchRequest
  organizationId: string
  requestedByUserId: string
  teamId: string
}

type DeepWaterUsageLedgerRow = {
  id: string
  organization_id: string
  team_id: string
  requested_by_user_id: string
  connector_id: string | null
  channel_id: string | null
  thread_id: string | null
  external_run_id: string | null
  status: ProductIntegrationRunStatus
  result_json: unknown
  source_count: number | null
}

export type DeepWaterResearchRunUpdateInput = {
  completedAt?: Date | null
  externalRunId?: string | null
  knowledgePageId?: string | null
  organizationId: string
  result?: Record<string, unknown>
  runId: string
  status?: ProductIntegrationRunStatus
  statusDetail?: string | null
  // Tenancy comes strictly from the calling run context, never from args. A
  // granted agent may only mutate a run in its own team that is attached to the
  // thread it is running in — this blocks cross-team / cross-thread writes and
  // prompt-injected `runId` tampering against unattached org runs.
  teamId: string
  threadId: string
}

export type DeepWaterResearchRunUsageReconciliationResult =
  | { recorded: true; correlationId: string }
  | {
      recorded: false
      reason:
        | 'already_recorded'
        | 'non_terminal_status'
        | 'run_not_found'
    }

export type DeepWaterResearchRunUsageReconciliationInput = {
  attribution: LedgerAttribution
  organizationId: string
  runId: string
}

export const createDeepWaterResearchRun = async (
  prisma: PrismaClient,
  input: DeepWaterLaunchOwner,
): Promise<DeepWaterResearchRunRecord> => {
  const inputJson = JSON.stringify(deepWaterInputJson(input.input))
  const rows = await prisma.$queryRaw<DeepWaterRunRow[]>(Prisma.sql`
    INSERT INTO "product_integration_runs" (
      "organization_id",
      "team_id",
      "product_slug",
      "requested_by_user_id",
      "connector_id",
      "status",
      "query_preview",
      "input_json",
      "result_json",
      "updated_at"
    )
    VALUES (
      CAST(${input.organizationId} AS uuid),
      CAST(${input.teamId} AS uuid),
      ${DEEP_WATER_PRODUCT_SLUG},
      CAST(${input.requestedByUserId} AS uuid),
      CAST(${input.connectorId} AS uuid),
      'queued'::"ProductIntegrationRunStatus",
      ${compactPreview(input.input.query)},
      CAST(${inputJson} AS jsonb),
      '{}'::jsonb,
      CURRENT_TIMESTAMP
    )
    RETURNING ${deepWaterRunReturning}
  `)

  return mapDeepWaterRunRow(requireDeepWaterRunRow(rows[0]))
}

export const attachDeepWaterResearchHandoff = async (
  prisma: PrismaClient,
  input: {
    channelId: string
    messageId: string
    organizationId: string
    runId: string
    threadId: string
  },
): Promise<DeepWaterResearchRunRecord> => {
  const rows = await prisma.$queryRaw<DeepWaterRunRow[]>(Prisma.sql`
    UPDATE "product_integration_runs"
    SET
      "channel_id" = CAST(${input.channelId} AS uuid),
      "thread_id" = CAST(${input.threadId} AS uuid),
      "message_id" = CAST(${input.messageId} AS uuid),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${input.runId} AS uuid)
      AND "organization_id" = CAST(${input.organizationId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
    RETURNING ${deepWaterRunReturning}
  `)

  return mapDeepWaterRunRow(requireDeepWaterRunRow(rows[0]))
}

export const markDeepWaterResearchRunFailed = async (
  prisma: PrismaClient,
  input: { organizationId: string; runId: string },
): Promise<void> => {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "product_integration_runs"
    SET
      "status" = 'failed'::"ProductIntegrationRunStatus",
      "result_json" = jsonb_set(
        COALESCE("result_json", '{}'::jsonb),
        '{failure}',
        '{"stage":"personal_assistant_handoff"}'::jsonb,
        true
      ),
      "completed_at" = COALESCE("completed_at", CURRENT_TIMESTAMP),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${input.runId} AS uuid)
      AND "organization_id" = CAST(${input.organizationId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND "status" NOT IN ('completed', 'failed', 'warning')
  `)
}

const hasUsageLedgerRecorded = (result: Record<string, unknown>): boolean =>
  typeof result.usageLedgerRecordedAt === 'string'
  || typeof result.usageLedgerCorrelationId === 'string'

const buildDeepWaterResultPatch = (
  input: DeepWaterResearchRunUpdateInput,
): Prisma.InputJsonObject => {
  const result: Record<string, unknown> = { ...(input.result ?? {}) }
  // Report metadata and its provenance are persisted only from authenticated
  // Ledger responses. Never let a generic or agent-authored run update replace
  // the trusted values or forge the markers that make them externally visible.
  delete result.reportUrl
  delete result.reportUrlSource
  delete result.sourceCount
  delete result.sourceCountSource
  delete result.legacyDispatchEvidence
  if (input.statusDetail !== undefined) {
    result.statusDetail = input.statusDetail?.trim() || null
  }
  return result as Prisma.InputJsonObject
}

export const updateDeepWaterResearchRun = async (
  prisma: PrismaClient,
  input: DeepWaterResearchRunUpdateInput,
): Promise<DeepWaterResearchRunRecord> => {
  const resultPatchJson = JSON.stringify(buildDeepWaterResultPatch(input))
  const externalRunId = input.externalRunId?.trim() || null
  const knowledgePageId = input.knowledgePageId?.trim() || null
  const status = input.status ?? null
  const teamId = input.teamId
  const threadId = input.threadId
  const completedAt = input.completedAt === undefined ? null : input.completedAt

  // A Knowledge page is only stamped onto the run after we confirm it exists and
  // belongs to the same organization — a prompt-injected id must never point the
  // durable run record at another tenant's document.
  if (knowledgePageId) {
    const page = await prisma.knowledgePage.findFirst({
      where: { id: knowledgePageId, organizationId: input.organizationId },
      select: { id: true },
    })
    if (!page) {
      throw new Error('knowledgePageId does not reference a Knowledge page in this organization')
    }
  }
  const shouldComplete =
    input.completedAt !== undefined
    || (status ? TERMINAL_STATUSES.includes(status) : false)

  return prisma.$transaction(async (tx) => {
    // Serialize all writers for this exact tenant/thread run. Under PostgreSQL's
    // READ COMMITTED default, a concurrent waiter sees the committed winner
    // after acquiring this lock and therefore validates against the durable
    // terminal/external-id values rather than a stale snapshot.
    const stateRows = await tx.$queryRaw<DeepWaterImmutableRunState[]>(Prisma.sql`
      SELECT
        "external_run_id",
        "status"::text AS "status",
        "result_json"
      FROM "product_integration_runs"
      WHERE "id" = CAST(${input.runId} AS uuid)
        AND "organization_id" = CAST(${input.organizationId} AS uuid)
        AND "team_id" = CAST(${teamId} AS uuid)
        AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
        AND "thread_id" = CAST(${threadId} AS uuid)
      FOR UPDATE
    `)
    const current = stateRows[0]
    if (!current) {
      throw new Error('Deep Water run was not returned by the database')
    }
    assertImmutableDeepWaterUpdate(current, {
      externalRunId,
      status,
    })

    const rows = await tx.$queryRaw<DeepWaterRunRow[]>(Prisma.sql`
      UPDATE "product_integration_runs"
      SET
        "external_run_id" = CASE
          WHEN "external_run_id" IS NULL THEN CAST(${externalRunId} AS text)
          ELSE "external_run_id"
        END,
        "status" = CASE
          WHEN CAST(${status} AS "ProductIntegrationRunStatus") IS NULL THEN "status"
          ELSE CAST(${status} AS "ProductIntegrationRunStatus")
        END,
        "result_json" = COALESCE("result_json", '{}'::jsonb) || CAST(${resultPatchJson} AS jsonb),
        "knowledge_page_id" = CASE
          WHEN CAST(${knowledgePageId} AS uuid) IS NULL THEN "knowledge_page_id"
          ELSE CAST(${knowledgePageId} AS uuid)
        END,
        "completed_at" = CASE
          WHEN CAST(${shouldComplete} AS boolean)
            THEN COALESCE("completed_at", CAST(${completedAt} AS timestamp), CURRENT_TIMESTAMP)
          ELSE "completed_at"
        END,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = CAST(${input.runId} AS uuid)
        AND "organization_id" = CAST(${input.organizationId} AS uuid)
        AND "team_id" = CAST(${teamId} AS uuid)
        AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
        AND "thread_id" = CAST(${threadId} AS uuid)
      RETURNING ${deepWaterRunReturning}
    `)

    return mapDeepWaterRunRow(requireDeepWaterRunRow(rows[0]))
  })
}

export const reconcileDeepWaterResearchRunUsage = async (
  prisma: PrismaClient,
  input: DeepWaterResearchRunUsageReconciliationInput,
): Promise<DeepWaterResearchRunUsageReconciliationResult> =>
  prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<DeepWaterUsageLedgerRow[]>(Prisma.sql`
      SELECT
        "id",
        "organization_id",
        "team_id",
        "requested_by_user_id",
        "connector_id",
        "channel_id",
        "thread_id",
        "external_run_id",
        "status",
        "result_json",
        "source_count"
      FROM "product_integration_runs"
      WHERE "id" = CAST(${input.runId} AS uuid)
        AND "organization_id" = CAST(${input.organizationId} AS uuid)
        AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      FOR UPDATE
    `)
    const row = rows[0]
    if (!row) {
      return { recorded: false, reason: 'run_not_found' }
    }
    if (!TERMINAL_STATUSES.includes(row.status)) {
      return { recorded: false, reason: 'non_terminal_status' }
    }

    const result = toRecord(row.result_json)
    if (hasUsageLedgerRecorded(result)) {
      return { recorded: false, reason: 'already_recorded' }
    }
    const sourceCount =
      result.sourceCountSource === TRUSTED_DEEP_WATER_SOURCE_COUNT_SOURCE
        ? row.source_count
        : null

    const occurredAt = new Date()
    const correlationId = `${DEEP_WATER_PRODUCT_SLUG}:${row.id}`
    await tx.connectorUsageEvent.create({
      data: {
        actorId: input.attribution.actorId,
        actorType: input.attribution.actorType ?? null,
        agentId: input.attribution.agentId ?? null,
        calls: 1,
        channelId: row.channel_id ?? input.attribution.channelId ?? null,
        connectorId: row.connector_id,
        connectorType: 'mcp',
        correlationId,
        latencyMs: null,
        metadata: {
          commercialAuthority: 'uoa',
          externalRunId: row.external_run_id,
          metering: 'operational_only',
          productIntegrationRunId: row.id,
          productSlug: DEEP_WATER_PRODUCT_SLUG,
          source: 'deep_water_run_update',
          status: row.status,
        } as Prisma.InputJsonValue,
        occurredAt,
        operation: `research.${row.status}`,
        organizationId: row.organization_id,
        // The launch owner is immutable. A different granted agent/user may
        // deliver the terminal update, but may never take ownership of its
        // operational call/source telemetry.
        userId: row.requested_by_user_id,
        projectId: input.attribution.projectId ?? null,
        requestId: input.attribution.requestId ?? null,
        runId: input.attribution.runId ?? null,
        success: row.status !== 'failed',
        target: DEEP_WATER_PRODUCT_SLUG,
        taskId: input.attribution.taskId ?? null,
        teamId: row.team_id,
        threadId: row.thread_id ?? input.attribution.threadId ?? null,
        units: sourceCount,
        unitType: sourceCount === null ? null : 'sources',
      },
    })

    await tx.$executeRaw(Prisma.sql`
      UPDATE "product_integration_runs"
      SET
        "result_json" = COALESCE("result_json", '{}'::jsonb) || CAST(${JSON.stringify({
          usageLedgerCorrelationId: correlationId,
          usageLedgerRecordedAt: occurredAt.toISOString(),
        })} AS jsonb),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = CAST(${row.id} AS uuid)
    `)

    return { recorded: true, correlationId }
  })

export const listDeepWaterResearchRuns = async (
  prisma: PrismaClient,
  input: { limit?: number; organizationId: string; teamId: string },
): Promise<DeepWaterResearchRunRecord[]> => {
  const take = Math.max(1, Math.min(50, input.limit ?? 10))
  const rows = await prisma.$queryRaw<DeepWaterRunRow[]>(Prisma.sql`
    SELECT ${deepWaterRunReturning}
    FROM "product_integration_runs"
    WHERE "organization_id" = CAST(${input.organizationId} AS uuid)
      AND "team_id" = CAST(${input.teamId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
    ORDER BY "requested_at" DESC, "id" DESC
    LIMIT ${take}
  `)

  return rows.map(mapDeepWaterRunRow)
}
