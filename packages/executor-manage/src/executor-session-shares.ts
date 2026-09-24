import type { PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { requireHostSession, sessionAccessWhere, sessionNotFound, sessionSummary, type HostSessionId } from './executor-session-access.js'

export const listExecutorHostSessions = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, executorId?: string,
) => {
  const rows = await prisma.executorHostSession.findMany({
    where: { AND: [sessionAccessWhere(actor), ...(executorId ? [{ executorId }] : [])] },
    orderBy: { reportedAt: 'desc' }, take: 200,
    include: { executor: { select: { label: true, pairingOwnerUserId: true } } },
  })
  return rows.map((row) => ({
    ...sessionSummary(row), executorId: row.executorId, executorLabel: row.executor.label,
    shared: row.executor.pairingOwnerUserId !== actor.actor.actorId,
  }))
}

export const listExecutorSessionShares = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, input: HostSessionId,
) => {
  await requireHostSession(prisma, actor, input, true)
  return (await prisma.executorHostSessionShare.findMany({
    where: input, include: { user: { select: { id: true, displayName: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  })).map(({ user }) => ({ userId: user.id, displayName: user.displayName, email: user.email }))
}

/** The pairing owner's explicit grant; recipients must be active people in the same organisation. */
export const changeExecutorSessionShare = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, input: HostSessionId,
  change: { email: string } | { removeUserId: string },
) => prisma.$transaction(async (tx) => {
  await requireHostSession(tx, actor, input, true)
  let userId: string
  if ('email' in change) {
    const member = await tx.organizationMember.findFirst({
      where: {
        organizationId: actor.tenant.organizationId, deactivatedAt: null,
        user: { email: { equals: change.email.trim(), mode: 'insensitive' } },
      },
      select: { userId: true },
    })
    if (!member) throw sessionNotFound()
    userId = member.userId
    if (userId === actor.actor.actorId) return
    await tx.executorHostSessionShare.upsert({
      where: { executorId_sessionId_userId: { ...input, userId } },
      create: { ...input, userId }, update: {},
    })
  } else {
    userId = change.removeUserId
    await tx.executorHostSessionShare.deleteMany({ where: { ...input, userId } })
  }
  await writeAuditEntryInTransaction(tx, {
    action: 'email' in change ? 'executor.session.shared' : 'executor.session.share_revoked',
    actorId: actor.actor.actorId, actorType: 'user', organizationId: actor.tenant.organizationId,
    metadata: { executorId: input.executorId, userId }, outcome: 'success',
    requestId: actor.actionContext.requestId, resourceId: input.sessionId, resourceType: 'executor_host_session',
  })
})
