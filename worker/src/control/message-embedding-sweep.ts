import { Prisma, type PrismaClient } from '@prisma/client'
import { claimMessageEmbeddingInTransaction } from '@nessie/db'

type PendingMessage = { content: string; id: string; organizationId: string }

// The claim lives in `@nessie/db` so a send can claim inside its own
// transaction with the sender's identity. The sweep has no session, so its
// claims carry no origin and are skipped by a signing deployment's embed job.
const claimMessageEmbedding = async (
  prisma: PrismaClient,
  input: PendingMessage & { embeddingModel: string },
): Promise<boolean> =>
  prisma.$transaction((tx) => claimMessageEmbeddingInTransaction(tx, input))

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
    ORDER BY m.created_at, m.id
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
