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

const PERSONAL_ASSISTANT_AGENT_KIND = 'personal_assistant' as const
const PERSONAL_ASSISTANT_SURFACE_POLICY = 'dm_only' as const
const PERSONAL_ASSISTANT_DELEGATION_MODE = 'act_as_requesting_user' as const

export type AgentVisibilityScope = {
  includeAllOrgChannels?: boolean
  organizationId: string
  userId: string
}

export const buildAccessibleChannelWhere = (
  visibility: AgentVisibilityScope,
): Prisma.ChannelWhereInput => ({
  organizationId: visibility.organizationId,
  ...(visibility.includeAllOrgChannels
    ? {}
    : {
        OR: [
          { visibility: 'public' },
          { members: { some: { userId: visibility.userId } } },
        ],
      }),
})

export const buildAccessibleThreadWhere = (
  visibility: AgentVisibilityScope,
): Prisma.ThreadWhereInput => ({
  channel: buildAccessibleChannelWhere(visibility),
})

const buildAccessibleRunWhere = (
  visibility?: AgentVisibilityScope,
): Prisma.RunWhereInput =>
  visibility ? { thread: buildAccessibleThreadWhere(visibility) } : {}

const isSystemManagedAgent = (agent: {
  agentKind: string
  systemManaged: boolean
}): boolean =>
  agent.systemManaged || agent.agentKind === PERSONAL_ASSISTANT_AGENT_KIND

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
    status: 'cancelled' | 'completed' | 'failed' | 'pending' | 'running' | 'waiting_approval'
    toolCalls: Array<{ endedAt: Date | null; startedAt: Date; toolName: string }>
  }>
  provider: string | null
  model: string | null
  agentKind: 'personal_assistant' | 'shared'
  systemManaged: boolean
  surfacePolicy: 'dm_only' | 'shared'
  delegationMode: 'act_as_requesting_user' | 'none'
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
    agentKind: agent.agentKind,
    systemManaged: agent.systemManaged,
    surfacePolicy: agent.surfacePolicy,
    delegationMode: agent.delegationMode,
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
    provider: agent.provider ?? undefined,
    model: agent.model ?? undefined,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    channelIds: agent.bindings.map((binding) => parseChannelId(binding.channelId)),
  }
}

