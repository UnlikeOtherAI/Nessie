import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import type { AuthorizedActionContext, ExecutorSharingChange, ExecutorSharingView } from '@nessie/schemas'
import {
  lockExecutorMutation, requireManagedExecutor, setPrivateAssignmentInTransaction,
  removePrivateAssignmentInTransaction, nextAuthorizationRevision,
} from './executor-access-mutations.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import { endExecutorConversationLeasesInTransaction, executorLeaseAuditActor, listLiveExecutorLeaseRefs } from './executor-conversation-lease.js'
import { closeExecutorCodingSessionsInTransaction } from './executor-coding-session-closes.js'

type Client = PrismaClient | Prisma.TransactionClient

const refused = () => new ExecutorError(EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED, 'This team access is unavailable.')

const requireSharingTeam = async (
  prisma: Client, actor: AuthorizedActionContext, executorId: string, teamId: string,
) => {
  await requireManagedExecutor(prisma, actor, executorId)
  const [team, executor] = await Promise.all([
    prisma.team.findFirst({ where: {
      id: teamId, systemManaged: false, project: { organizationId: actor.tenant.organizationId },
      members: { some: { userId: actor.actor.actorId } },
    }, select: { id: true, externalTeamId: true } }),
    prisma.executor.findUniqueOrThrow({ where: { id: executorId }, include: { teamAccess: true } }),
  ])
  if (!team || (executor.teamAccess && executor.teamAccess.teamId !== teamId)
    || (executor.pairingTeamId && executor.pairingTeamId !== teamId
      && executor.pairingTeamId !== team.externalTeamId)) {
    throw refused()
  }
  return executor
}

export const getExecutorSharing = async (
  prisma: Client, actor: AuthorizedActionContext, executorId: string, teamId: string,
): Promise<ExecutorSharingView> => {
  const executor = await requireSharingTeam(prisma, actor, executorId, teamId)
  const [people, projects, members, candidates] = await Promise.all([
    prisma.executorPrivateAssignment.findMany({ where: { executorId, principalKind: 'user' },
      include: { user: { select: { displayName: true } } }, orderBy: { createdAt: 'asc' } }),
    prisma.executorProjectAccess.findMany({ where: { executorId }, select: { projectId: true } }),
    prisma.teamMember.findMany({ where: { teamId, user: {
      organizationMembers: { some: { organizationId: actor.tenant.organizationId, deactivatedAt: null } },
    } }, include: { user: { select: { displayName: true } } } }),
    prisma.project.findMany({ where: { teamId, organizationId: actor.tenant.organizationId,
      OR: [{ visibility: 'public' }, { members: { some: { userId: actor.actor.actorId } } }],
    }, select: { id: true, name: true } }),
  ])
  return {
    executorId, teamId, ownerUserId: executor.pairingOwnerUserId, everyone: executor.teamAccess?.everyone ?? false,
    people: people.flatMap((entry) => entry.userId && entry.user ? [{
      userId: entry.userId, name: entry.user.displayName, role: entry.role,
    }] : []),
    projects: projects.map((entry) => ({
      projectId: entry.projectId, name: candidates.find((p) => p.id === entry.projectId)?.name ?? 'Private project',
    })),
    availablePeople: members.map((entry) => ({ userId: entry.userId, name: entry.user.displayName })),
    availableProjects: candidates.map((entry) => ({ projectId: entry.id, name: entry.name })),
  }
}

/** Sharing is an immediate human mutation. Its audit and revocation fences commit together. */
export const updateExecutorSharing = async (
  prisma: PrismaClient, actor: AuthorizedActionContext,
  input: { executorId: string; teamId: string; change: ExecutorSharingChange },
) => prisma.$transaction(async (tx) => {
  const { executorId, teamId, change } = input
  await lockExecutorMutation(tx, executorId)
  const executor = await requireSharingTeam(tx, actor, executorId, teamId)
  const leases = await listLiveExecutorLeaseRefs(tx, executorId)
  await tx.executorTeamAccess.upsert({ where: { executorId }, create: { executorId, teamId }, update: {} })
  if (change.kind === 'person') {
    if (change.userId === executor.pairingOwnerUserId && change.role !== 'admin') throw refused()
    if (change.role) {
      const member = await tx.teamMember.findFirst({ where: { teamId, userId: change.userId,
        user: { organizationMembers: { some: { organizationId: actor.tenant.organizationId, deactivatedAt: null } } },
      } })
      if (!member) throw refused()
      await setPrivateAssignmentInTransaction(tx, actor, {
        executorId, assignment: { principalKind: 'user', userId: change.userId, role: change.role },
      })
    } else {
      if (change.userId === executor.pairingOwnerUserId) throw refused()
      await removePrivateAssignmentInTransaction(tx, actor, {
        executorId, principal: { principalKind: 'user', userId: change.userId },
      })
    }
  } else {
    await tx.executorTeamAccess.upsert({ where: { executorId },
      create: { executorId, teamId, everyone: change.kind === 'team' && change.enabled },
      update: change.kind === 'team' ? { everyone: change.enabled } : {},
    })
    if (change.kind === 'project') {
      const project = await tx.project.findFirst({ where: { id: change.projectId, teamId,
        organizationId: actor.tenant.organizationId,
        ...(change.enabled ? { OR: [{ visibility: 'public' }, { members: { some: { userId: actor.actor.actorId } } }] } : {}),
      }, select: { id: true } })
      if (!project) throw refused()
      if (change.enabled) await tx.executorProjectAccess.upsert({
        where: { executorId_projectId: { executorId, projectId: project.id } },
        create: { executorId, projectId: project.id }, update: {},
      })
      else await tx.executorProjectAccess.deleteMany({ where: { executorId, projectId: project.id } })
    }
    await nextAuthorizationRevision(tx, executorId)
    if (!change.enabled) {
      await endExecutorConversationLeasesInTransaction(tx, {
        actor: executorLeaseAuditActor(actor), endedByUserId: actor.actor.actorId,
        reason: 'access_revoked', where: { executorId },
      })
      await closeExecutorCodingSessionsInTransaction(tx, {
        executorId, reason: 'access_revoked', requestedByUserId: actor.actor.actorId,
      })
    }
  }
  await writeAuditEntryInTransaction(tx, {
    action: 'executor.sharing.updated', actorId: actor.actor.actorId, actorType: 'user',
    organizationId: actor.tenant.organizationId, outcome: 'success',
    requestId: actor.actionContext.requestId, resourceType: 'executor', resourceId: executorId,
    metadata: { teamId, change } as Prisma.InputJsonValue,
  })
  const remaining = new Set((await listLiveExecutorLeaseRefs(tx, executorId)).map((entry) => entry.id))
  return leases.filter((entry) => !remaining.has(entry.id))
})
