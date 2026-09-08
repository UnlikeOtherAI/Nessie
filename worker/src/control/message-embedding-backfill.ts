import type { PrismaClient } from '@prisma/client'
import { claimMessageEmbedding } from './message-embedding-sweep.js'

const DEFAULT_BATCH_SIZE = 100
const MAX_BATCH_SIZE = 500

export type MessageEmbeddingBackfillInput = {
  cursor?: string
  embeddingModel: string
  limit?: number
  organizationId: string
}

export type MessageEmbeddingBackfillResult = {
  examined: number
  nextCursor: string | null
  queued: number
}

/**
 * A bounded cursor walk that schedules only canonical, live messages. Jobs are
 * keyed by source hash; a repeat walk or another replica is idempotent, and the
 * job itself rechecks the source after inference.
 */
export const backfillMessageEmbeddings = async (
  prisma: PrismaClient,
  input: MessageEmbeddingBackfillInput,
): Promise<MessageEmbeddingBackfillResult> => {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE)
  const messages = await prisma.message.findMany({
    where: {
      deletedAt: null,
      role: { in: ['user', 'assistant'] },
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      thread: { channel: { organizationId: input.organizationId } },
    },
    orderBy: { id: 'asc' },
    select: { content: true, id: true },
    take: limit,
  })
  let queued = 0
  for (const message of messages) {
    if (await claimMessageEmbedding(prisma, {
      ...message,
      embeddingModel: input.embeddingModel,
      organizationId: input.organizationId,
    })) queued += 1
  }
  return {
    examined: messages.length,
    nextCursor: messages.length === limit ? messages.at(-1)?.id ?? null : null,
    queued,
  }
}
