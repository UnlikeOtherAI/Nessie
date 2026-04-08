import type { Prisma, PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
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
import type { AgentRecord } from '../contracts.js'

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

const mapAgentRecord = (agent: {
  bindings: Array<{ channelId: string }>
  createdAt: Date
  id: string
  messages?: Array<{ createdAt: Date }>
  name: string
  parentAgentId: string | null
  role: string
  runs?: Array<{
    createdAt: Date
    id: string
    status: 'cancelled' | 'completed' | 'failed' | 'pending' | 'running'
    toolCalls: Array<{ endedAt: Date | null; startedAt: Date; toolName: string }>
  }>
  status: 'error' | 'executing' | 'idle' | 'offline' | 'thinking' | 'waiting_approval'
  systemPrompt: string | null
  updatedAt: Date
}): AgentRecord => {
  const latestRun = agent.runs?.[0]
  const latestToolCall = latestRun?.toolCalls[0]
  const latestMessage = agent.messages?.[0]
  const isActiveRun =
    latestRun !== undefined &&
    latestRun.status !== 'completed' &&
    latestRun.status !== 'failed' &&
    latestRun.status !== 'cancelled'
  const lastActivityAt =
    latestToolCall?.startedAt ??
    latestMessage?.createdAt ??
    latestRun?.createdAt ??
    agent.updatedAt

  return {
    id: parseAgentId(agent.id),
    name: agent.name,
    role: agent.role,
    status: agent.status,
    currentRunId: isActiveRun ? parseRunId(latestRun.id) : undefined,
    currentToolName:
      isActiveRun && latestToolCall?.endedAt === null ? latestToolCall.toolName : undefined,
    currentToolStartedAt:
      isActiveRun && latestToolCall?.endedAt === null
        ? toTimestamp(latestToolCall.startedAt)
        : undefined,
    lastActivityAt: lastActivityAt.toISOString(),
    systemPrompt: agent.systemPrompt ?? undefined,
    parentAgentId: agent.parentAgentId ? parseAgentId(agent.parentAgentId) : undefined,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    channelIds: agent.bindings.map((binding) => parseChannelId(binding.channelId)),
  }
}

export const loadAgentStatus = async (
  prisma: PrismaClient,
  agentId: string,
): Promise<AgentStatusResponse | null> => {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      childAgents: {
        include: {
          tasks: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      },
      messages: {
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
          status: {
            in: ['pending', 'running'],
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  if (!agent) {
    return null
  }

  const latestRun = agent.runs[0]
  const latestToolCall = latestRun?.toolCalls[0]
  const latestMessage = agent.messages[0]
  const isActiveRun =
    latestRun !== undefined &&
    latestRun.status !== 'completed' &&
    latestRun.status !== 'failed' &&
    latestRun.status !== 'cancelled'
  const lastActivityAt =
    latestToolCall?.startedAt ??
    latestMessage?.createdAt ??
    latestRun?.createdAt ??
    agent.updatedAt

  return {
    agentId: parseAgentId(agent.id),
    status: agent.status,
    since: agent.updatedAt.toISOString(),
    currentRunId: isActiveRun ? parseRunId(latestRun.id) : undefined,
    currentToolName:
      isActiveRun && latestToolCall?.endedAt === null ? latestToolCall.toolName : undefined,
    currentToolStartedAt:
      isActiveRun && latestToolCall?.endedAt === null
        ? toTimestamp(latestToolCall.startedAt)
        : undefined,
    activeSubAgents: agent.childAgents
      .map((childAgent) => {
        const childTask = childAgent.tasks[0]
        if (!childTask) {
          return null
        }

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
): Promise<AgentActivityResponse | null> => {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      childAgents: {
        include: {
          tasks: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      },
      runs: {
        include: {
          toolCalls: {
            orderBy: { startedAt: 'desc' },
          },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  if (!agent) {
    return null
  }

  const currentRun = agent.runs.find((run) => run.status === 'running' || run.status === 'pending')

  return {
    agentId: parseAgentId(agent.id),
    status: agent.status,
    currentRun: currentRun
      ? {
          runId: parseRunId(currentRun.id),
          status: currentRun.status,
          startedAt: (currentRun.startedAt ?? currentRun.createdAt).toISOString(),
          toolCalls: currentRun.toolCalls.map(mapToolCall),
        }
      : undefined,
    recentToolCalls: agent.runs
      .flatMap((run) => run.toolCalls)
      .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
      .slice(0, 20)
      .map(mapToolCall),
    subAgents: agent.childAgents
      .map((childAgent) => {
        const childTask = childAgent.tasks[0]
        if (!childTask) {
          return null
        }

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
): Promise<AgentMessage[]> => {
  const messages = await prisma.message.findMany({
    where: {
      OR: [
        { agentId },
        {
          thread: {
            runs: {
              some: { agentId },
            },
          },
        },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
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

export const loadAgentChildren = async (
  prisma: PrismaClient,
  agentId: string,
): Promise<AgentChild[]> => {
  const agents = await prisma.agent.findMany({
    where: { parentAgentId: agentId },
    include: {
      tasks: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const cutoff = Date.now() - 60 * 60 * 1000
  const recentAgents = agents.filter((agent) => agent.createdAt.getTime() >= cutoff)
  const selectedAgents = recentAgents.length >= 10 ? recentAgents : agents.slice(0, 10)

  return selectedAgents
    .map((agent) => {
      const task = agent.tasks[0]
      if (!task) {
        return null
      }

      return {
        agentId: parseAgentId(agent.id),
        name: agent.name,
        status: agent.status,
        taskId: parseTaskId(task.id),
        purpose: task.purpose ?? undefined,
        parentAgentId: parseAgentId(agentId),
        spawnedAt: agent.createdAt.toISOString(),
      }
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .reverse()
}

export const loadRunToolCalls = async (
  prisma: PrismaClient,
  agentId: string,
  runId: string,
): Promise<ToolCallEntry[]> => {
  const toolCalls = await prisma.toolCall.findMany({
    where: { agentId, runId },
    orderBy: { startedAt: 'asc' },
  })

  return toolCalls.map(mapToolCall)
}

export const buildSnapshotForScopes = async (
  prisma: PrismaClient,
  scopes: WsScope[],
): Promise<WsSnapshot> => {
  if (scopes.length === 0) {
    return { agents: [] }
  }

  const agentIds = new Set<string>()

  for (const scope of scopes) {
    if (scope.kind === 'agent') {
      agentIds.add(scope.agentId)
      continue
    }

    if (scope.kind === 'channel') {
      const bindings = await prisma.agentBinding.findMany({
        where: { channelId: scope.channelId },
        select: { agentId: true },
      })
      bindings.forEach((binding) => agentIds.add(binding.agentId))
      continue
    }

    const bindings = await prisma.agentBinding.findMany({
      where: {
        channel: {
          organizationId: scope.organizationId,
        },
      },
      select: { agentId: true },
    })
    bindings.forEach((binding) => agentIds.add(binding.agentId))
  }

  const snapshots = await Promise.all(
    Array.from(agentIds).map(async (agentId) => loadAgentStatus(prisma, agentId)),
  )

  return {
    agents: snapshots
      .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null)
      .map((snapshot) => ({
        agentId: snapshot.agentId,
        status: snapshot.status,
        since: snapshot.since,
        currentRunId: snapshot.currentRunId,
        currentToolName: snapshot.currentToolName,
        currentToolStartedAt: snapshot.currentToolStartedAt,
      })),
  }
}

export const listAgentsForUser = async (
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  includeUnbound: boolean,
): Promise<AgentRecord[]> => {
  const visibilityFilters: Prisma.AgentWhereInput[] = [
    {
      bindings: {
        some: {
          channel: {
            organizationId,
            members: {
              some: { userId },
            },
          },
        },
      },
    },
  ]

  if (includeUnbound) {
    visibilityFilters.push({
      bindings: {
        none: {},
      },
    })
  }

  const agents = await prisma.agent.findMany({
    where: {
      OR: visibilityFilters,
    },
    include: {
      bindings: {
        orderBy: { createdAt: 'asc' },
        select: { channelId: true },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
        take: 1,
      },
      runs: {
        include: {
          toolCalls: {
            orderBy: { startedAt: 'desc' },
            select: {
              endedAt: true,
              startedAt: true,
              toolName: true,
            },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return agents.map(mapAgentRecord)
}

export const createAgentRecord = async (
  prisma: PrismaClient,
  input: {
    name: string
    parentAgentId?: string
    role: string
    systemPrompt?: string
  },
): Promise<AgentRecord> => {
  const agent = await prisma.agent.create({
    data: {
      name: input.name,
      parentAgentId: input.parentAgentId,
      role: input.role,
      systemPrompt: input.systemPrompt,
    },
    include: {
      bindings: {
        select: { channelId: true },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
        take: 1,
      },
      runs: {
        include: {
          toolCalls: {
            orderBy: { startedAt: 'desc' },
            select: {
              endedAt: true,
              startedAt: true,
              toolName: true,
            },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  return mapAgentRecord(agent)
}

export const unbindAgentFromChannel = async (
  prisma: PrismaClient,
  agentId: string,
  channelId: string,
): Promise<void> => {
  await prisma.agentBinding.deleteMany({
    where: { agentId, channelId },
  })
}

export const cloneAgentRecord = async (
  prisma: PrismaClient,
  sourceAgentId: string,
): Promise<AgentRecord | null> => {
  const source = await prisma.agent.findUnique({
    where: { id: sourceAgentId },
  })
  if (!source) {
    return null
  }

  const agent = await prisma.agent.create({
    data: {
      name: `${source.name} (copy)`,
      role: source.role,
      systemPrompt: source.systemPrompt,
    },
    include: {
      bindings: {
        select: { channelId: true },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
        take: 1,
      },
      runs: {
        include: {
          toolCalls: {
            orderBy: { startedAt: 'desc' },
            select: {
              endedAt: true,
              startedAt: true,
              toolName: true,
            },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  return mapAgentRecord(agent)
}

export const bindAgentToChannel = async (
  prisma: PrismaClient,
  agentId: string,
  channelId: string,
): Promise<AgentRecord | null> => {
  await prisma.agentBinding.upsert({
    where: {
      agentId_channelId: {
        agentId,
        channelId,
      },
    },
    update: {},
    create: {
      agentId,
      channelId,
    },
  })

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      bindings: {
        orderBy: { createdAt: 'asc' },
        select: { channelId: true },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
        take: 1,
      },
      runs: {
        include: {
          toolCalls: {
            orderBy: { startedAt: 'desc' },
            select: {
              endedAt: true,
              startedAt: true,
              toolName: true,
            },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  return agent ? mapAgentRecord(agent) : null
}
