import type { Prisma, PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  type AgentActivityResponse,
  type AgentChild,
  type AgentMessagePage,
  type AgentStatusResponse,
  type ToolCallEntry,
} from '@nessie/schemas'

import {
  buildAccessibleChannelWhere,
  isSystemManagedAgent,
} from '@nessie/team-admin'

import {
  canReadAgentMessage,
  type DisclosureAgentVisibilityScope,
  filterReadableAgentRuns,
} from './agent-read-disclosure.js'
import {
  buildAccessibleRunWhere,
  buildDisclosureReadableThreadWhere,
  toTimestamp,
} from './agent-read-primitives.js'
import { canUserReadRunDerivedRecord } from './run-derived-read.js'

const mapToolCall = (toolCall: {
  durationMs: number | null
  endedAt: Date | null
  inputSummary: string
  outputPreview: string | null
  runId: string
  startedAt: Date
  success: boolean | null
  toolName: string
}): ToolCallEntry => ({
  toolName: toolCall.toolName,
  runId: parseRunId(toolCall.runId),
  startedAt: toolCall.startedAt.toISOString(),
  endedAt: toTimestamp(toolCall.endedAt),
  durationMs: toolCall.durationMs ?? undefined,
  success: toolCall.success ?? undefined,
  inputSummary: toolCall.inputSummary,
  outputPreview: toolCall.outputPreview?.slice(0, 200) ?? undefined,
})

