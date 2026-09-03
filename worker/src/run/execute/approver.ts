import type { PrismaClient } from '@prisma/client'

/**
 * The person an approval is pinned to, or nobody.
 *
 * `ApprovalRequest.requiredApproverUserId` narrows a request from "anyone who
 * can see this channel" to one accountable person — necessary for anything that
 * acts as somebody's mailbox, because approval visibility otherwise reaches
 * every member who can read a public channel.
 *
 * The check is liveness, and it is why this is a function rather than a field
 * read: a foreign key proves a membership row *exists*, never that it is still
 * active, and an approval pinned to a deactivated person is unanswerable —
 * strictly worse than an unpinned one. Returning null falls back to ordinary
 * approval visibility, which is the safe direction.
 */
export const liveApproverOrNull = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string | null | undefined },
): Promise<string | null> => {
  if (!input.userId) return null
  const live = await prisma.organizationMember.count({
    where: {
      deactivatedAt: null,
      organizationId: input.organizationId,
      userId: input.userId,
    },
  })
  return live > 0 ? input.userId : null
}
