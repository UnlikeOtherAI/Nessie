import type { PrismaClient } from '@prisma/client'
import { SPREADSHEET_LIMITS } from '@nessie/schemas'
import {
  createSpreadsheetService,
  createSpreadsheetSnapshot,
  type SpreadsheetModelCache,
} from '@nessie/knowledge'
import type { FileService, PgRealtimeTransport } from '@nessie/runtime'
import { z } from 'zod'

/**
 * `spreadsheet.compact` — the queued half of the compaction cadence.
 *
 * The write door enqueues this once a page has accumulated
 * `compactEveryBatches` journal batches with no durable version. The job takes
 * one: an xlsx rendition, the engine bytes beside it and the text projection
 * that keeps search current. The idle sweep (Phase 5) is the other half and
 * shares this handler.
 *
 * Compaction is housekeeping, and it is deliberately *not* pruning: there is
 * no retention policy on spreadsheet versions, because versions are the only
 * thing that makes an unreviewed agent edit reversible. What compaction bounds
 * is replay cost and search staleness, never history.
 *
 * The job is idempotent by the cheapest possible test: if no batches have
 * landed since the last version, there is nothing to capture and it returns.
 * A redelivery therefore costs one query rather than a duplicate xlsx.
 */

export const SPREADSHEET_COMPACT_TOPIC = 'spreadsheet.compact'

export const SpreadsheetCompactJobPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  pageId: z.string().uuid(),
  /** The head seq that triggered this job; advisory, used only in the comment. */
  seq: z.number().int().min(0).optional(),
})
export type SpreadsheetCompactJobPayload = z.infer<typeof SpreadsheetCompactJobPayloadSchema>

/** Stable per page and per cadence step, so two enqueues cannot both run. */
export const spreadsheetCompactJobKey = (pageId: string, seq: number): string =>
  `sheet-compact:${pageId}:${Math.floor(seq / SPREADSHEET_LIMITS.compactEveryBatches)}`

export type SpreadsheetCompactDeps = {
  prisma: PrismaClient
  fileService: FileService
  /** Shared across jobs in this process so a busy page is not reloaded per job. */
  cache: SpreadsheetModelCache
  realtime?: PgRealtimeTransport
  createPage: Parameters<typeof createSpreadsheetService>[0]['createPage']
  addFileVersion: Parameters<typeof createSpreadsheetService>[0]['addFileVersion']
}

export const executeSpreadsheetCompactJob = async (
  deps: SpreadsheetCompactDeps,
  payload: SpreadsheetCompactJobPayload,
): Promise<{ versionId: string | null }> => {
  const head = await deps.prisma.spreadsheetHead.findFirst({
    where: { pageId: payload.pageId, organizationId: payload.organizationId },
    select: { batchesSinceSnapshot: true, headSeq: true },
  })
  if (!head) return { versionId: null }
  if (head.batchesSinceSnapshot === 0) return { versionId: null }

  const page = await deps.prisma.knowledgePage.findFirst({
    where: { id: payload.pageId, organizationId: payload.organizationId, deletedAt: null },
    select: { id: true, createdBy: true },
  })
  // An archived or deleted page has nothing left to version; its blobs are
  // purged with it.
  if (!page) return { versionId: null }

  const service = createSpreadsheetService({
    prisma: deps.prisma,
    fileService: deps.fileService,
    cache: deps.cache,
    createPage: deps.createPage,
    addFileVersion: deps.addFileVersion,
    ...(deps.realtime
      ? {
          publish: async (event, input) => {
            await deps.realtime?.publishDocumentEphemeral(
              input.pageId,
              input.organizationId,
              event,
              input.data,
            )
          },
        }
      : {}),
  })

  const snapshot = await createSpreadsheetSnapshot(service, {
    organizationId: payload.organizationId,
    pageId: payload.pageId,
    // A compaction has no human behind it. It is attributed to the page's
    // creator so the version row has a real author rather than a service id
    // nobody can look up, and the comment says plainly that nobody asked.
    actor: { type: 'user', id: page.createdBy, displayName: 'Nessie' },
    attribution: {
      organizationId: payload.organizationId,
      actorType: 'system',
      actorId: 'spreadsheet-compaction',
    } as Parameters<typeof createSpreadsheetSnapshot>[1]['attribution'],
    reason: 'compaction',
    changeComment: 'compaction',
  })

  return { versionId: snapshot.versionId }
}
