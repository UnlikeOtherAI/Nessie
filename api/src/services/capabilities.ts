import type { PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseOrganizationId,
  parseRunId,
  parseThreadId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { TemporaryContextSession } from '../contracts.js'
import { parseOptional } from './contract-helpers.js'

const mapTemporaryContextSession = (session: {
  agentId: string | null
  createdAt: Date
  createdByActorId: string
  createdByActorType: string
  droppedAt: Date | null
  id: string
  organizationId: string
  runId: string | null
  threadId: string | null
  title: string | null
  toolIds: unknown
  updatedAt: Date
}): TemporaryContextSession => ({
  id: session.id,
  organizationId: parseOrganizationId(session.organizationId),
  agentId: parseOptional(session.agentId, parseAgentId),
  runId: parseOptional(session.runId, parseRunId),
  threadId: parseOptional(session.threadId, parseThreadId),
  title: session.title ?? undefined,
  toolIds: Array.isArray(session.toolIds)
    ? session.toolIds.filter((value): value is string => typeof value === 'string')
    : [],
  createdByActorType: session.createdByActorType,
  createdByActorId: session.createdByActorId,
  droppedAt: session.droppedAt?.toISOString(),
  createdAt: session.createdAt.toISOString(),
  updatedAt: session.updatedAt.toISOString(),
})

export const createTemporaryContextSession = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    agentId?: string
    runId?: string
    threadId?: string
    title?: string
    toolIds: string[]
  },
): Promise<TemporaryContextSession> => {
  const session = await prisma.temporaryContextSession.create({
    data: {
      organizationId: actorContext.tenant.organizationId,
      agentId: input.agentId,
      runId: input.runId,
      threadId: input.threadId,
      title: input.title,
      toolIds: input.toolIds,
      createdByActorType: actorContext.actor.actorType,
      createdByActorId: actorContext.actor.actorId,
    },
  })

  return mapTemporaryContextSession(session)
}

export const listTemporaryContextSessions = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    agentId?: string
    includeDropped?: boolean
    runId?: string
    threadId?: string
  },
): Promise<TemporaryContextSession[]> => {
  const sessions = await prisma.temporaryContextSession.findMany({
    where: {
      organizationId,
      ...(input.includeDropped ? {} : { droppedAt: null }),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
  })

  return sessions.map(mapTemporaryContextSession)
}

export const dropTemporaryContextSession = async (
  prisma: PrismaClient,
  organizationId: string,
  sessionId: string,
): Promise<TemporaryContextSession | null> => {
  const session = await prisma.temporaryContextSession.findFirst({
    where: {
      id: sessionId,
      organizationId,
    },
  })
  if (!session) {
    return null
  }

  const dropped = await prisma.temporaryContextSession.update({
    where: { id: sessionId },
    data: {
      droppedAt: new Date(),
    },
  })

  return mapTemporaryContextSession(dropped)
}