export const loadAgentStatus = async (
  prisma: PrismaClient,
  agentId: string,
  options?: { includeSystemManaged?: boolean; visibility?: AgentVisibilityScope },
): Promise<AgentStatusResponse | null> => {
  const runVisibilityWhere = buildAccessibleRunWhere(options?.visibility)
  const taskVisibilityWhere = options?.visibility ? { run: runVisibilityWhere } : {}
  const messageVisibilityWhere = options?.visibility
    ? { thread: buildAccessibleThreadWhere(options.visibility) }
    : {}

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      childAgents: {
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

  if (!agent) {
    return null
  }

  if (!options?.includeSystemManaged && isSystemManagedAgent(agent)) {
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
  options?: { includeSystemManaged?: boolean; visibility?: AgentVisibilityScope },
): Promise<AgentActivityResponse | null> => {
  const runVisibilityWhere = buildAccessibleRunWhere(options?.visibility)
  const taskVisibilityWhere = options?.visibility ? { run: runVisibilityWhere } : {}

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      childAgents: {
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

  if (!agent) {
    return null
  }

  if (!options?.includeSystemManaged && isSystemManagedAgent(agent)) {
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

  if (!agent) {
    return []
  }

  if (!options?.includeSystemManaged && isSystemManagedAgent(agent)) {
    return []
  }

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

export const loadAgentChildren = async (
  prisma: PrismaClient,
  agentId: string,
  options?: { includeSystemManaged?: boolean },
): Promise<AgentChild[]> => {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      agentKind: true,
      systemManaged: true,
    },
  })

  if (!agent) {
    return []
  }

  if (!options?.includeSystemManaged && isSystemManagedAgent(agent)) {
    return []
  }

  const agents = await prisma.agent.findMany({
    where: { parentAgentId: agentId },
    orderBy: { createdAt: 'asc' },
  })

  return agents.map((agent) => ({
    agentId: parseAgentId(agent.id),
    name: agent.name,
    status: agent.status,
    purpose: agent.role ?? undefined,
    parentAgentId: parseAgentId(agentId),
    createdAt: agent.createdAt.toISOString(),
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

  if (!agent) {
    return []
  }

  if (!options?.includeSystemManaged && isSystemManagedAgent(agent)) {
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

export const buildSnapshotForScopes = async (
  prisma: PrismaClient,
  scopes: WsScope[],
  options?: { visibility?: AgentVisibilityScope },
): Promise<WsSnapshot> => {
  if (scopes.length === 0) {
    return { agents: [] }
  }

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

    bindingOr.push({
      channel: {
        ...(options?.visibility
          ? buildAccessibleChannelWhere(options.visibility)
          : { organizationId: scope.organizationId }),
      },
    })
  }

  // Collapse all channel/org binding lookups into one query.
  if (bindingOr.length > 0) {
    const bindings = await prisma.agentBinding.findMany({
      where: { OR: bindingOr },
      select: { agentId: true },
    })
    bindings.forEach((binding) => agentIds.add(binding.agentId))
  }

  if (agentIds.size === 0) {
    return { agents: [] }
  }

  // Batch-load every agent's status data in a single query instead of one
  // loadAgentStatus call per agent.
  const runVisibilityWhere = buildAccessibleRunWhere(options?.visibility)
  const agents = await prisma.agent.findMany({
    where: { id: { in: Array.from(agentIds) } },
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
          latestRun !== undefined &&
          latestRun.status !== 'completed' &&
          latestRun.status !== 'failed' &&
          latestRun.status !== 'cancelled'

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

export const listAgentsForUser = async (
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  includeUnbound: boolean,
): Promise<AgentRecord[]> => {
  const visibleChannelWhere = buildAccessibleChannelWhere({
    includeAllOrgChannels: includeUnbound,
    organizationId,
    userId,
  })
  const visibilityFilters: Prisma.AgentWhereInput[] = [
    {
      bindings: {
        some: {
          channel: visibleChannelWhere,
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
      systemManaged: false,
      OR: visibilityFilters,
    },
    include: {
      bindings: {
        where: {
          channel: visibleChannelWhere,
        },
        orderBy: { createdAt: 'asc' },
        select: { channelId: true },
      },
      messages: {
        where: {
          thread: {
            channel: visibleChannelWhere,
          },
        },
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
        where: {
          thread: {
            channel: visibleChannelWhere,
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
    agentKind?: 'personal_assistant' | 'shared'
    model?: string
    name: string
    organizationId?: string
    parentAgentId?: string
    projectId?: string
    provider?: string
    role: string
    surfacePolicy?: 'dm_only' | 'shared'
    systemPrompt?: string
    systemManaged?: boolean
    delegationMode?: 'act_as_requesting_user' | 'none'
    teamId?: string
    toolPolicy?: Record<string, boolean>
  },
): Promise<AgentRecord> => {
  if (
    input.agentKind === PERSONAL_ASSISTANT_AGENT_KIND ||
    input.systemManaged === true ||
    input.surfacePolicy === PERSONAL_ASSISTANT_SURFACE_POLICY ||
    input.delegationMode === PERSONAL_ASSISTANT_DELEGATION_MODE
  ) {
    throw new Error('PERSONAL_ASSISTANT_CREATE_REQUIRES_BOOTSTRAP')
  }

  const agent = await prisma.agent.create({
    data: {
      agentKind: 'shared',
      delegationMode: 'none',
      model: input.model,
      name: input.name,
      organizationId: input.organizationId,
      parentAgentId: input.parentAgentId,
      projectId: input.projectId,
      provider: input.provider,
      role: input.role,
      surfacePolicy: 'shared',
      systemPrompt: input.systemPrompt,
      systemManaged: false,
      teamId: input.teamId,
      toolPolicy: input.toolPolicy ?? undefined,
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

export const updateAgentRecord = async (
  prisma: PrismaClient,
  agentId: string,
  input: {
    agentKind?: 'personal_assistant' | 'shared'
    model?: string
    name?: string
    provider?: string
    role?: string
    surfacePolicy?: 'dm_only' | 'shared'
    systemPrompt?: string
    systemManaged?: boolean
    delegationMode?: 'act_as_requesting_user' | 'none'
    toolPolicy?: Record<string, boolean>
  },
): Promise<AgentRecord | null> => {
  const existing = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!existing) {
    return null
  }

  if (
    input.agentKind === PERSONAL_ASSISTANT_AGENT_KIND ||
    input.systemManaged === true ||
    input.surfacePolicy === PERSONAL_ASSISTANT_SURFACE_POLICY ||
    input.delegationMode === PERSONAL_ASSISTANT_DELEGATION_MODE
  ) {
    throw new Error('PERSONAL_ASSISTANT_UPDATE_REQUIRES_BOOTSTRAP')
  }

  const agent = await prisma.agent.update({
    where: { id: agentId },
    data: {
      agentKind: existing.agentKind,
      delegationMode: existing.delegationMode,
      model: input.model ?? existing.model,
      name: existing.systemManaged ? existing.name : input.name ?? existing.name,
      provider: input.provider ?? existing.provider,
      role: input.role ?? existing.role,
      surfacePolicy: existing.surfacePolicy,
      systemPrompt: input.systemPrompt ?? existing.systemPrompt,
      systemManaged: existing.systemManaged,
      toolPolicy: input.toolPolicy ?? existing.toolPolicy ?? undefined,
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
  })

  return mapAgentRecord(agent)
}

export const unbindAgentFromChannel = async (
  prisma: PrismaClient,
  agentId: string,
  channelId: string,
): Promise<void> => {
  const binding = await prisma.agent.findFirst({
    where: {
      id: agentId,
      systemManaged: false,
      bindings: {
        some: {
          channelId,
          channel: {
            systemChannelType: null,
          },
        },
      },
    },
    select: { id: true },
  })

  if (!binding) {
    return
  }

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
    select: {
      agentKind: true,
      delegationMode: true,
      model: true,
      name: true,
      provider: true,
      role: true,
      surfacePolicy: true,
      systemManaged: true,
      systemPrompt: true,
      toolPolicy: true,
    },
  })
  if (!source) {
    return null
  }

  if (isSystemManagedAgent(source)) {
    return null
  }

  const agent = await prisma.agent.create({
    data: {
      agentKind: 'shared',
      delegationMode: 'none',
      model: source.model,
      name: `${source.name} (copy)`,
      provider: source.provider,
      role: source.role,
      surfacePolicy: 'shared',
      systemPrompt: source.systemPrompt,
      systemManaged: false,
      toolPolicy: source.toolPolicy ?? undefined,
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
  const [agent, channel] = await Promise.all([
    prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        agentKind: true,
        delegationMode: true,
        model: true,
        name: true,
        provider: true,
        role: true,
        surfacePolicy: true,
        systemManaged: true,
        systemPrompt: true,
        toolPolicy: true,
      },
    }),
    prisma.channel.findUnique({
      where: { id: channelId },
      select: { systemChannelType: true },
    }),
  ])

  if (!agent || !channel) {
    return null
  }

  if (isSystemManagedAgent(agent) || channel.systemChannelType === 'personal_assistant') {
    return null
  }

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

  const boundAgent = await prisma.agent.findUnique({
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

  return boundAgent ? mapAgentRecord(boundAgent) : null
}
