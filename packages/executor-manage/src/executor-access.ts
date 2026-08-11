import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

export type ExecutorHumanAccess = {
  organizationRole: 'owner' | 'admin' | 'member' | 'viewer' | null
  privateAssignment: 'none' | 'use' | 'admin'
  projectRole: 'owner' | 'admin' | 'member' | 'viewer' | null
}

type ExecutorAccessRow = {
  id: string
  projectId: string | null
  scopeKind: 'private' | 'project' | 'organization'
}

export const requireHumanActor = (actorContext: AuthorizedActionContext): string | null =>
  actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null

export const isOrganizationManager = (
  role: ExecutorHumanAccess['organizationRole'],
): boolean => role === 'owner' || role === 'admin'

export const resolveExecutorHumanAccess = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
  userId: string,
  executor: ExecutorAccessRow,
): Promise<ExecutorHumanAccess> => {
  const [membership, privateAssignment, projectMembership] = await Promise.all([
    prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { deactivatedAt: true, role: true },
    }),
    executor.scopeKind === 'private'
      ? prisma.executorPrivateAssignment.findFirst({
          where: {
            executorId: executor.id,
            principalKind: 'user',
            userId,
          },
          select: { role: true },
        })
      : null,
    executor.scopeKind === 'project' && executor.projectId
      ? prisma.projectMember.findUnique({
          where: { projectId_userId: { projectId: executor.projectId, userId } },
          select: { role: true },
        })
      : null,
  ])
  return {
    organizationRole: membership && !membership.deactivatedAt ? membership.role : null,
    privateAssignment: privateAssignment?.role ?? 'none',
    projectRole: projectMembership?.role ?? null,
  }
}

export const canViewExecutor = (
  executor: ExecutorAccessRow,
  access: ExecutorHumanAccess,
): boolean => {
  if (!access.organizationRole) return false
  switch (executor.scopeKind) {
    case 'private':
      return access.privateAssignment !== 'none'
    case 'project':
      return isOrganizationManager(access.organizationRole) || access.projectRole !== null
    case 'organization':
      return true
  }
}

export const canManageExecutor = (
  executor: ExecutorAccessRow,
  access: ExecutorHumanAccess,
): boolean => {
  switch (executor.scopeKind) {
    case 'private':
      return access.privateAssignment === 'admin'
    case 'project':
      return isOrganizationManager(access.organizationRole)
        || access.projectRole === 'owner'
        || access.projectRole === 'admin'
    case 'organization':
      return isOrganizationManager(access.organizationRole)
  }
}