export const loadAgentStatus = async (
  prisma: PrismaClient,
  agentId: string,
  options?: { includeSystemManaged?: boolean; visibility?: DisclosureAgentVisibilityScope },
): Promise<AgentStatusResponse | null> => {
  const runVisibilityWhere = buildAccessibleRunWhere(options?.visibility)
  const taskVisibilityWhere = options?.visibility
    ? { run: runVisibilityWhere }
    : {}
  const messageVisibilityWhere = options?.visibility
    ? { thread: buildDisclosureReadableThreadWhere(options.visibility) }
    : {}

  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      ...(options?.visibility
        ? { organizationId: options.visibility.organizationId }
        : {}),
    },
    include: {
      childAgents: {
        where: options?.visibility
          ? { organizationId: options.visibility.organizationId }
          : {},
        include: {
          tasks: {
            where: taskVisibilityWhere,
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      },
      messages: {
        include: {
          basisScopes: { select: { scopeId: true, scopeType: true } },
          disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
          thread: { select: { channelId: true } },
        },
        where: messageVisibilityWhere,
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      runs: {
        include: {
          toolCalls: {
            orderBy: { startedAt: 'desc' },
            take: 1,
          },
        },
        where: {
          ...runVisibilityWhere,
          status: {
            in: ['pending', 'running'],
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  if (!agent) return null
  if (!options?.includeSystemManaged && isSystemManagedAgent(agent)) return null

  const readableRuns = await filterReadableAgentRuns(prisma, agent.runs, options?.visibility)
  const latestRun = readableRuns[0]
  const latestToolCall = latestRun?.toolCalls[0]
  const readableMessages = (await Promise.all(agent.messages.map(async (message) => ({
    message,
    readable: await canReadAgentMessage(prisma, message, options?.visibility),
  })))).filter(({ readable }) => readable).map(({ message }) => message)
  const readableActiveSubAgents = await Promise.all(agent.childAgents.map(async (childAgent) => {
    const childTask = childAgent.tasks[0]
    if (!childTask || !options?.visibility || !(await canUserReadRunDerivedRecord(prisma, {
      organizationId: options.visibility.organizationId,
      runId: childTask.runId,
      uoaIdentity: options.visibility.uoaIdentity,
      userId: options.visibility.userId,
    }))) return null
    return { childAgent, childTask }
  }))
  const latestMessage = readableMessages[0]
  const isActiveRun =
    latestRun !== undefined
    && latestRun.status !== 'completed'
    && latestRun.status !== 'failed'
    && latestRun.status !== 'cancelled'
  const lastActivityAt =
    latestToolCall?.startedAt
    ?? latestMessage?.createdAt
    ?? latestRun?.createdAt
    ?? agent.updatedAt

  return {
    agentId: parseAgentId(agent.id),
    status: agent.status,
    since: agent.updatedAt.toISOString(),
    currentRunId: isActiveRun ? parseRunId(latestRun.id) : undefined,
    currentToolName:
      isActiveRun && latestToolCall?.endedAt === null
        ? latestToolCall.toolName
        : undefined,
    currentToolStartedAt:
      isActiveRun && latestToolCall?.endedAt === null
        ? toTimestamp(latestToolCall.startedAt)
        : undefined,
    activeSubAgents: readableActiveSubAgents
      .map((entry) => {
        if (!entry) return null
        const { childAgent, childTask } = entry
        return {
          agentId: parseAgentId(childAgent.id),
          status: childAgent.status,
          taskId: parseTaskId(childTask.id),
        }
      })
      .filter((value): value is NonNullable<typeof value> => value !== null),
    lastActivityAt: lastActivityAt.toISOString(),
  }
}

export const loadAgentActivity = async (
  prisma: PrismaClient,
  agentId: string,
  options?: { includeSystemManaged?: boolean; visibility?: DisclosureAgentVisibilityScope },
): Promise<AgentActivityResponse | null> => {
  const runVisibilityWhere = buildAccessibleRunWhere(options?.visibility)
  const taskVisibilityWhere = options?.visibility
    ? { run: runVisibilityWhere }
    : {}

  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      ...(options?.visibility
        ? { organizationId: options.visibility.organizationId }
        : {}),
    },
    include: {
      childAgents: {
        where: options?.visibility
          ? { organizationId: options.visibility.organizationId }
          : {},
        include: {
          tasks: {
            where: taskVisibilityWhere,
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        take: 20,
      },
      runs: {
        include: {
          toolCalls: {
            orderBy: { startedAt: 'desc' },
            take: 20,
          },
        },
        where: runVisibilityWhere,
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  })

  if (!agent) return null
  if (!options?.includeSystemManaged && isSystemManagedAgent(agent)) return null

  const readableRuns = await filterReadableAgentRuns(prisma, agent.runs, options?.visibility)
  const currentRun = readableRuns.find(
    (run) => run.status === 'running' || run.status === 'pending',
  )
  const readableChildTasks = await Promise.all(agent.childAgents.map(async (childAgent) => {
    const childTask = childAgent.tasks[0]
    if (!childTask || !options?.visibility || !(await canUserReadRunDerivedRecord(prisma, {
      organizationId: options.visibility.organizationId,
      runId: childTask.runId,
      uoaIdentity: options.visibility.uoaIdentity,
      userId: options.visibility.userId,
    }))) return null
    return { childAgent, childTask }
  }))

  return {
    agentId: parseAgentId(agent.id),
    status: agent.status,
    currentRun: currentRun
      ? {
          runId: parseRunId(currentRun.id),
          status: currentRun.status,
          startedAt: (
            currentRun.startedAt ?? currentRun.createdAt
          ).toISOString(),
          toolCalls: currentRun.toolCalls.map(mapToolCall),
        }
      : undefined,
    recentToolCalls: readableRuns
      .flatMap((run) => run.toolCalls)
      .sort(
        (left, right) =>
          right.startedAt.getTime() - left.startedAt.getTime(),
      )
      .slice(0, 20)
      .map(mapToolCall),
    subAgents: readableChildTasks
      .map((entry) => {
        if (!entry) return null
        const { childAgent, childTask } = entry
        return {
          agentId: parseAgentId(childAgent.id),
          name: childAgent.name,
          status: childAgent.status,
          taskId: parseTaskId(childTask.id),
          purpose: childTask.purpose ?? undefined,
        }
      })
      .filter((value): value is NonNullable<typeof value> => value !== null),
  }
}

export const loadAgentMessages = async (
  prisma: PrismaClient,
  agentId: string,
  limit: number,
  offset = 0,
  options?: { includeSystemManaged?: boolean; visibility?: DisclosureAgentVisibilityScope },
): Promise<AgentMessagePage> => {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      agentKind: true,
      systemManaged: true,
    },
  })

  if (!agent) return { items: [], total: 0 }
  if (!options?.includeSystemManaged && isSystemManagedAgent(agent)) return { items: [], total: 0 }

  const threadVisibilityWhere = options?.visibility
    ? buildDisclosureReadableThreadWhere(options.visibility)
    : undefined
  const where: Prisma.MessageWhereInput = {
    OR: [
      {
        agentId,
        ...(threadVisibilityWhere ? { thread: threadVisibilityWhere } : {}),
      },
      {
        thread: {
          ...(threadVisibilityWhere ?? {}),
          runs: {
            some: { agentId },
          },
        },
      },
    ],
  }
  // Unlike an ordinary channel predicate, a message basis may be admitted by a
  // live grant. Fetch the lightweight projection first, ask the one canonical
  // predicate for each restricted row, then page the resulting safe set. This
  // keeps both the content and the total from revealing a withheld reply.
  const candidates = await prisma.message.findMany({
    where,
    include: {
      basisScopes: { select: { scopeId: true, scopeType: true } },
      disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
      thread: { select: { channelId: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  const readable = (await Promise.all(candidates.map(async (message) => ({
    message,
    readable: await canReadAgentMessage(prisma, message, options?.visibility),
  })))).filter(({ readable }) => readable).map(({ message }) => message)
  const messages = readable.slice(offset, offset + limit)

  return {
    items: messages.map((message) => ({
      messageId: message.id,
      role: message.role,
      contentPreview: message.content.slice(0, 500),
      fullContent: message.content,
      threadId: parseThreadId(message.threadId),
      timestamp: message.createdAt.toISOString(),
    })),
    total: readable.length,
  }
}

/**
 * The children of an agent, scoped to what the viewer may actually see.
 *
 * The route gates only on the *parent* being accessible, so before this took a
 * visibility scope it returned every child in the organization — name, status
 * and purpose — to anyone who could reach the parent. Reaching a parent through
 * stewardship therefore would have re-opened exactly the subtask-child
 * enumeration that `buildVisibleAgentWhere`'s stewardship arm excludes with
 * `parentAgentId: null` exists to
 * prevent. Having decided that inherited ownership is not sufficient for child
 * visibility in the list, it cannot be sufficient here either.
 *
 * A child is listed when the viewer can see it working in a channel they can
 * reach, or when they steward the child itself. Owner callers
 * (`includeAllOrgChannels`) still see everything, as they do everywhere else.
 */
export const loadAgentChildren = async (
  prisma: PrismaClient,
  agentId: string,
  visibility: DisclosureAgentVisibilityScope,
  options?: { includeSystemManaged?: boolean },
): Promise<AgentChild[]> => {
  const organizationId = visibility.organizationId
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, organizationId },
    select: {
      agentKind: true,
      systemManaged: true,
    },
  })

  if (!agent) return []
  if (!options?.includeSystemManaged && isSystemManagedAgent(agent)) return []

  const agents = await prisma.agent.findMany({
    where: {
      organizationId,
      parentAgentId: agentId,
      ...(visibility.includeAllOrgChannels
        ? {}
        : {
            OR: [
              { bindings: { some: { channel: buildAccessibleChannelWhere(visibility) } } },
              { ownerMembership: { deactivatedAt: null }, ownerUserId: visibility.userId },
            ],
          }),
    },
    orderBy: { createdAt: 'asc' },
  })

  return agents.map((child) => ({
    agentId: parseAgentId(child.id),
    name: child.name,
    status: child.status,
    purpose: child.role ?? undefined,
    parentAgentId: parseAgentId(agentId),
    createdAt: child.createdAt.toISOString(),
  }))
}

export const loadRunToolCalls = async (
  prisma: PrismaClient,
  agentId: string,
  runId: string,
  options?: { includeSystemManaged?: boolean; visibility?: DisclosureAgentVisibilityScope },
): Promise<ToolCallEntry[]> => {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      agentKind: true,
      systemManaged: true,
    },
  })

  if (!agent) return []
  if (!options?.includeSystemManaged && isSystemManagedAgent(agent)) return []

  if (!(await filterReadableAgentRuns(prisma, [{ id: runId }], options?.visibility)).length) {
    return []
  }

  const toolCalls = await prisma.toolCall.findMany({
    where: {
      agentId,
      runId,
      ...(options?.visibility
        ? { run: buildAccessibleRunWhere(options.visibility) }
        : {}),
    },
    orderBy: { startedAt: 'asc' },
  })

  return toolCalls.map(mapToolCall)
}
