import { Prisma } from '@prisma/client'
import {
  DEEP_WATER_PUBLIC_REPORT_ORIGIN,
  DEEP_WATER_RETRYABLE_DELIVERY_BLOCKS,
  DeepWaterDeliveryBlockedReasonSchema,
  DeepWaterFailureCodeSchema,
  isDeepWaterPublicReportUrl,
  type DeepWaterDeliveryBlockedReason,
  type DeepWaterReportKind,
} from '@nessie/schemas'

import type { DeepWaterBriefDb } from './deepwater-brief-run-record.js'
import { DEEP_WATER_PRODUCT_SLUG } from './integration-runs-mapping.js'

/**
 * Delivering a finished research exactly once (Water plan amendments N3).
 *
 * The steps before the claim — reading the report, storing `report.md` and
 * `sources.csv`, ensuring the Knowledge page — are safe to repeat, and each
 * records its receipt with a conditional write so a repeat adopts the first
 * winner. The terminal effects — the status, the reply or wake, the alert —
 * happen in the one transaction that wins `claimDeepWaterDelivery`. A blocked
 * delivery posts one notice per block, in the transaction that sets it.
 *
 * `delivered_at` means "the terminal outcome was delivered", for a completed
 * and a failed research alike.
 */

export type DeepWaterArtifactKind = 'report' | 'sources'

const ARTIFACT_COLUMN: Record<DeepWaterArtifactKind, Prisma.Sql> = {
  report: Prisma.sql`"report_file_id"`,
  sources: Prisma.sql`"sources_file_id"`,
}

/**
 * Record the attachment just stored for an artifact, unless one is already
 * recorded. Returns the recorded id: `stored` is false when an earlier attempt
 * won, and the caller must delete the attachment it just stored and use the
 * winner's (`FileService.delete`).
 */
export const recordDeepWaterArtifactFile = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; kind: DeepWaterArtifactKind; attachmentId: string },
): Promise<{ attachmentId: string; stored: boolean }> => {
  const column = ARTIFACT_COLUMN[input.kind]
  const recorded = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "product_integration_runs"
    SET ${column} = CAST(${input.attachmentId} AS uuid), "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${input.runId} AS uuid)
      AND "organization_id" = CAST(${input.organizationId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND ${column} IS NULL
    RETURNING ${column}::text AS "id"
  `)
  if (recorded[0]) return { attachmentId: recorded[0].id, stored: true }

  const winner = await tx.$queryRaw<Array<{ id: string | null }>>(Prisma.sql`
    SELECT ${column}::text AS "id"
    FROM "product_integration_runs"
    WHERE "id" = CAST(${input.runId} AS uuid)
      AND "organization_id" = CAST(${input.organizationId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
  `)
  const winnerId = winner[0]?.id
  if (!winnerId) {
    throw new Error(`DeepWater run ${input.runId} has no ${input.kind} artifact to adopt`)
  }
  return { attachmentId: winnerId, stored: false }
}

export type DeepWaterDeliveryOutcome =
  | {
      kind: 'completed'
      knowledgePageId: string
      sourceCount: number
      reportKind: DeepWaterReportKind | null
      truncated: boolean
      publicUrl: string | null
      title: string | null
    }
  | { kind: 'failed'; failureCode: string }

const assertPublicUrl = (publicUrl: string | null): string | null => {
  if (publicUrl === null) return null
  // The same rule as the Ledger DTOs and the column CHECK; failing here names
  // the cause instead of a constraint violation.
  if (!isDeepWaterPublicReportUrl(publicUrl)) {
    throw new Error(`DeepWater public report link must be on ${DEEP_WATER_PUBLIC_REPORT_ORIGIN}`)
  }
  return publicUrl
}

/**
 * Claim the one terminal delivery of a run. False means it was already
 * delivered or is blocked: the caller commits nothing else. True means the
 * caller writes the reply or wake (and the alert) in this same transaction.
 */
export const claimDeepWaterDelivery = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; outcome: DeepWaterDeliveryOutcome },
): Promise<boolean> => {
  const outcome = input.outcome
  const terminal = outcome.kind === 'completed'
    ? Prisma.sql`
        "status" = 'completed'::"ProductIntegrationRunStatus",
        "knowledge_page_id" = CAST(${outcome.knowledgePageId} AS uuid),
        "source_count" = ${outcome.sourceCount},
        "report_kind" = ${outcome.reportKind},
        "report_truncated" = ${outcome.truncated},
        "public_url" = ${assertPublicUrl(outcome.publicUrl)},
        "title" = COALESCE(${outcome.title}, "title")`
    : Prisma.sql`
        "status" = 'failed'::"ProductIntegrationRunStatus",
        "failure_code" = ${DeepWaterFailureCodeSchema.parse(outcome.failureCode)}`
  const claimed = await tx.$executeRaw(Prisma.sql`
    UPDATE "product_integration_runs"
    SET ${terminal},
        "delivered_at" = CURRENT_TIMESTAMP,
        "completed_at" = CURRENT_TIMESTAMP,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${input.runId} AS uuid)
      AND "organization_id" = CAST(${input.organizationId} AS uuid)
      AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
      AND "delivered_at" IS NULL
      AND "delivery_blocked_reason" IS NULL
  `)
  return claimed === 1
}

/** Record the message the claimed delivery wrote: the person's reply, or the agent's wake kickoff. */
export const recordDeepWaterDeliveryMessage = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string } & (
    | { resultMessageId: string; wakeMessageId?: never }
    | { wakeMessageId: string; resultMessageId?: never }
  ),
): Promise<void> => {
  await tx.productIntegrationRun.updateMany({
    where: { id: input.runId, organizationId: input.organizationId, productSlug: DEEP_WATER_PRODUCT_SLUG },
    data: input.resultMessageId
      ? { resultMessageId: input.resultMessageId }
      : { wakeMessageId: input.wakeMessageId },
  })
}

/**
 * Block delivery with a reason, once. True means this call set the block and
 * the caller posts the one notice naming its remedy in this same transaction.
 *
 * A retryable block keeps the run `running`, so its connector stays for the
 * retry; a final one (`report_expired`, `report_malformed`) completes the run
 * in the same statement.
 */
export const blockDeepWaterDelivery = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; reason: DeepWaterDeliveryBlockedReason },
): Promise<boolean> => {
  const reason = DeepWaterDeliveryBlockedReasonSchema.parse(input.reason)
  const final = !DEEP_WATER_RETRYABLE_DELIVERY_BLOCKS.has(reason)
  const now = new Date()
  const blocked = await tx.productIntegrationRun.updateMany({
    where: {
      id: input.runId,
      organizationId: input.organizationId,
      productSlug: DEEP_WATER_PRODUCT_SLUG,
      deliveredAt: null,
      deliveryBlockedReason: null,
    },
    data: {
      deliveryBlockedReason: reason,
      ...(final ? { status: 'completed', completedAt: now } : {}),
    },
  })
  return blocked.count === 1
}

/**
 * Clear a retryable block so delivery runs again (`POST …/deliver`). False when
 * the run is not blocked, or blocked for a reason no retry can fix.
 */
export const clearDeepWaterDeliveryBlock = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string },
): Promise<boolean> => {
  const cleared = await tx.productIntegrationRun.updateMany({
    where: {
      id: input.runId,
      organizationId: input.organizationId,
      productSlug: DEEP_WATER_PRODUCT_SLUG,
      deliveredAt: null,
      deliveryBlockedReason: { in: [...DEEP_WATER_RETRYABLE_DELIVERY_BLOCKS] },
    },
    data: { deliveryBlockedReason: null },
  })
  return cleared.count === 1
}
