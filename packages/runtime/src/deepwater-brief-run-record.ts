import { Prisma, type ProductIntegrationRun } from '@prisma/client'
import {
  DeepWaterBriefInputSchema,
  DeepWaterDeliveryBlockedReasonSchema,
  DeepWaterDisclosureSourcesSchema,
  DeepWaterReportKindSchema,
  DeepWaterRequesterIdentitySchema,
  DeepWaterScopeStateSchema,
  DeepWaterSourceScopesSchema,
  type DeepWaterBriefInput,
  type DeepWaterDeliveryBlockedReason,
  type DeepWaterDisclosureSource,
  type DeepWaterOriginKind,
  type DeepWaterReportKind,
  type DeepWaterRequesterIdentity,
  type DeepWaterScopeState,
  type DeepWaterSourceScope,
  type ProductIntegrationRunStatus,
} from '@nessie/schemas'

import { DEEP_WATER_PRODUCT_SLUG } from './integration-runs-mapping.js'

/**
 * A DeepWater brief product run with its JSON columns parsed. Every brief
 * primitive reads the row through `readDeepWaterBriefRun` and writes JSON
 * through the same schemas, so a malformed stored value fails at the boundary
 * it crossed instead of rendering as something plausible.
 */
/**
 * A launcher run's own facts, from its `result_json` (Water plan amendments
 * N9.6) — whether its handoff recorded a start call, which decides how it can
 * be cancelled (`deepwater-legacy-cancel.ts`).
 */
export type DeepWaterLauncherFacts = {
  startRecorded: boolean
}

