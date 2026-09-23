import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { TASK_EMBED_TOPIC, type TaskEmbedOrigin } from '@nessie/schemas'
import { enqueueQueueJob } from './queue.js'

export type TaskSearchText = {
  detail?: string | null
  purpose?: string | null
  title?: string | null
}

/** Stable source text shared by claims, workers and sweeps. */
export const taskSearchContent = (task: TaskSearchText): string =>
  [task.title, task.purpose, task.detail]
    // Hash the stored source exactly. Normalising here and then trying to
    // repeat JavaScript's Unicode `trim()` inside Postgres makes the stale-job
    // fence disagree for tabs and other edge whitespace.
    .map((part) => part ?? '')
    .filter((part) => part.length > 0)
    .join('\n\n')

export const taskContentHash = (task: TaskSearchText): string =>
  createHash('sha256').update(taskSearchContent(task), 'utf8').digest('hex')

export type TaskEmbeddingClaimInput = TaskSearchText & {
  embeddingModel: string
  id: string
  organizationId: string
  origin?: TaskEmbedOrigin
}

/** Claim and enqueue the exact current ticket projection in one transaction. */
export const claimTaskEmbeddingInTransaction = async (
  tx: Prisma.TransactionClient,
  input: TaskEmbeddingClaimInput,
): Promise<boolean> => {
  const contentHash = taskContentHash(input)
  const claimed = await tx.$executeRaw(Prisma.sql`
    INSERT INTO task_embeddings (
      id, task_id, content_hash, embedding_model, status, created_at, updated_at
    )
    SELECT gen_random_uuid(), ${input.id}::uuid, ${contentHash}, ${input.embeddingModel},
           'pending', now(), now()
    WHERE EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = ${input.id}::uuid
        AND t.organization_id = ${input.organizationId}::uuid
        AND t.project_id IS NOT NULL
        AND p.deleted_at IS NULL
        AND p.channel_root = false
        AND encode(digest(concat_ws(E'\n\n',
          NULLIF(coalesce(t.title, ''), ''),
          NULLIF(coalesce(t.purpose, ''), ''),
          NULLIF(coalesce(t.detail, ''), '')
        ), 'sha256'), 'hex') = ${contentHash}
    )
    ON CONFLICT (task_id) DO UPDATE SET
      content_hash = EXCLUDED.content_hash,
      embedding = NULL,
      embedding_model = EXCLUDED.embedding_model,
      dims = NULL,
      status = 'pending',
      last_error = NULL,
      updated_at = now()
    WHERE task_embeddings.content_hash IS DISTINCT FROM EXCLUDED.content_hash
       OR task_embeddings.embedding_model IS DISTINCT FROM EXCLUDED.embedding_model
  `)
  if (Number(claimed) === 0) return false
  return enqueueQueueJob(tx, {
    idempotencyKey: `task-embed:${input.id}:${contentHash}:${input.embeddingModel}`,
    payload: {
      contentHash,
      embeddingModel: input.embeddingModel,
      organizationId: input.organizationId,
      taskId: input.id,
      ...(input.origin ? { origin: input.origin } : {}),
    },
    topic: TASK_EMBED_TOPIC,
  })
}
