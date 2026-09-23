import { Prisma, type PrismaClient } from '@prisma/client'
import { claimTaskEmbeddingInTransaction } from '@nessie/db'

type PendingTask = {
  detail: string | null
  id: string
  organizationId: string
  purpose: string | null
  title: string | null
}

const claimTaskEmbedding = async (
  prisma: PrismaClient,
  input: PendingTask & { embeddingModel: string },
): Promise<boolean> =>
  prisma.$transaction((tx) => claimTaskEmbeddingInTransaction(tx, input))

/** Bounded recovery for imported/legacy tickets and writes outside the UI. */
export const sweepTaskEmbeddings = async (
  prisma: PrismaClient,
  input: { embeddingModel: string; limit?: number },
): Promise<number> => {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
  const rows = await prisma.$queryRaw<PendingTask[]>(Prisma.sql`
    SELECT t.id, t.title, t.purpose, t.detail,
           t.organization_id AS "organizationId"
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN task_embeddings te ON te.task_id = t.id
    WHERE p.deleted_at IS NULL
      AND p.channel_root = false
      AND (
        te.id IS NULL
        OR te.content_hash IS DISTINCT FROM encode(digest(concat_ws(E'\n\n',
          NULLIF(coalesce(t.title, ''), ''),
          NULLIF(coalesce(t.purpose, ''), ''),
          NULLIF(coalesce(t.detail, ''), '')
        ), 'sha256'), 'hex')
        OR te.embedding_model IS DISTINCT FROM ${input.embeddingModel}
      )
    ORDER BY t.created_at, t.id
    LIMIT ${limit}
  `)
  let queued = 0
  for (const row of rows) {
    if (await claimTaskEmbedding(prisma, { ...row, embeddingModel: input.embeddingModel })) {
      queued += 1
    }
  }
  return queued
}

export const reapDeletedTaskEmbeddings = async (
  prisma: PrismaClient,
  limit = 100,
): Promise<number> => {
  const boundedLimit = Math.min(Math.max(limit, 1), 500)
  return prisma.$executeRaw(Prisma.sql`
    WITH stale AS (
      SELECT te.id
      FROM task_embeddings te
      LEFT JOIN tasks t ON t.id = te.task_id
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.id IS NULL
         OR t.project_id IS NULL
         OR p.id IS NULL
         OR p.deleted_at IS NOT NULL
         OR p.channel_root = true
      ORDER BY te.updated_at, te.id
      LIMIT ${boundedLimit}
    )
    DELETE FROM task_embeddings te
    USING stale
    WHERE te.id = stale.id
  `)
}

export { claimTaskEmbedding }