export type DeepWaterBriefRun = {
  id: string
  organizationId: string
  teamId: string
  requestedByUserId: string | null
  connectorId: string | null
  channelId: string | null
  threadId: string | null
  cardMessageId: string | null
  externalRunId: string | null
  status: ProductIntegrationRunStatus
  title: string | null
  queryPreview: string
  originKind: DeepWaterOriginKind
  originAgentId: string | null
  originRunId: string | null
  originToolCallId: string | null
  principalUserId: string | null
  /** Null only for legacy launcher rows (the CHECK pins it to `scopeState`). */
  uoaIdentity: DeepWaterRequesterIdentity | null
  scopeState: DeepWaterScopeState | null
  input: DeepWaterBriefInput | null
  /** Null on a brief; set on a launcher run from before research briefs. */
  launcher: DeepWaterLauncherFacts | null
  sourceScopes: DeepWaterSourceScope[]
  disclosureSources: DeepWaterDisclosureSource[]
  failureCode: string | null
  reportKind: DeepWaterReportKind | null
  reportTruncated: boolean
  reportFileId: string | null
  sourcesFileId: string | null
  knowledgePageId: string | null
  sourceCount: number | null
  publicUrl: string | null
  resultMessageId: string | null
  wakeMessageId: string | null
  deliveredAt: Date | null
  deliveryBlockedReason: DeepWaterDeliveryBlockedReason | null
  agentWakeCount: number
  lastHandledTurnSeq: number | null
  wakeCapNoticeAt: Date | null
  ledgerObservedAt: Date
  reconcileAfter: Date
  reconcileSeq: number
  requestedAt: Date
  launchedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type DeepWaterBriefDb = Prisma.TransactionClient

/** Legacy launcher rows keep their launch request in `input_json`; only brief rows carry a brief input. */
const parseBriefInput = (row: ProductIntegrationRun): DeepWaterBriefInput | null =>
  row.uoaIdentity === null ? null : DeepWaterBriefInputSchema.parse(row.input)

const parseLauncherFacts = (row: ProductIntegrationRun): DeepWaterLauncherFacts | null => {
  if (row.uoaIdentity !== null) return null
  const result = row.result !== null && typeof row.result === 'object' && !Array.isArray(row.result)
    ? row.result as Record<string, unknown>
    : {}
  // The same test the cancel route makes under the row lock: the key's presence.
  return { startRecorded: Object.hasOwn(result, 'startToolCallId') }
}

const parseOriginKind = (value: string): DeepWaterOriginKind => {
  if (value === 'person' || value === 'agent') return value
  // The column CHECK admits nothing else.
  throw new Error(`product run origin_kind ${value} is outside the CHECK`)
}

export const toDeepWaterBriefRun = (row: ProductIntegrationRun): DeepWaterBriefRun => ({
  id: row.id,
  organizationId: row.organizationId,
  teamId: row.teamId,
  requestedByUserId: row.requestedByUserId,
  connectorId: row.connectorId,
  channelId: row.channelId,
  threadId: row.threadId,
  cardMessageId: row.messageId,
  externalRunId: row.externalRunId,
  status: row.status,
  title: row.title,
  queryPreview: row.queryPreview,
  originKind: parseOriginKind(row.originKind),
  originAgentId: row.originAgentId,
  originRunId: row.originRunId,
  originToolCallId: row.originToolCallId,
  principalUserId: row.principalUserId,
  uoaIdentity: row.uoaIdentity === null ? null : DeepWaterRequesterIdentitySchema.parse(row.uoaIdentity),
  scopeState: row.scopeJson === null ? null : DeepWaterScopeStateSchema.parse(row.scopeJson),
  input: parseBriefInput(row),
  launcher: parseLauncherFacts(row),
  sourceScopes: DeepWaterSourceScopesSchema.parse(row.sourceScopes),
  disclosureSources: DeepWaterDisclosureSourcesSchema.parse(row.disclosureSources),
  failureCode: row.failureCode,
  reportKind: row.reportKind === null ? null : DeepWaterReportKindSchema.parse(row.reportKind),
  reportTruncated: row.reportTruncated,
  reportFileId: row.reportFileId,
  sourcesFileId: row.sourcesFileId,
  knowledgePageId: row.knowledgePageId,
  sourceCount: row.sourceCount,
  publicUrl: row.publicUrl,
  resultMessageId: row.resultMessageId,
  wakeMessageId: row.wakeMessageId,
  deliveredAt: row.deliveredAt,
  deliveryBlockedReason: row.deliveryBlockedReason === null
    ? null
    : DeepWaterDeliveryBlockedReasonSchema.parse(row.deliveryBlockedReason),
  agentWakeCount: row.agentWakeCount,
  lastHandledTurnSeq: row.lastHandledTurnSeq,
  wakeCapNoticeAt: row.wakeCapNoticeAt,
  ledgerObservedAt: row.ledgerObservedAt,
  reconcileAfter: row.reconcileAfter,
  reconcileSeq: row.reconcileSeq,
  requestedAt: row.requestedAt,
  launchedAt: row.launchedAt,
  completedAt: row.completedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/** Read a deep-water run of this organisation, or null. */
export const readDeepWaterBriefRun = async (
  db: DeepWaterBriefDb,
  input: { organizationId: string; runId: string },
): Promise<DeepWaterBriefRun | null> => {
  const row = await db.productIntegrationRun.findFirst({
    where: { id: input.runId, organizationId: input.organizationId, productSlug: DEEP_WATER_PRODUCT_SLUG },
  })
  return row ? toDeepWaterBriefRun(row) : null
}

/**
 * The run a Ledger research id is bound to in this organisation and team, or
 * null — an id the team never opened, or one another team's run holds. One
 * research binds to at most one run (the `(product_slug, external_run_id)`
 * unique index), so the answer is unambiguous.
 */
export const findDeepWaterBriefRunByResearchId = async (
  db: DeepWaterBriefDb,
  input: { organizationId: string; teamId: string; researchId: string },
): Promise<DeepWaterBriefRun | null> => {
  const row = await db.productIntegrationRun.findFirst({
    where: {
      organizationId: input.organizationId,
      teamId: input.teamId,
      productSlug: DEEP_WATER_PRODUCT_SLUG,
      externalRunId: input.researchId,
    },
  })
  return row ? toDeepWaterBriefRun(row) : null
}

/**
 * Take the row lock every brief mutation serialises on, and read the
 * database clock with it so schedules are computed on one clock. Null when the
 * run is not a deep-water run of this organisation.
 */
export const lockDeepWaterBriefRun = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string },
): Promise<{ run: DeepWaterBriefRun; now: Date } | null> => {
  const locked = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT now() AS "now"
    FROM "product_integration_runs"
    WHERE "id" = CAST(${input.runId} AS uuid)
      AND "organization_id" = CAST(${input.organizationId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
    FOR UPDATE
  `)
  const now = locked[0]?.now
  if (!now) return null
  const run = await readDeepWaterBriefRun(tx, input)
  if (!run) {
    throw new Error(`DeepWater run ${input.runId} vanished under its own row lock`)
  }
  return { run, now }
}

export const deepWaterBriefJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue
