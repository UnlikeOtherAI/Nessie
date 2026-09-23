import type { PrismaClient } from '@prisma/client'
import { isAdminRole, type UoaSessionIdentity } from '@nessie/schemas'
import { isAgentVisibleToUser, isTaskAccessibleToUser } from '@nessie/team-admin'

import { buildDisclosureReadableThreadWhere } from './agent-read-primitives.js'
import { canUserReadRunDerivedRecord } from './run-derived-read.js'

type AttachmentAccessRow = {
  id: string
  organizationId: string
  messageId: string | null
  knowledgePageId: string | null
  emailMessageId: string | null
  taskId: string | null
  executorCommandId: string | null
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

/**
 * A hosted-mailbox email attachment is readable by exactly whoever can read the
 * mailbox — the SAME question `readableMailboxForAgent` asks, deliberately.
 *
 * The obvious shortcut is the backing channel's public-or-membership predicate,
 * the way a message attachment works. That is a *different* question, and the
 * two answers can disagree: a mailbox on an agent whose visibility narrows
 * (a private agent, or one whose steward is deactivated) stops being readable
 * through every conversation route while channel membership stays put, leaving
 * the blobs reachable by bare id after the mail around them went dark. Asking
 * agent visibility here keeps the conversation surface and the byte surface
 * closing together.
 *
 * `retiredAt` is part of it for the same reason: retiring a mailbox 404s every
 * read route, and its attachments must go with them.
 */
export const canAccessEmailAttachment = async (
  prisma: PrismaClient,
  input: {
    emailMessageId: string
    organizationId: string
    userId: string
  },
): Promise<boolean> => {
  const email = await prisma.emailMessage.findFirst({
    where: {
      id: input.emailMessageId,
      mailbox: { retiredAt: null },
      organizationId: input.organizationId,
    },
    select: { mailbox: { select: { agentId: true } } },
  })
  if (!email?.mailbox) return false
  return isAgentVisibleToUser(
    prisma,
    input.userId,
    input.organizationId,
    email.mailbox.agentId,
  )
}

/**
 * An image a local program returned in an executor command is that program's
 * output, and host program output is the launch conversation's
 * (docs/standards/disclosure-boundaries.md): it is readable by exactly whoever
 * may read the command's run. That is two questions, both asked:
 *
 * - the run's conversation, read the way every disclosure-bearing agent read
 *   reads it — a DM or system room by its participants only, a deleted
 *   channel by nobody, and no owner-wide shortcut into a private room;
 * - the run's own provenance (`canUserReadRunDerivedRecord`): its trigger's
 *   basis and the basis the run consumed, so a screenshot taken while the run
 *   held a private source is withheld exactly as the reply built on it is.
 *
 * The uploader — the person the command ran for — gets no shortcut: they are
 * admitted by the same two questions, which their own launch always answers.
 */
export const canAccessExecutorCommandAttachment = async (
  prisma: PrismaClient,
  input: {
    executorCommandId: string
    organizationId: string
    uoaIdentity: UoaSessionIdentity | undefined
    userId: string
  },
): Promise<boolean> => {
  const command = await prisma.executorCommand.findUnique({
    where: { id: input.executorCommandId },
    select: { toolCall: { select: { runId: true } } },
  })
  if (!command) return false
  const runId = command.toolCall.runId
  const inConversation = await prisma.run.findFirst({
    where: {
      id: runId,
      thread: buildDisclosureReadableThreadWhere({
        organizationId: input.organizationId,
        userId: input.userId,
      }),
    },
    select: { id: true },
  })
  if (!inConversation) return false
  return canUserReadRunDerivedRecord(prisma, {
    organizationId: input.organizationId,
    runId,
    uoaIdentity: input.uoaIdentity,
    userId: input.userId,
  })
}

const isOrganizationAdmin = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<boolean> => {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: input.organizationId, userId: input.userId } },
    select: { role: true, deactivatedAt: true },
  })
  return Boolean(member && !member.deactivatedAt && isAdminRole(member.role))
}

export const canAccessAttachment = async (
  prisma: PrismaClient,
  attachment: AttachmentAccessRow,
  input: {
    organizationId: string
    userId: string
    /** From the verified request when the caller has it; otherwise read from the membership. */
    isOrganizationAdmin?: boolean
    /** The request's UOA assertion, for the disclosure checks; absent without an IdP. */
    uoaIdentity?: UoaSessionIdentity
  },
): Promise<boolean> => {
  if (attachment.organizationId !== input.organizationId) return false
  // Before every other arm, and answering alone: an executor command's image
  // is never re-linked, and its uploader must not read it past the run's own
  // disclosure.
  if (attachment.executorCommandId) {
    return canAccessExecutorCommandAttachment(prisma, {
      executorCommandId: attachment.executorCommandId,
      organizationId: input.organizationId,
      uoaIdentity: input.uoaIdentity,
      userId: input.userId,
    })
  }
  if (attachment.messageId) {
    return canAccessMessageAttachment(prisma, {
      messageId: attachment.messageId,
      organizationId: input.organizationId,
      userId: input.userId,
    })
  }
  if (attachment.emailMessageId) {
    return canAccessEmailAttachment(prisma, {
      emailMessageId: attachment.emailMessageId,
      organizationId: input.organizationId,
      userId: input.userId,
    })
  }
  // A file on a ticket is readable by exactly whoever can read the ticket —
  // the one predicate the comment and attachment doors ask too.
  if (attachment.taskId) {
    return isTaskAccessibleToUser(prisma, {
      organizationId: input.organizationId,
      userId: input.userId,
      isOrganizationAdmin: input.isOrganizationAdmin ?? await isOrganizationAdmin(prisma, input),
    }, attachment.taskId)
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
