import { Prisma } from '@prisma/client'
import {
  DeepWaterResearchRunRecordSchema,
  type DeepWaterResearchLaunchRequest,
  type DeepWaterResearchRunRecord,
  type ProductIntegrationRunStatus,
} from '@nessie/schemas'

/**
 * DeepWater run row shape + DB↔domain mapping. Split from `integration-runs.ts`
 * (the CRUD/reconciliation seam) so each file stays within the size cap and the
 * pure serialization concern is reusable and independently testable.
 */

export type DeepWaterRunRow = {
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

export const DEEP_WATER_PRODUCT_SLUG = 'deep-water'
export const DEFAULT_CURRENCY = 'USD'
export const TERMINAL_STATUSES: ProductIntegrationRunStatus[] = [
  'completed',
  'failed',
  'warning',
]

const QUERY_PREVIEW_MAX = 240

const toIsoString = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()

const toNullableIsoString = (value: Date | string | null): string | null =>
  value ? toIsoString(value) : null

export const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

export const toNullableNumber = (
  value: Prisma.Decimal | number | string | null,
): number | null => {
  if (value === null) return null
  const numeric = typeof value === 'number' ? value : Number(value.toString())
  return Number.isFinite(numeric) ? numeric : null
}

export const toNullableInteger = (value: number | null | undefined): number | null => {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.trunc(value))
}

export const toNullableCost = (value: number | null | undefined): number | null => {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value)) return null
  return Math.max(0, value)
}

const pickString = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T => allowed.includes(value as T) ? value as T : fallback

const pickNullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

export const compactPreview = (query: string): string =>
  query.replace(/\s+/g, ' ').trim().slice(0, QUERY_PREVIEW_MAX)

export const deepWaterInputJson = (
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

export const mapDeepWaterRunRow = (row: DeepWaterRunRow): DeepWaterResearchRunRecord => {
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

export const requireDeepWaterRunRow = (row: DeepWaterRunRow | undefined): DeepWaterRunRow => {
  if (!row) {
    throw new Error('Deep Water run was not returned by the database')
  }
  return row
}

export const deepWaterRunReturning = Prisma.sql`
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
