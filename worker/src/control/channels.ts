import type { PrismaClient } from '@prisma/client'

/**
 * The channel's own General thread, created if it is missing.
 *
 * `agentId: null` is the whole predicate, not a decoration: a channel can now
 * hold many threads, and every one of them but General is a conversation *with*
 * an agent (docs/plans/2026-09-08-agent-conversations.md). Without the pin,
 * `orderBy createdAt asc` would happily return a conversation that happened to
 * be created before the room's General row and hand it back as "the room".
 */
export const ensureDefaultThread = async (
  prisma: PrismaClient,
  channelId: string,
): Promise<string> => {
  const existingThread = await prisma.thread.findFirst({
    where: { agentId: null, channelId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })

  if (existingThread) {
    return existingThread.id
  }

  try {
    const thread = await prisma.thread.create({
      data: { channelId, title: 'General' },
      select: { id: true },
    })
    return thread.id
  } catch {
    const fallback = await prisma.thread.findFirst({
      where: { agentId: null, channelId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    return fallback!.id
  }
}
