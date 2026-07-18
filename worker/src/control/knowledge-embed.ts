import { Prisma, type PrismaClient } from '@prisma/client'
import type { LedgerAttribution, ModelClient } from '@nessie/runtime'
import {
  KNOWLEDGE_EMBEDDING_DIMS,
  KNOWLEDGE_EMBEDDING_MODEL,
  KnowledgeInferenceOriginSchema,
  type KnowledgeEmbedJobPayload,
} from '@nessie/schemas'

// `knowledge.embed` worker handler — fills the NULL `embedding` column on a
// page version's chunk rows. Two phases:
//   1. Copy: any chunk whose content_hash already has an embedding elsewhere
//      in the org (same model) is filled for free — identical content never
//      re-embeds even across pages/versions.
//   2. Provider calls: whatever the copy step didn't cover is embedded via the
//      shared ModelClient, batched (<=64 chunks per call) to bound request size.
// Provider failures propagate so the queue retries (maxAttempts 3); the copy
// step makes a retry cheap since previously-written vectors are never redone.

const EMBED_BATCH_SIZE = 64

type KnowledgeEmbedDeps = {
  modelClient: ModelClient
  prisma: PrismaClient
}

type PendingChunk = { id: string; content: string }

const toVectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`

const copySameHashEmbeddings = async (
  prisma: PrismaClient,
  payload: KnowledgeEmbedJobPayload,
): Promise<void> => {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE knowledge_page_chunks c
    SET embedding = src.embedding, embedding_model = src.embedding_model,
        dims = src.dims, updated_at = now()
    FROM (
      SELECT DISTINCT ON (content_hash) content_hash, embedding, embedding_model, dims
      FROM knowledge_page_chunks
      WHERE organization_id = ${payload.organizationId}::uuid
        AND embedding IS NOT NULL
        AND embedding_model = ${KNOWLEDGE_EMBEDDING_MODEL}
        AND content_hash IN (
          SELECT content_hash FROM knowledge_page_chunks
          WHERE version_id = ${payload.versionId}::uuid AND embedding IS NULL
        )
      ORDER BY content_hash, created_at DESC
    ) src
    WHERE c.version_id = ${payload.versionId}::uuid AND c.embedding IS NULL
      AND c.content_hash = src.content_hash
  `)
}

const loadPendingChunks = async (
  prisma: PrismaClient,
  payload: KnowledgeEmbedJobPayload,
): Promise<PendingChunk[]> =>
  prisma.$queryRaw<PendingChunk[]>(Prisma.sql`
    SELECT id, content FROM knowledge_page_chunks
    WHERE version_id = ${payload.versionId}::uuid AND embedding IS NULL
    ORDER BY chunk_index
  `)

const writeEmbeddingBatch = async (
  prisma: PrismaClient,
  rows: Array<{ id: string; vector: number[] }>,
): Promise<void> => {
  if (rows.length === 0) {
    return
  }

  await prisma.$executeRaw(Prisma.sql`
    UPDATE knowledge_page_chunks c
    SET embedding = v.embedding::vector,
        embedding_model = ${KNOWLEDGE_EMBEDDING_MODEL},
        dims = ${KNOWLEDGE_EMBEDDING_DIMS},
        updated_at = now()
    FROM (VALUES ${Prisma.join(
      rows.map((row) => Prisma.sql`(${row.id}::uuid, ${toVectorLiteral(row.vector)})`),
    )}) AS v(id, embedding)
    WHERE c.id = v.id
  `)
}

const deleteStaleVersionChunks = async (
  prisma: PrismaClient,
  payload: KnowledgeEmbedJobPayload,
): Promise<void> => {
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM knowledge_page_chunks c
    USING knowledge_page_versions v
    WHERE c.page_id = ${payload.pageId}::uuid AND c.version_id = v.id
      AND v.version_number < (
        SELECT version_number FROM knowledge_page_versions WHERE id = ${payload.versionId}::uuid
      )
  `)
}

const embedPendingChunks = async (
  deps: KnowledgeEmbedDeps,
  payload: KnowledgeEmbedJobPayload,
  pending: PendingChunk[],
  attribution: LedgerAttribution,
): Promise<void> => {
  for (let offset = 0; offset < pending.length; offset += EMBED_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + EMBED_BATCH_SIZE)
    const vectors = await deps.modelClient.embedMany(
      batch.map((chunk) => chunk.content),
      { model: KNOWLEDGE_EMBEDDING_MODEL, usage: attribution },
    )

    const rows: Array<{ id: string; vector: number[] }> = []
    vectors.forEach((vector, index) => {
      const chunk = batch[index]
      if (!chunk) {
        return
      }
      if (vector.length !== KNOWLEDGE_EMBEDDING_DIMS) {
        console.error('[worker.knowledge-embed] embedding dims mismatch, skipping chunk', {
          chunkId: chunk.id,
          expectedDims: KNOWLEDGE_EMBEDDING_DIMS,
          gotDims: vector.length,
          organizationId: payload.organizationId,
          pageId: payload.pageId,
          versionId: payload.versionId,
        })
        return
      }
      rows.push({ id: chunk.id, vector })
    })

    await writeEmbeddingBatch(deps.prisma, rows)
  }
}

export const executeKnowledgeEmbedJob = async (
  deps: KnowledgeEmbedDeps,
  payload: KnowledgeEmbedJobPayload,
): Promise<void> => {
  // Validate before touching storage or the model seam so a legacy/malformed
  // queue payload can never escape as an unattributed Ledger request.
  const origin = KnowledgeInferenceOriginSchema.parse(payload.origin)
  const page = await deps.prisma.knowledgePage.findFirst({
    where: {
      id: payload.pageId,
      organizationId: payload.organizationId,
      deletedAt: null,
    },
    select: {
      id: true,
      projectId: true,
      teamId: true,
      channelId: true,
      threadId: true,
    },
  })

  // The page was deleted after the job was enqueued — nothing to embed.
  if (!page) {
    return
  }

  await copySameHashEmbeddings(deps.prisma, payload)

  const pending = await loadPendingChunks(deps.prisma, payload)

  if (pending.length > 0) {
    const attribution: LedgerAttribution = {
      organizationId: payload.organizationId,
      userId: origin.userId,
      projectId: page.projectId,
      teamId: page.teamId ?? origin.teamId,
      channelId: page.channelId,
      threadId: page.threadId,
      runId: origin.runId,
      agentId: origin.agentId,
      actorId: origin.actorId,
      actorType: origin.actorType,
      requestId: origin.requestId,
      correlationId: origin.correlationId ?? null,
      systemComponent: origin.systemComponent ?? null,
    }

    await embedPendingChunks(deps, payload, pending, attribution)
  }

  await deleteStaleVersionChunks(deps.prisma, payload)
}
