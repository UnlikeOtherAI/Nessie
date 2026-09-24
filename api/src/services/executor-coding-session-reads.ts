import type { PrismaClient } from '@prisma/client'
import {
  EXECUTOR_CODING_SESSION_CLOSE_TTL_MS,
  ExecutorError,
  EXECUTOR_ERROR_CODES,
  executorCodingSessionOwnerAgentIds,
  executorCodingSessionOwnerKey,
  executorCodingSessionsAllowed,
  getExecutorForManagement,
  reportedExecutorCodingSessions,
} from '@nessie/executor-manage'
import { buildAgentEntitlementWhere } from '@nessie/team-admin'
import { isAdminActor, type AuthorizedActionContext, type ExecutorCodingSessionListResponse } from '@nessie/schemas'

import { loadTicketSessionOwners } from './executor-coding-session-tickets.js'

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
 * A ticket's own session, keyed by its ticket's context, is named through
 * the work record that started it (`executor-coding-session-tickets.ts`).
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
  // Every session acts as the person who paired a private machine, and a shared one runs none.
  const canClose = executorCodingSessionsAllowed(row, userId)
  const sessions = reportedExecutorCodingSessions(row.localMcp).filter((session) => session.status !== 'closed')
  if (sessions.length === 0) return { canClose, sessions: [] }
  const [ownerAgentIds, open, tickets] = await Promise.all([
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
    row.scopeKind === 'private'
      ? loadTicketSessionOwners(prisma, {
          executorId, isOrganizationAdmin: isAdminActor(actor), organizationId, sessions, viewerUserId: userId,
        })
      : new Map<string, never>(),
  ])
  const ownerAgent = new Map(ownerAgentIds.map((agentId) => [
    executorCodingSessionOwnerKey(executorId, { actorUserId: row.pairingOwnerUserId, agentId }),
    agentId,
  ]))
  const namedIds = [...new Set([...ownerAgentIds, ...[...tickets.values()].map((ticket) => ticket.agentId)])]
  const named = namedIds.length === 0 ? [] : await prisma.agent.findMany({
    where: {
      AND: [
        { id: { in: namedIds }, deletedAt: null },
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
      const ticket = tickets.get(session.sessionId)
      const agentId = ownerAgent.get(session.ownerKey) ?? ticket?.agentId
      return {
        ...session,
        closing: open.some((request) => (
          request.ownerKey === session.ownerKey
          && (request.sessionId === null || request.sessionId === session.sessionId)
        )),
        ownerAgentName: (agentId && agentNames.get(agentId)) || null,
        ...(ticket ? { ticketWork: ticket.ticketWork } : {}),
      }
    }),
  }
}
