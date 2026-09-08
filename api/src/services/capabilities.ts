import type { Prisma, PrismaClient } from '@prisma/client'
import { buildAgentVisibilityWhere, buildVisibleAgentWhere } from '@nessie/db'
import { buildAccessibleChannelWhere, isAgentAccessibleToActor } from '@nessie/team-admin'
import {
  parseAgentId,
  parseOrganizationId,
  parseRunId,
  parseThreadId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { TemporaryContextSession } from '../contracts/tools.js'
import { parseOptional } from './contract-helpers.js'
import { loadRunForActor } from './run-access.js'

export const CAPABILITY_ERROR_CODES = {
  SCOPE_REQUIRED: 'TEMP_CONTEXT_SCOPE_REQUIRED',
  SCOPE_AMBIGUOUS: 'TEMP_CONTEXT_SCOPE_AMBIGUOUS',
  RUN_NOT_FOUND: 'TEMP_CONTEXT_RUN_NOT_FOUND',
  THREAD_NOT_FOUND: 'TEMP_CONTEXT_THREAD_NOT_FOUND',
  AGENT_NOT_FOUND: 'TEMP_CONTEXT_AGENT_NOT_FOUND',
} as const

export class CapabilityError extends Error {
  override readonly name = 'CapabilityError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

const ensureSingleCapabilityScope = (input: {
  agentId?: string
  runId?: string
  threadId?: string
}): void => {
  const providedScopeCount = [input.agentId, input.runId, input.threadId].filter(
    (value) => typeof value === 'string' && value.length > 0,
  ).length

  if (providedScopeCount === 0) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.SCOPE_REQUIRED,
      'A temporary context session must target exactly one of agentId, runId, or threadId',
    )
  }
  if (providedScopeCount > 1) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.SCOPE_AMBIGUOUS,
      'A temporary context session may target only one of agentId, runId, or threadId',
    )
  }
}

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

const visibleAgentWhereForActor = (
  actorContext: AuthorizedActionContext,
): Prisma.AgentWhereInput => actorContext.actor.roles?.includes('owner')
  ? {
      AND: [buildAgentVisibilityWhere({
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      })],
      systemManaged: false,
    }
  : buildVisibleAgentWhere({
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })

/**
 * Temporary sessions carry scalar scope IDs so they deliberately cannot become
 * an alternate authority store. Resolve every referenced scope through the
 * same predicates that its owning surface uses, in three bounded queries.
 */
const visibleSessionIds = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  sessions: Array<{
    id: string
    agentId: string | null
    runId: string | null
    threadId: string | null
  }>,
): Promise<Set<string>> => {
  const agentIds = sessions.flatMap((session) => session.agentId ? [session.agentId] : [])
  const runIds = sessions.flatMap((session) => session.runId ? [session.runId] : [])
  const threadIds = sessions.flatMap((session) => session.threadId ? [session.threadId] : [])
  const visibility = {
    organizationId: actorContext.tenant.organizationId,
    userId: actorContext.actor.actorId,
  }
  const [agents, runs, threads] = await Promise.all([
    agentIds.length
      ? prisma.agent.findMany({
          where: {
            id: { in: agentIds },
            organizationId: actorContext.tenant.organizationId,
            AND: [visibleAgentWhereForActor(actorContext)],
          },
          select: { id: true },
        })
      : [],
    runIds.length
      ? prisma.run.findMany({
          where: {
            id: { in: runIds },
            agent: buildAgentVisibilityWhere(visibility),
            thread: { channel: buildAccessibleChannelWhere(visibility) },
          },
          select: { id: true },
        })
      : [],
    threadIds.length
      ? prisma.thread.findMany({
          where: {
            id: { in: threadIds },
            channel: buildAccessibleChannelWhere(visibility),
          },
          select: { id: true },
        })
      : [],
  ])
  const visibleAgents = new Set(agents.map((agent) => agent.id))
  const visibleRuns = new Set(runs.map((run) => run.id))
  const visibleThreads = new Set(threads.map((thread) => thread.id))
  return new Set(sessions.flatMap((session) => (
    session.agentId && visibleAgents.has(session.agentId)
    || session.runId && visibleRuns.has(session.runId)
    || session.threadId && visibleThreads.has(session.threadId)
      ? [session.id]
      : []
  )))
}

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
  ensureSingleCapabilityScope(input)

  if (input.runId) {
    const run = await loadRunForActor(prisma, input.runId, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!run) {
      throw new CapabilityError(CAPABILITY_ERROR_CODES.RUN_NOT_FOUND, 'Run not found')
    }
  }

  if (input.threadId) {
    const thread = await prisma.thread.findFirst({
      where: {
        id: input.threadId,
        channel: buildAccessibleChannelWhere({
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        }),
      },
      select: { id: true },
    })
    if (!thread) {
      throw new CapabilityError(CAPABILITY_ERROR_CODES.THREAD_NOT_FOUND, 'Thread not found')
    }
  }

  if (input.agentId) {
    if (!(await isAgentAccessibleToActor(prisma, actorContext, input.agentId))) {
      throw new CapabilityError(CAPABILITY_ERROR_CODES.AGENT_NOT_FOUND, 'Agent not found')
    }
  }

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
  actorContext: AuthorizedActionContext,
  input: {
    agentId?: string
    includeDropped?: boolean
    runId?: string
    threadId?: string
  },
): Promise<TemporaryContextSession[]> => {
  const sessions = await prisma.temporaryContextSession.findMany({
    where: {
      organizationId: actorContext.tenant.organizationId,
      ...(input.includeDropped ? {} : { droppedAt: null }),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
  })

  const visibleIds = await visibleSessionIds(prisma, actorContext, sessions)
  return sessions.filter((session) => visibleIds.has(session.id)).map(mapTemporaryContextSession)
}

export const dropTemporaryContextSession = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  sessionId: string,
): Promise<TemporaryContextSession | null> => {
  const session = await prisma.temporaryContextSession.findFirst({
    where: {
      id: sessionId,
      organizationId: actorContext.tenant.organizationId,
    },
  })
  if (!session) {
    return null
  }

  if (!(await visibleSessionIds(prisma, actorContext, [session])).has(session.id)) {
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
