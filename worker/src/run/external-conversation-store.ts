import { Prisma } from '@prisma/client'

import type { ExecutionDependencies } from './execute/types.js'

/**
 * Persistence + concurrency helpers for the external-conversation driver
 * (DeepSignal integration plan §5/§6). Kept out of the driver flow so the run
 * lifecycle reads top-to-bottom; this module owns thread-metadata round-tripping,
 * inbound-message tagging for history dedupe, and the per-thread first-turn lock.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const readConversationId = (metadata: unknown, slug: string): string | null => {
  if (!isRecord(metadata)) return null
  const bag = metadata[slug]
  if (isRecord(bag) && typeof bag.conversationId === 'string' && bag.conversationId.length > 0) {
    return bag.conversationId
  }
  return null
}

export const writeConversationId = async (
  deps: ExecutionDependencies,
  threadId: string,
  metadata: unknown,
  slug: string,
  conversationId: string,
): Promise<void> => {
  const base = isRecord(metadata) ? metadata : {}
  const bag = isRecord(base[slug]) ? (base[slug] as Record<string, unknown>) : {}
  await deps.prisma.thread.update({
    where: { id: threadId },
    data: {
      metadata: { ...base, [slug]: { ...bag, conversationId } } as Prisma.InputJsonValue,
    },
  })
}

/**
 * Tag the inbound user message that drove this turn with its DeepSignal
 * `userTurnId` so history re-hydration dedupes it (plan §6). The user message is
 * persisted by the normal send path with no `external` key; without this tag it
 * would re-import from `conversation_history` on every channel reopen. Merge, do
 * not clobber — the send path already wrote `metadata.mentions`.
 */
export const tagInboundUserMessage = async (
  deps: ExecutionDependencies,
  messageId: string,
  external: { product: string; conversationId: string | null; turnId: string },
): Promise<void> => {
  const existing = await deps.prisma.message.findUnique({
    where: { id: messageId },
    select: { metadata: true },
  })
  const base = isRecord(existing?.metadata) ? existing.metadata : {}
  await deps.prisma.message.update({
    where: { id: messageId },
    data: { metadata: { ...base, external } as Prisma.InputJsonValue },
  })
}

/**
 * In-process per-thread serialization for the first-turn conversationId race:
 * two turns dispatched before the first `conversationId` write completes would
 * each mint a separate DeepSignal conversation and clobber `thread.metadata`.
 * Serializing per thread lets a concurrent second turn observe the first turn's
 * stored conversationId and reuse it. Private-DM concurrency is rare and, in
 * practice, single-worker; this guards the common case without cross-process
 * coordination machinery.
 */
const threadLocks = new Map<string, Promise<void>>()

export const withThreadLock = async <T>(
  threadId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const prior = threadLocks.get(threadId) ?? Promise.resolve()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  threadLocks.set(threadId, gate)
  await prior
  try {
    return await fn()
  } finally {
    release()
    if (threadLocks.get(threadId) === gate) {
      threadLocks.delete(threadId)
    }
  }
}
