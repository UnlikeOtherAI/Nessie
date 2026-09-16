import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { LedgerAttribution, ModelClient } from '@nessie/runtime'
import {
  redactDetectedSecrets,
  EMBEDDING_DIMENSIONS,
  type MessageEmbedJobPayload,
} from '@nessie/schemas'

type MessageEmbedDeps = {
  modelClient: Pick<ModelClient, 'embedMany' | 'embeddingModel'>
  prisma: PrismaClient
}

type MessageSource = {
  agentId: string | null
  content: string
  onBehalfOfUserId: string | null
  threadId: string
  userId: string | null
  thread: {
    channel: { id: string; organizationId: string; projectId: string; teamId: string }
  }
}

type ProjectionState = {
  error: string | null
  status: 'failed' | 'indexed' | 'skipped'
  vector: number[] | null
}

export const messageContentHash = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex')

const attributionForMessage = (
  message: MessageSource,
  organizationId: string,
  messageId: string,
): LedgerAttribution => {
  const userId = message.userId ?? message.onBehalfOfUserId
  const actorId = message.agentId ?? userId ?? 'message-indexer'
  return {
    actorId,
    actorType: message.agentId ? 'agent' : userId ? 'user' : 'system',
    agentId: message.agentId,
    channelId: message.thread.channel.id,
    correlationId: null,
    organizationId,
    projectId: message.thread.channel.projectId,
    requestId: `message-index:${messageId}`,
    runId: null,
    systemComponent: 'message-index',
    teamId: message.thread.channel.teamId,
    threadId: message.threadId,
    userId,
  }
}

/** Writes only while the exact canonical source remains live and unchanged. */
const writeProjectionState = async (
  prisma: PrismaClient,
  payload: MessageEmbedJobPayload,
  state: ProjectionState,
): Promise<void> => {
  const vector = state.vector ? `[${state.vector.join(',')}]` : null
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO message_embeddings (
      id, message_id, content_hash, embedding, embedding_model, dims, status, last_error,
      created_at, updated_at
    )
    SELECT gen_random_uuid(), ${payload.messageId}::uuid, ${payload.contentHash},
           ${vector}::vector, ${payload.embeddingModel}, ${EMBEDDING_DIMENSIONS},
           ${state.status}, ${state.error}, now(), now()
    WHERE EXISTS (
      SELECT 1 FROM messages m
      JOIN threads t ON t.id = m.thread_id
      JOIN channels c ON c.id = t.channel_id
      WHERE m.id = ${payload.messageId}::uuid
        AND m.deleted_at IS NULL
        AND m.role IN ('user', 'assistant')
        AND c.organization_id = ${payload.organizationId}::uuid
        AND encode(digest(m.content, 'sha256'), 'hex') = ${payload.contentHash}
    )
    ON CONFLICT (message_id) DO UPDATE SET
      content_hash = EXCLUDED.content_hash,
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      dims = EXCLUDED.dims,
      status = EXCLUDED.status,
      last_error = EXCLUDED.last_error,
      updated_at = now()
  `)
}

/**
 * Index one canonical Message. The payload pins source hash and model; the
 * deployment's current model must match it. Source is rechecked after inference
 * before any vector/status write, so edits and tombstones discard stale work.
 */
export const executeMessageEmbedJob = async (
  deps: MessageEmbedDeps,
  payload: MessageEmbedJobPayload,
): Promise<void> => {
  if (payload.embeddingModel !== deps.modelClient.embeddingModel) return

  const message = await deps.prisma.message.findFirst({
    where: {
      deletedAt: null,
      id: payload.messageId,
      role: { in: ['user', 'assistant'] },
      thread: { channel: { organizationId: payload.organizationId } },
    },
    select: {
      agentId: true,
      content: true,
      onBehalfOfUserId: true,
      threadId: true,
      userId: true,
      thread: {
        select: {
          channel: {
            select: { id: true, organizationId: true, projectId: true, teamId: true },
          },
        },
      },
    },
  })
  if (!message || messageContentHash(message.content) !== payload.contentHash) return

  const safeContent = redactDetectedSecrets(message.content).trim()
  if (!safeContent) {
    await writeProjectionState(deps.prisma, payload, {
      error: null,
      status: 'skipped',
      vector: null,
    })
    return
  }

  let vector: number[] | undefined
  try {
    [vector] = await deps.modelClient.embedMany([safeContent], {
      usage: attributionForMessage(message, payload.organizationId, payload.messageId),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 500) : 'embedding request failed'
    await writeProjectionState(deps.prisma, payload, { error: detail, status: 'failed', vector: null })
    throw error
  }
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
    const detail = `embedding dimensions ${vector?.length ?? 'missing'}; expected ${EMBEDDING_DIMENSIONS}`
    await writeProjectionState(deps.prisma, payload, { error: detail, status: 'failed', vector: null })
    throw new Error(detail)
  }
  await writeProjectionState(deps.prisma, payload, { error: null, status: 'indexed', vector })
}
