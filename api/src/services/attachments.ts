import type { PrismaClient } from '@prisma/client'

type AttachmentAccessRow = {
  id: string
  organizationId: string
  messageId: string | null
  knowledgePageId: string | null
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
  if (attachment.messageId) {
    return canAccessMessageAttachment(prisma, {
      messageId: attachment.messageId,
      organizationId: input.organizationId,
      userId: input.userId,
    })
  }
  // Knowledge-base blobs (drawer attachments or file-node version objects) are
  // space-access-controlled and must only be served via the KB download routes,
  // which enforce canReadSpace. Deny them on this generic org-scoped endpoint so
  // a bare attachment id cannot bypass per-space ACLs.
  if (attachment.knowledgePageId) return false
  const kbVersion = await prisma.knowledgePageVersion.findFirst({
    where: { attachmentId: attachment.id },
    select: { id: true },
  })
  if (kbVersion) return false
  // Remaining null-message blobs are genuinely org-scoped (avatars, brand logo,
  // feedback) and visible to any member of the owning organization.
  return true
}
