import type { PrismaClient } from '@prisma/client'

type AttachmentAccessRow = {
  organizationId: string
  messageId: string | null
}

export const canAccessMessageAttachment = async (
  prisma: PrismaClient,
  input: {
    messageId: string
    organizationId: string
    userId: string
  },
): Promise<boolean> => {
  const message = await prisma.message.findFirst({
    where: {
      id: input.messageId,
      thread: {
        channel: {
          organizationId: input.organizationId,
          OR: [
            { visibility: 'public' },
            { members: { some: { userId: input.userId } } },
          ],
        },
      },
    },
    select: { id: true },
  })
  return Boolean(message)
}

export const canAccessAttachment = async (
  prisma: PrismaClient,
  attachment: AttachmentAccessRow,
  input: {
    organizationId: string
    userId: string
  },
): Promise<boolean> => {
  if (attachment.organizationId !== input.organizationId) return false
  if (!attachment.messageId) return true
  return canAccessMessageAttachment(prisma, {
    messageId: attachment.messageId,
    organizationId: input.organizationId,
    userId: input.userId,
  })
}
