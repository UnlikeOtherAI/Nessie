import type { PrismaClient } from '@prisma/client'
import {
  isMarkdownAttachment,
  knowledgeEmbeddingJobKey,
  projectMarkdownAttachment,
  replaceKnowledgePageVersionChunks,
  resolvePersistedKnowledgeOrigin,
  type MarkdownAttachmentReader,
} from '@nessie/knowledge'
import { KNOWLEDGE_EMBED_TOPIC } from '@nessie/schemas'
import { enqueueQueueJob } from '../queue.js'

const DEFAULT_BATCH_SIZE = 100
const MAX_BATCH_SIZE = 500

type BackfillDeps = {
  embeddingModel: string | null
  prisma: PrismaClient
  readMarkdownAttachment: MarkdownAttachmentReader
}

export type MarkdownBackfillInput = {
  cursor?: string
  limit?: number
  organizationId: string
}

export type MarkdownBackfillResult = {
  chunked: number
  examined: number
  nextCursor: string | null
  projected: number
  queued: number
  skippedConcurrentChange: number
  skippedWithoutEmbeddingModel: number
  skippedWithoutOrigin: number
}

const batchSize = (limit: number | undefined): number =>
  Math.min(Math.max(limit ?? DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE)

/**
 * Repairs only projections that can be proved from an existing immutable
 * attachment. It never adds a version: lineage, author, and attachment stay
 * fixed while the derived body/chunks are repaired in place.
 */
export const backfillMarkdownProjections = async (
  deps: BackfillDeps,
  input: MarkdownBackfillInput,
): Promise<MarkdownBackfillResult> => {
  const limit = batchSize(input.limit)
  const versions = await deps.prisma.knowledgePageVersion.findMany({
    where: {
      attachmentId: { not: null },
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      page: {
        deletedAt: null,
        kind: 'file',
        organizationId: input.organizationId,
      },
    },
    include: { page: { select: { id: true, organizationId: true } } },
    orderBy: { id: 'asc' },
    take: limit,
  })

  let chunked = 0
  let projected = 0
  let queued = 0
  let skippedConcurrentChange = 0
  let skippedWithoutEmbeddingModel = 0
  let skippedWithoutOrigin = 0
  for (const version of versions) {
    if (!version.attachmentId) continue
    const attachment = await deps.prisma.attachment.findUnique({
      where: { id: version.attachmentId },
      select: { filename: true, mime: true, organizationId: true },
    })
    if (
      !attachment
      || attachment.organizationId !== input.organizationId
      || !isMarkdownAttachment(attachment)
    ) {
      continue
    }

    const projection = await projectMarkdownAttachment(
      deps.readMarkdownAttachment,
      version.attachmentId,
      input.organizationId,
    )
    const result = await deps.prisma.$transaction(async (tx) => {
      // Re-check organization, undeleted file page, and exact attachment after
      // I/O. A concurrent delete or revision change must not resurrect chunks.
      const current = await tx.knowledgePageVersion.findFirst({
        where: {
          attachmentId: version.attachmentId,
          id: version.id,
          page: {
            deletedAt: null,
            id: version.page.id,
            kind: 'file',
            organizationId: input.organizationId,
          },
        },
        include: {
          chunks: { select: { embeddingModel: true, id: true } },
          page: {
            select: {
              channelId: true,
              id: true,
              organizationId: true,
              privateToAgentId: true,
              projectId: true,
              sensitivityTier: true,
              taskId: true,
              teamId: true,
              threadId: true,
              userId: true,
              visibility: true,
            },
          },
        },
      })
      if (!current) return { kind: 'concurrent-change' as const }

      const projectionChanged = current.body !== projection.body
        || current.sourceContentHash !== projection.sourceContentHash
      if (projectionChanged) {
        await tx.knowledgePageVersion.update({
          where: { id: current.id },
          data: {
            body: projection.body,
            bodyRef: null,
            sourceContentHash: projection.sourceContentHash,
          },
        })
        await tx.knowledgePageChunk.deleteMany({ where: { versionId: current.id } })
      }

      const written = projectionChanged || current.chunks.length === 0
        ? await replaceKnowledgePageVersionChunks(tx, {
            page: current.page,
            version: { body: projection.body, id: current.id },
          })
        : false
      const needsCurrentModel = deps.embeddingModel !== null
        && (written || current.chunks.some((chunk) => chunk.embeddingModel !== deps.embeddingModel))
      if (!needsCurrentModel) {
        return {
          kind: deps.embeddingModel === null && (written || current.chunks.length > 0)
            ? 'without-model' as const
            : 'complete' as const,
          projected: projectionChanged,
          written,
        }
      }

      const origin = await resolvePersistedKnowledgeOrigin(tx, {
        organizationId: input.organizationId,
        pageId: current.page.id,
        systemComponent: 'knowledge-markdown-backfill',
        versionId: current.id,
      })
      if (!origin) return { kind: 'without-origin' as const, projected: projectionChanged, written }
      const enqueued = await enqueueQueueJob(tx, {
        idempotencyKey: knowledgeEmbeddingJobKey(
          current.page.id,
          current.id,
          deps.embeddingModel,
          projection.sourceContentHash,
        ),
        payload: {
          organizationId: input.organizationId,
          pageId: current.page.id,
          versionId: current.id,
          origin,
        },
        topic: KNOWLEDGE_EMBED_TOPIC,
      })
      return { kind: 'queued' as const, enqueued, projected: projectionChanged, written }
    })

    if (result.kind === 'concurrent-change') skippedConcurrentChange += 1
    if (result.kind === 'without-model') skippedWithoutEmbeddingModel += 1
    if (result.kind === 'without-origin') skippedWithoutOrigin += 1
    if ('projected' in result && result.projected) projected += 1
    if ('written' in result && result.written) chunked += 1
    if (result.kind === 'queued' && result.enqueued) queued += 1
  }

  return {
    chunked,
    examined: versions.length,
    nextCursor: versions.length === limit ? versions.at(-1)?.id ?? null : null,
    projected,
    queued,
    skippedConcurrentChange,
    skippedWithoutEmbeddingModel,
    skippedWithoutOrigin,
  }
}
