import type { PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseOrganizationId,
  parseRunId,
  parseThreadId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { TemporaryContextSession } from '../contracts/tools.js'
import { parseOptional } from './contract-helpers.js'

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
    const run = await prisma.run.findFirst({
      where: {
        id: input.runId,
        thread: {
          channel: {
            organizationId: actorContext.tenant.organizationId,
          },
        },
      },
      select: { id: true },
    })
    if (!run) {
      throw new CapabilityError(CAPABILITY_ERROR_CODES.RUN_NOT_FOUND, 'Run not found')
    }
  }

  if (input.threadId) {
    const thread = await prisma.thread.findFirst({
      where: {
        id: input.threadId,
        channel: {
          organizationId: actorContext.tenant.organizationId,
        },
      },
      select: { id: true },
    })
    if (!thread) {
      throw new CapabilityError(CAPABILITY_ERROR_CODES.THREAD_NOT_FOUND, 'Thread not found')
    }
  }

  if (input.agentId) {
    const agent = await prisma.agent.findFirst({
      where: {
        id: input.agentId,
        OR: [
          { organizationId: actorContext.tenant.organizationId },
          {
            bindings: {
              some: {
                channel: {
                  organizationId: actorContext.tenant.organizationId,
                },
              },
            },
          },
        ],
      },
      select: { id: true },
    })
    if (!agent) {
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
