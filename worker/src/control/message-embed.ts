import { Prisma, type PrismaClient } from '@prisma/client'
import { messageContentHash } from '@nessie/db'
import type { LedgerAttribution, ModelClient } from '@nessie/runtime'
import {
  redactDetectedSecrets,
  EMBEDDING_DIMENSIONS,
  type MessageEmbedJobPayload,
} from '@nessie/schemas'

type MessageEmbedDeps = {
  /**
   * True when every Ledger call this worker makes is signed, and therefore
   * refused without the originating session's UOA identity.
   */
  ledgerSigningConfigured?: boolean
  modelClient: Pick<ModelClient, 'embedMany' | 'embeddingModel'>
  prisma: PrismaClient
}

/** `last_error` on a projection no signing deployment can ever produce. */
export const MESSAGE_EMBED_IDENTITY_UNAVAILABLE = 'uoa_identity_unavailable'

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

export { messageContentHash }

const attributionForMessage = (
  message: MessageSource,
  payload: MessageEmbedJobPayload,
): LedgerAttribution => {
  // The captured origin names who the embed is done for — the sender, or the
  // person an agent replied to — and carries that session's identity.
  const userId = payload.origin?.userId ?? message.userId ?? message.onBehalfOfUserId
  const actorId = message.agentId ?? userId ?? 'message-indexer'
  return {
    actorId,
    actorType: message.agentId ? 'agent' : userId ? 'user' : 'system',
    agentId: message.agentId,
    channelId: message.thread.channel.id,
    correlationId: null,
    organizationId: payload.organizationId,
    projectId: message.thread.channel.projectId,
    requestId: `message-index:${payload.messageId}`,
    runId: null,
    systemComponent: 'message-index',
    teamId: message.thread.channel.teamId,
    threadId: message.threadId,
    userId,
    ...(payload.origin ? { uoaIdentity: payload.origin.uoaIdentity } : {}),
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

  // A signing deployment refuses an embed without the originating session's
  // identity, and a sweep or backfill claim has none. No retry can supply one,
  // so this source hash is recorded as skipped instead of dead-lettering.
  if (deps.ledgerSigningConfigured && !payload.origin) {
    await writeProjectionState(deps.prisma, payload, {
      error: MESSAGE_EMBED_IDENTITY_UNAVAILABLE,
      status: 'skipped',
      vector: null,
    })
    return
  }

  let vector: number[] | undefined
  try {
    [vector] = await deps.modelClient.embedMany([safeContent], {
      usage: attributionForMessage(message, payload),
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
