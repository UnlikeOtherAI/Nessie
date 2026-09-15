import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { MESSAGE_EMBED_TOPIC, type MessageEmbedOrigin } from '@nessie/schemas'
import { enqueueQueueJob } from './queue.js'

export const messageContentHash = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex')

export type MessageEmbeddingClaimInput = {
  content: string
  embeddingModel: string
  id: string
  organizationId: string
  /** Present only where a session exists: the send itself, or its reply run. */
  origin?: MessageEmbedOrigin
}

/**
 * Claim one message's projection and enqueue its embed job in the caller's
 * transaction. A durable pending row is the claim: whoever claims a source hash
 * first owns its job, so a send that claims with the sender's identity wins over
 * a later sweep that has none. Changed sources form a new claim and job key.
 */
export const claimMessageEmbeddingInTransaction = async (
  tx: Prisma.TransactionClient,
  input: MessageEmbeddingClaimInput,
): Promise<boolean> => {
  const contentHash = messageContentHash(input.content)
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
      ...(input.origin ? { origin: input.origin } : {}),
    },
    topic: MESSAGE_EMBED_TOPIC,
  })
}
