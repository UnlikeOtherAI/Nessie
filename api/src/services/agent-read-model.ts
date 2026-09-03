import type { Prisma, PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  type AgentActivityResponse,
  type AgentChild,
  type AgentMessage,
  type AgentStatusResponse,
  type ToolCallEntry,
  type WsScope,
  type WsSnapshot,
} from '@nessie/schemas'

import {
  buildAccessibleChannelWhere,
  buildAccessibleThreadWhere,
  isSystemManagedAgent,
  type AgentVisibilityScope,
} from '@nessie/team-admin'

const buildAccessibleRunWhere = (
  visibility?: AgentVisibilityScope,
): Prisma.RunWhereInput =>
  visibility ? { thread: buildAccessibleThreadWhere(visibility) } : {}

const toTimestamp = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined

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
  options?: { includeSystemManaged?: boolean; visibility?: AgentVisibilityScope },
): Promise<AgentStatusResponse | null> => {
  const runVisibilityWhere = buildAccessibleRunWhere(options?.visibility)
  const taskVisibilityWhere = options?.visibility
    ? { run: runVisibilityWhere }
    : {}
  const messageVisibilityWhere = options?.visibility
    ? { thread: buildAccessibleThreadWhere(options.visibility) }
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

  const latestRun = agent.runs[0]
  const latestToolCall = latestRun?.toolCalls[0]
  const latestMessage = agent.messages[0]
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
    activeSubAgents: agent.childAgents
      .map((childAgent) => {
        const childTask = childAgent.tasks[0]
        if (!childTask) return null
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
  options?: { includeSystemManaged?: boolean; visibility?: AgentVisibilityScope },
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

  const currentRun = agent.runs.find(
    (run) => run.status === 'running' || run.status === 'pending',
  )

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
    recentToolCalls: agent.runs
      .flatMap((run) => run.toolCalls)
      .sort(
        (left, right) =>
          right.startedAt.getTime() - left.startedAt.getTime(),
      )
      .slice(0, 20)
      .map(mapToolCall),
    subAgents: agent.childAgents
      .map((childAgent) => {
        const childTask = childAgent.tasks[0]
        if (!childTask) return null
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
  options?: { includeSystemManaged?: boolean; visibility?: AgentVisibilityScope },
): Promise<AgentMessage[]> => {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      agentKind: true,
      systemManaged: true,
    },
  })

  if (!agent) return []
  if (!options?.includeSystemManaged && isSystemManagedAgent(agent)) return []

  const threadVisibilityWhere = options?.visibility
    ? buildAccessibleThreadWhere(options.visibility)
    : undefined
  const messages = await prisma.message.findMany({
    where: {
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
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  })

  return messages.map((message) => ({
    messageId: message.id,
    role: message.role,
    contentPreview: message.content.slice(0, 500),
    fullContent: message.content,
    threadId: parseThreadId(message.threadId),
    timestamp: message.createdAt.toISOString(),
  }))
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
  visibility: AgentVisibilityScope,
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
  options?: { includeSystemManaged?: boolean; visibility?: AgentVisibilityScope },
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

export const buildSnapshotForScopes = async (
  prisma: PrismaClient,
  scopes: WsScope[],
  options?: { visibility?: AgentVisibilityScope },
): Promise<WsSnapshot> => {
  if (scopes.length === 0) return { agents: [] }

  const agentIds = new Set<string>()
  const bindingOr: Prisma.AgentBindingWhereInput[] = []
  for (const scope of scopes) {
    if (scope.kind === 'agent') {
      agentIds.add(scope.agentId)
      continue
    }
    if (scope.kind === 'channel') {
      bindingOr.push({
        channelId: scope.channelId,
        ...(options?.visibility
          ? { channel: buildAccessibleChannelWhere(options.visibility) }
          : {}),
      })
      continue
    }
    if (scope.kind === 'user') {
      continue
    }
    bindingOr.push({
      channel: {
        ...(options?.visibility
          ? buildAccessibleChannelWhere(options.visibility)
          : { organizationId: scope.organizationId }),
      },
    })
  }

  if (bindingOr.length > 0) {
    const bindings = await prisma.agentBinding.findMany({
      where: { OR: bindingOr },
      select: { agentId: true },
    })
    bindings.forEach((binding) => agentIds.add(binding.agentId))
  }
  if (agentIds.size === 0) return { agents: [] }

  const runVisibilityWhere = buildAccessibleRunWhere(options?.visibility)
  const agents = await prisma.agent.findMany({
    where: {
      id: { in: Array.from(agentIds) },
      ...(options?.visibility
        ? { organizationId: options.visibility.organizationId }
        : {}),
    },
    include: {
      messages: {
        where: options?.visibility
          ? { thread: buildAccessibleThreadWhere(options.visibility) }
          : {},
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

  return {
    agents: agents
      .filter((agent) => !isSystemManagedAgent(agent))
      .map((agent) => {
        const latestRun = agent.runs[0]
        const latestToolCall = latestRun?.toolCalls[0]
        const isActiveRun =
          latestRun !== undefined
          && latestRun.status !== 'completed'
          && latestRun.status !== 'failed'
          && latestRun.status !== 'cancelled'

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
        }
      }),
  }
}
