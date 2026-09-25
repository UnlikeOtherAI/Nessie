import type { Prisma, PrismaClient } from '@prisma/client'
import { isAdminRole } from '@nessie/schemas'

type Client = PrismaClient | Prisma.TransactionClient

/** Live membership governs sharing, including every command and presence read. */
export const resolveExecutorSharedAccess = async (
  prisma: Client, executorId: string, userId: string, projectId?: string | null,
): Promise<{ use: boolean; admin: boolean }> => {
  const sharing = await prisma.executorTeamAccess.findUnique({
    where: { executorId },
    include: {
      team: { select: { members: { where: { userId }, select: { role: true } } } },
      executor: { select: { projectAccess: { select: {
        projectId: true, project: { select: { members: { where: { userId }, select: { userId: true } } } },
      } } } },
    },
  })
  if (!sharing) return { use: false, admin: false }
  const membership = sharing.team.members[0]
  const projects = sharing.executor.projectAccess
  const admin = Boolean(membership && isAdminRole(membership.role) && (sharing.everyone || projects.length > 0))
  return {
    admin,
    use: admin || Boolean(sharing.everyone && membership) || projects.some((entry) =>
      entry.project.members.length > 0 && (projectId === undefined || entry.projectId === projectId)),
  }
}

/** A read filter, not a session-team filter: every explicit entitlement remains visible. */
export const executorSharingVisibility = (userId: string): Prisma.ExecutorWhereInput => ({
  OR: [
    { teamAccess: { everyone: true, team: { members: { some: { userId } } } } },
    { projectAccess: { some: { project: { members: { some: { userId } } } } } },
    { teamAccess: { team: { members: { some: { userId, role: { in: ['owner', 'admin'] } } } },
      OR: [{ everyone: true }, { executor: { projectAccess: { some: {} } } }] } },
  ],
})
