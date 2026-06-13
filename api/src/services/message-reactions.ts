import type { PrismaClient } from '@prisma/client'

type ToggleUserReactionResult = {
  kind: 'created' | 'deleted' | 'not_found'
}

const userReactionWhere = (input: {
  emoji: string
  messageId: string
  userId: string
}) => ({
  messageId_userId_emoji: {
    emoji: input.emoji,
    messageId: input.messageId,
    userId: input.userId,
  },
})

export const toggleUserReaction = async (
  prisma: PrismaClient,
  input: {
    emoji: string
    messageId: string
    threadId: string
    userId: string
  },
): Promise<ToggleUserReactionResult> => {
  const where = userReactionWhere(input)

  return prisma.$transaction(async (tx) => {
    const message = await tx.message.findFirst({
      where: {
        deletedAt: null,
        id: input.messageId,
        threadId: input.threadId,
      },
      select: { id: true },
    })
    if (!message) {
      return { kind: 'not_found' }
    }

    const existing = await tx.messageReaction.findUnique({ where })

    if (existing) {
      await tx.messageReaction.delete({ where })
      return { kind: 'deleted' }
    }

    await tx.messageReaction.create({
      data: {
        emoji: input.emoji,
        messageId: input.messageId,
        userId: input.userId,
      },
    })
    return { kind: 'created' }
  })
}
