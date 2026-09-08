import { Prisma, type PrismaClient } from '@prisma/client'
import { MESSAGE_EMBED_TOPIC } from '@nessie/schemas'
import { enqueueQueueJob } from '../queue.js'
import { messageContentHash } from './message-embed.js'

type PendingMessage = { content: string; id: string; organizationId: string }

const claimMessageEmbedding = async (
  prisma: PrismaClient,
  input: PendingMessage & { embeddingModel: string },
): Promise<boolean> => {
  const contentHash = messageContentHash(input.content)
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$executeRaw(Prisma.sql`
      INSERT INTO message_embeddings (
        id, message_id, content_hash, embedding_model, status, created_at, updated_at
      )
      SELECT gen_random_uuid(), ${input.id}::uuid, ${contentHash}, ${input.embeddingModel},
             'pending', now(), now()
      WHERE EXISTS (
        SELECT 1 FROM messages m
        JOIN threads t ON t.id = m.thread_id
        JOIN channels c ON c.id = t.channel_id
        WHERE m.id = ${input.id}::uuid
          AND m.deleted_at IS NULL
          AND m.role IN ('user', 'assistant')
          AND c.organization_id = ${input.organizationId}::uuid
          AND encode(digest(m.content, 'sha256'), 'hex') = ${contentHash}
      )
      ON CONFLICT (message_id) DO UPDATE SET
        content_hash = EXCLUDED.content_hash,
        embedding = NULL,
        embedding_model = EXCLUDED.embedding_model,
        dims = NULL,
        status = 'pending',
        last_error = NULL,
        updated_at = now()
      WHERE message_embeddings.content_hash IS DISTINCT FROM EXCLUDED.content_hash
         OR message_embeddings.embedding_model IS DISTINCT FROM EXCLUDED.embedding_model
    `)
    if (Number(claimed) === 0) return false
    return enqueueQueueJob(tx, {
      idempotencyKey: `message-embed:${input.id}:${contentHash}:${input.embeddingModel}`,
      payload: {
        contentHash,
        embeddingModel: input.embeddingModel,
        messageId: input.id,
        organizationId: input.organizationId,
      },
      topic: MESSAGE_EMBED_TOPIC,
    })
  })
}

/**
 * One cluster-wide bounded pass. A durable pending row is the claim: after one
 * replica schedules the matching hash/model job, later passes skip it while the
 * queue owns bounded retries. Changed sources form a new claim and job key.
 */
export const sweepMessageEmbeddings = async (
  prisma: PrismaClient,
  input: { embeddingModel: string; limit?: number },
): Promise<number> => {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
  const rows = await prisma.$queryRaw<PendingMessage[]>(Prisma.sql`
    SELECT m.id, m.content, c.organization_id AS "organizationId"
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    JOIN channels c ON c.id = t.channel_id
    LEFT JOIN message_embeddings me ON me.message_id = m.id
    WHERE m.deleted_at IS NULL
      AND m.role IN ('user', 'assistant')
      AND (
        me.id IS NULL
        OR me.content_hash IS DISTINCT FROM encode(digest(m.content, 'sha256'), 'hex')
        OR me.embedding_model IS DISTINCT FROM ${input.embeddingModel}
      )
    ORDER BY m.updated_at, m.id
    LIMIT ${limit}
  `)
  let queued = 0
  for (const row of rows) {
    if (await claimMessageEmbedding(prisma, { ...row, embeddingModel: input.embeddingModel })) {
      queued += 1
    }
  }
  return queued
}

/** Removes projections whose canonical source was tombstoned or removed. */
export const reapDeletedMessageEmbeddings = async (
  prisma: PrismaClient,
  limit = 100,
): Promise<number> => {
  const boundedLimit = Math.min(Math.max(limit, 1), 500)
  return prisma.$executeRaw(Prisma.sql`
    WITH stale AS (
      SELECT me.id
      FROM message_embeddings me
      LEFT JOIN messages m ON m.id = me.message_id
      WHERE m.id IS NULL OR m.deleted_at IS NOT NULL
      ORDER BY me.updated_at, me.id
      LIMIT ${boundedLimit}
    )
    DELETE FROM message_embeddings me
    USING stale
    WHERE me.id = stale.id
  `)
}

export { claimMessageEmbedding }
