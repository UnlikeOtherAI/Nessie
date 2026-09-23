import type { PrismaClient } from '@prisma/client'
import {
  EXECUTOR_CODING_SESSION_CLOSE_TTL_MS,
  ExecutorError,
  EXECUTOR_ERROR_CODES,
  executorCodingSessionOwnerAgentIds,
  executorCodingSessionOwnerKey,
  getExecutorForManagement,
  reportedExecutorCodingSessions,
} from '@nessie/executor-manage'
import { buildAgentEntitlementWhere } from '@nessie/team-admin'
import type { AuthorizedActionContext, ExecutorCodingSessionListResponse } from '@nessie/schemas'

/**
 * The coding sessions open on one machine, for the people who may manage it
 * (docs/executor-protocol/host-coding-sessions.md → "The executor page"):
 * each open session the machine's last local-MCP report lists, whether a
 * close request for it is still open, and the agent driving it. Anyone else
 * is "not found", exactly as the machine's other management reads are.
 *
 * The report names an owner only by its hashed key, which the control plane
 * derives again for the one person who can own a session — the pairing
 * owner — and each agent they bound the local-apps pair for there. Managing
 * the machine does not widen what else the reader may see: that agent is
 * named only when the ordinary agent entitlement would show it to them.
 */
export const listExecutorCodingSessions = async (
  prisma: PrismaClient,
  actor: AuthorizedActionContext,
  executorId: string,
  now = new Date(),
): Promise<ExecutorCodingSessionListResponse> => {
  const managed = await getExecutorForManagement(prisma, actor, executorId)
  if (!managed) throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
  const organizationId = actor.tenant.organizationId
  const userId = actor.actor.actorId
  const row = await prisma.executor.findUniqueOrThrow({
    where: { id: executorId },
    select: { localMcp: true, pairingOwnerUserId: true, scopeKind: true },
  })
  const canClose = row.pairingOwnerUserId === userId
  const sessions = reportedExecutorCodingSessions(row.localMcp).filter((session) => session.status !== 'closed')
  if (sessions.length === 0) return { canClose, sessions: [] }
  const [ownerAgentIds, open] = await Promise.all([
    row.scopeKind === 'private' ? executorCodingSessionOwnerAgentIds(prisma, executorId, row.pairingOwnerUserId) : [],
    // A request older than its day is settled by the next heartbeat whatever
    // the machine says, so it no longer reads as closing here either.
    prisma.executorCodingSessionCloseRequest.findMany({
      where: {
        createdAt: { gt: new Date(now.getTime() - EXECUTOR_CODING_SESSION_CLOSE_TTL_MS) },
        executorId,
        resolvedAt: null,
      },
      select: { ownerKey: true, sessionId: true },
    }),
  ])
  const ownerAgent = new Map(ownerAgentIds.map((agentId) => [
    executorCodingSessionOwnerKey(executorId, { actorUserId: row.pairingOwnerUserId, agentId }),
    agentId,
  ]))
  const named = ownerAgentIds.length === 0 ? [] : await prisma.agent.findMany({
    where: {
      AND: [
        { id: { in: ownerAgentIds }, deletedAt: null },
        buildAgentEntitlementWhere({
          includeSystemManaged: true,
          includeUnbound: managed.access.organizationRole === 'owner' || managed.access.organizationRole === 'admin',
          organizationId,
          userId,
        }),
      ],
    },
    select: { id: true, name: true },
  })
  const agentNames = new Map(named.map((agent) => [agent.id, agent.name]))
  return {
    canClose,
    sessions: sessions.map((session) => {
      const agentId = ownerAgent.get(session.ownerKey)
      return {
        ...session,
        closing: open.some((request) => (
          request.ownerKey === session.ownerKey
          && (request.sessionId === null || request.sessionId === session.sessionId)
        )),
        ownerAgentName: (agentId && agentNames.get(agentId)) || null,
      }
    }),
  }
}
