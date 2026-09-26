import type { ExecutorHostSession, Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { EXISTING_CODING_SESSION_OWNER_KEY, ExecutorCodingSessionSummarySchema } from '@nessie/schemas'

import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

export type HostSessionId = { executorId: string; sessionId: string }
export const sessionNotFound = () => new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Session not found.')
type Client = PrismaClient | Prisma.TransactionClient

export const sessionSummary = (session: ExecutorHostSession) => ExecutorCodingSessionSummarySchema.omit({
  ownerKey: true,
}).parse({
  ...(session.ownerKey === EXISTING_CODING_SESSION_OWNER_KEY ? { origin: 'external' } : {}),
  sessionId: session.sessionId, title: session.title, agent: session.agent, root: session.root,
  status: session.status, updatedAt: session.reportedAt.toISOString(),
})

/** Sharing is a terminal-output grant, never an executor assignment or control grant. */
export const sessionAccessWhere = (actor: AuthorizedActionContext): Prisma.ExecutorHostSessionWhereInput => {
  if (actor.actor.actorType !== 'user') throw sessionNotFound()
  const userId = actor.actor.actorId
  return {
    executor: {
      organizationId: actor.tenant.organizationId, removedAt: null, scopeKind: 'private',
      status: { not: 'revoked' },
      organization: { members: { some: { userId, deactivatedAt: null } } },
    },
    OR: [
      { executor: { pairingOwnerUserId: userId, privateAssignments: {
        some: { principalKind: 'user', userId, role: 'admin' },
      } } },
      { ownerKey: { not: EXISTING_CODING_SESSION_OWNER_KEY }, shares: { some: { userId } } },
    ],
  }
}

export const requireHostSession = async (
  prisma: Client, actor: AuthorizedActionContext, input: HostSessionId, ownerOnly = false,
) => {
  const row = await prisma.executorHostSession.findFirst({
    where: { AND: [sessionAccessWhere(actor), input] },
    include: { executor: { select: { pairingOwnerUserId: true, status: true, label: true, lastSeenAt: true } } },
  })
  const canShare = row?.executor.pairingOwnerUserId === actor.actor.actorId
    && row.ownerKey !== EXISTING_CODING_SESSION_OWNER_KEY
  if (!row || (ownerOnly && !canShare)) throw sessionNotFound()
  return { row, canShare }
}

