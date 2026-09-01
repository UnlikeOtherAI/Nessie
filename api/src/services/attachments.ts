import type { PrismaClient } from '@prisma/client'

type AttachmentAccessRow = {
  id: string
  organizationId: string
  messageId: string | null
  knowledgePageId: string | null
  uploaderId: string | null
}

/**
 * A message-less attachment is only legitimately readable org-wide once it has
 * been *published* as an avatar, a brand logo, or attached to feedback. A blob
 * that is merely uploaded — a draft attachment, or one whose message send was
 * abandoned — has no such reference, and handing those to any org member on a
 * bare id is exactly the leak this guards.
 *
 * The caller has already confirmed the attachment is in the viewer's org, and
 * each of these references can only be created by someone who could reach the
 * attachment, so a reference implies same-org visibility.
 */
const isPublishedOrgAsset = async (
  prisma: PrismaClient,
  attachmentId: string,
  organizationId: string,
): Promise<boolean> => {
  const [userAvatars, agentAvatars, projectAvatars, orgLogos, feedback] = await Promise.all([
    prisma.user.count({ where: { avatarAttachmentId: attachmentId } }),
    prisma.agent.count({ where: { avatarAttachmentId: attachmentId } }),
    prisma.project.count({ where: { avatarAttachmentId: attachmentId } }),
    prisma.organization.count({
      where: { id: organizationId, logoAttachmentId: attachmentId },
    }),
    prisma.feedback.count({ where: { attachmentId, organizationId } }),
  ])
  return userAvatars > 0 || agentAvatars > 0 || projectAvatars > 0 || orgLogos > 0 || feedback > 0
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
  // The uploader can always fetch their own pending upload; everyone else only
  // once it has been published as an avatar, logo or feedback attachment.
  if (attachment.uploaderId && attachment.uploaderId === input.userId) return true
  return isPublishedOrgAsset(prisma, attachment.id, input.organizationId)
}
