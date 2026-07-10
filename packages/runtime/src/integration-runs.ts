import { Prisma, type PrismaClient } from '@prisma/client'
import {
  DeepWaterResearchRunRecordSchema,
  type DeepWaterResearchLaunchRequest,
  type DeepWaterResearchRunRecord,
  type ProductIntegrationRunStatus,
} from '@nessie/schemas'

type DeepWaterRunRow = {
  id: string
  organization_id: string
  team_id: string
  product_slug: string
  requested_by_user_id: string | null
  connector_id: string | null
  channel_id: string | null
  thread_id: string | null
  message_id: string | null
  external_run_id: string | null
  status: ProductIntegrationRunStatus
  title: string | null
  query_preview: string
  input_json: unknown
  result_json: unknown
  cost_amount: Prisma.Decimal | number | string | null
  cost_currency: string | null
  source_count: number | null
  knowledge_page_id: string | null
  requested_at: Date | string
  completed_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

type DeepWaterLaunchOwner = {
  connectorId: string
  input: DeepWaterResearchLaunchRequest
  organizationId: string
  requestedByUserId: string
  teamId: string
}

export type DeepWaterResearchRunUpdateInput = {
  completedAt?: Date | null
  costAmount?: number | null
  costCurrency?: string | null
  externalRunId?: string | null
  knowledgePageId?: string | null
  organizationId: string
  reportUrl?: string | null
  result?: Record<string, unknown>
  runId: string
  sourceCount?: number | null
  status?: ProductIntegrationRunStatus
  statusDetail?: string | null
  threadId?: string | null
}

const DEEP_WATER_PRODUCT_SLUG = 'deep-water'
const QUERY_PREVIEW_MAX = 240
const DEFAULT_CURRENCY = 'USD'
const TERMINAL_STATUSES: ProductIntegrationRunStatus[] = ['completed', 'failed', 'warning']

const toIsoString = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()

const toNullableIsoString = (value: Date | string | null): string | null =>
  value ? toIsoString(value) : null

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const toNullableNumber = (
  value: Prisma.Decimal | number | string | null,
): number | null => {
  if (value === null) return null
  const numeric = typeof value === 'number' ? value : Number(value.toString())
  return Number.isFinite(numeric) ? numeric : null
}

const pickString = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T => allowed.includes(value as T) ? value as T : fallback

const pickNullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const compactPreview = (query: string): string =>
  query.replace(/\s+/g, ' ').trim().slice(0, QUERY_PREVIEW_MAX)

const deepWaterInputJson = (
  input: DeepWaterResearchLaunchRequest,
): Prisma.InputJsonObject => ({
  artifactDestination: input.artifactDestination,
  chapterDepth: input.chapterDepth,
  depth: input.depth,
  outputLanguage: input.outputLanguage,
  outputTier: input.outputTier,
  query: input.query,
  recency: input.recency,
  searchQuality: input.searchQuality,
  searchesPerPillar: input.searchesPerPillar,
  sections: input.sections,
  title: input.title ?? null,
})

const mapDeepWaterRunRow = (row: DeepWaterRunRow): DeepWaterResearchRunRecord => {
  const input = toRecord(row.input_json)
  const result = toRecord(row.result_json)
  return DeepWaterResearchRunRecordSchema.parse({
    id: row.id,
    artifactDestination: pickString(
      input.artifactDestination,
      ['knowledge_draft', 'chat_only'] as const,
      'knowledge_draft',
    ),
    channelId: row.channel_id,
    completedAt: toNullableIsoString(row.completed_at),
    connectorId: row.connector_id,
    createdAt: toIsoString(row.created_at),
    currency: row.cost_currency ?? DEFAULT_CURRENCY,
    depth: pickString(
      input.depth,
      ['light', 'standard', 'deep', 'heavy', 'thesis', 'dissertation'] as const,
      'standard',
    ),
    externalRunId: row.external_run_id,
    knowledgePageId: row.knowledge_page_id,
    messageId: row.message_id,
    organizationId: row.organization_id,
    outputTier: pickString(input.outputTier, ['summary', 'full'] as const, 'full'),
    productSlug: DEEP_WATER_PRODUCT_SLUG,
    queryPreview: row.query_preview,
    reportUrl: pickNullableString(result.reportUrl),
    requestedAt: toIsoString(row.requested_at),
    requestedByUserId: row.requested_by_user_id,
    searchQuality: pickString(input.searchQuality, ['standard', 'premium'] as const, 'standard'),
    sourceCount: row.source_count,
    status: row.status,
    statusDetail: pickNullableString(result.statusDetail),
    teamId: row.team_id,
    threadId: row.thread_id,
    title: row.title,
    totalCost: toNullableNumber(row.cost_amount),
    updatedAt: toIsoString(row.updated_at),
  })
}

const requireDeepWaterRunRow = (row: DeepWaterRunRow | undefined): DeepWaterRunRow => {
  if (!row) {
    throw new Error('Deep Water run was not returned by the database')
  }
  return row
}

const deepWaterRunReturning = Prisma.sql`
  "id"::text AS "id",
  "organization_id"::text AS "organization_id",
  "team_id"::text AS "team_id",
  "product_slug",
  "requested_by_user_id"::text AS "requested_by_user_id",
  "connector_id"::text AS "connector_id",
  "channel_id"::text AS "channel_id",
  "thread_id"::text AS "thread_id",
  "message_id"::text AS "message_id",
  "external_run_id",
  "status"::text AS "status",
  "title",
  "query_preview",
  "input_json",
  "result_json",
  "cost_amount",
  "cost_currency",
  "source_count",
  "knowledge_page_id"::text AS "knowledge_page_id",
  "requested_at",
  "completed_at",
  "created_at",
  "updated_at"
`

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
      "title",
      "query_preview",
      "input_json",
      "result_json",
      "cost_currency",
      "updated_at"
    )
    VALUES (
      CAST(${input.organizationId} AS uuid),
      CAST(${input.teamId} AS uuid),
      ${DEEP_WATER_PRODUCT_SLUG},
      CAST(${input.requestedByUserId} AS uuid),
      CAST(${input.connectorId} AS uuid),
      'queued'::"ProductIntegrationRunStatus",
      ${input.input.title?.trim() || null},
      ${compactPreview(input.input.query)},
      CAST(${inputJson} AS jsonb),
      '{}'::jsonb,
      ${DEFAULT_CURRENCY},
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
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${input.runId} AS uuid)
      AND "organization_id" = CAST(${input.organizationId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
  `)
}

const toNullableInteger = (value: number | null | undefined): number | null => {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.trunc(value))
}

const toNullableCost = (value: number | null | undefined): number | null => {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value)) return null
  return Math.max(0, value)
}

const buildDeepWaterResultPatch = (
  input: DeepWaterResearchRunUpdateInput,
): Prisma.InputJsonObject => {
  const result: Record<string, unknown> = { ...(input.result ?? {}) }
  if (input.reportUrl !== undefined) {
    result.reportUrl = input.reportUrl?.trim() || null
  }
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
  const costAmount = toNullableCost(input.costAmount)
  const costCurrency = input.costCurrency?.trim() || null
  const externalRunId = input.externalRunId?.trim() || null
  const knowledgePageId = input.knowledgePageId?.trim() || null
  const sourceCount = toNullableInteger(input.sourceCount)
  const status = input.status ?? null
  const threadId = input.threadId?.trim() || null
  const completedAt = input.completedAt === undefined ? null : input.completedAt
  const shouldComplete =
    input.completedAt !== undefined
    || (status ? TERMINAL_STATUSES.includes(status) : false)

  const rows = await prisma.$queryRaw<DeepWaterRunRow[]>(Prisma.sql`
    UPDATE "product_integration_runs"
    SET
      "external_run_id" = CASE
        WHEN ${externalRunId} IS NULL THEN "external_run_id"
        ELSE ${externalRunId}
      END,
      "status" = CASE
        WHEN ${status} IS NULL THEN "status"
        ELSE CAST(${status} AS "ProductIntegrationRunStatus")
      END,
      "result_json" = COALESCE("result_json", '{}'::jsonb) || CAST(${resultPatchJson} AS jsonb),
      "cost_amount" = CASE
        WHEN ${costAmount} IS NULL THEN "cost_amount"
        ELSE CAST(${costAmount} AS DECIMAL(18, 6))
      END,
      "cost_currency" = CASE
        WHEN ${costCurrency} IS NULL THEN "cost_currency"
        ELSE ${costCurrency}
      END,
      "source_count" = CASE
        WHEN ${sourceCount} IS NULL THEN "source_count"
        ELSE ${sourceCount}
      END,
      "knowledge_page_id" = CASE
        WHEN ${knowledgePageId} IS NULL THEN "knowledge_page_id"
        ELSE CAST(${knowledgePageId} AS uuid)
      END,
      "completed_at" = CASE
        WHEN ${shouldComplete} THEN COALESCE(${completedAt}, "completed_at", CURRENT_TIMESTAMP)
        ELSE "completed_at"
      END,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${input.runId} AS uuid)
      AND "organization_id" = CAST(${input.organizationId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND (
        ${threadId} IS NULL
        OR "thread_id" IS NULL
        OR "thread_id" = CAST(${threadId} AS uuid)
      )
    RETURNING ${deepWaterRunReturning}
  `)

  return mapDeepWaterRunRow(requireDeepWaterRunRow(rows[0]))
}

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
