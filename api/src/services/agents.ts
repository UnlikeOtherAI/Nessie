import type { Agent, PrismaClient } from '@prisma/client'
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

const mapAgentRecord = (agent: Agent & { bindings: Array<{ channelId: string }> }): AgentRecord => ({
  id: parseAgentId(agent.id),
  name: agent.name,
  role: agent.role,
  status: agent.status,
  systemPrompt: agent.systemPrompt ?? undefined,
  parentAgentId: agent.parentAgentId ? parseAgentId(agent.parentAgentId) : undefined,
  createdAt: agent.createdAt.toISOString(),
  updatedAt: agent.updatedAt.toISOString(),
  channelIds: agent.bindings.map((binding) => parseChannelId(binding.channelId)),
})

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
  const lastActivityAt =
    latestToolCall?.startedAt ??
    latestMessage?.createdAt ??
    latestRun?.createdAt ??
    agent.updatedAt

  return {
    agentId: parseAgentId(agent.id),
    status: agent.status,
    since: agent.updatedAt.toISOString(),
    currentRunId: latestRun ? parseRunId(latestRun.id) : undefined,
    currentToolName: latestToolCall?.toolName ?? undefined,
    currentToolStartedAt: toTimestamp(latestToolCall?.startedAt),
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

export const listAgentsForOrganization = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<AgentRecord[]> => {
  const agents = await prisma.agent.findMany({
    where: {
      OR: [
        {
          bindings: {
            none: {},
          },
        },
        {
          bindings: {
            some: {
              channel: {
                organizationId,
              },
            },
          },
        },
      ],
    },
    include: {
      bindings: {
        orderBy: { createdAt: 'asc' },
        select: { channelId: true },
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
    role: string
    systemPrompt?: string
  },
): Promise<AgentRecord> => {
  const agent = await prisma.agent.create({
    data: {
      name: input.name,
      role: input.role,
      systemPrompt: input.systemPrompt,
    },
    include: {
      bindings: {
        select: { channelId: true },
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
    },
  })

  return agent ? mapAgentRecord(agent) : null
}
