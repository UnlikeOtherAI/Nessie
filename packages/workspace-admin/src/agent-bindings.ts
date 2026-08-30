import type { PrismaClient } from '@prisma/client'

import type { AgentRecord } from '@nessie/schemas'
import {
  isSystemManagedAgent,
  mapAgentRecord,
} from './agent-record.js'

type AgentChannelBindingInput = {
  agentId: string
  channelId: string
  organizationId: string
  userId?: string
}

export const AGENT_BINDING_ERROR_CODES = {
  PRIVATE_VISIBILITY: 'AGENT_VISIBILITY_PRIVATE',
} as const

export class AgentBindingError extends Error {
  override readonly name = 'AgentBindingError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export const bindAgentToChannel = async (
  prisma: PrismaClient,
  input: AgentChannelBindingInput,
): Promise<AgentRecord | null> => {
  const [agent, channel] = await Promise.all([
    prisma.agent.findFirst({
      where: {
        id: input.agentId,
        organizationId: input.organizationId,
      },
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
        visibility: true,
        ownerUserId: true,
      },
    }),
    prisma.channel.findFirst({
      where: {
        id: input.channelId,
        organizationId: input.organizationId,
      },
      select: { systemChannelType: true },
    }),
  ])

  if (!agent || !channel) {
    return null
  }

  if (agent.visibility === 'private') {
    // Only the private agent's owner gets the actionable refusal. Everybody
    // else receives the same null/not-found result as an unknown id, so this
    // chokepoint cannot become an existence oracle for private agents.
    if (input.userId && agent.ownerUserId === input.userId) {
      throw new AgentBindingError(
        AGENT_BINDING_ERROR_CODES.PRIVATE_VISIBILITY,
        'Private agents cannot be added to channels.',
      )
    }
    return null
  }

  if (
    isSystemManagedAgent(agent)
    || channel.systemChannelType === 'personal_assistant'
  ) return null

  await prisma.agentBinding.upsert({
    where: {
      agentId_channelId: {
        agentId: input.agentId,
        channelId: input.channelId,
      },
    },
    update: {},
    create: {
      agentId: input.agentId,
      channelId: input.channelId,
    },
  })

  const boundAgent = await prisma.agent.findFirst({
    where: {
      id: input.agentId,
      organizationId: input.organizationId,
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

  return boundAgent ? mapAgentRecord(boundAgent) : null
}

export const unbindAgentFromChannel = async (
  prisma: PrismaClient,
  input: AgentChannelBindingInput,
): Promise<void> => {
  const binding = await prisma.agent.findFirst({
    where: {
      id: input.agentId,
      organizationId: input.organizationId,
      systemManaged: false,
      bindings: {
        some: {
          channelId: input.channelId,
          channel: {
            organizationId: input.organizationId,
            systemChannelType: null,
          },
        },
      },
    },
    select: { id: true },
  })

  if (!binding) return
  await prisma.agentBinding.deleteMany({
    where: {
      agentId: input.agentId,
      channelId: input.channelId,
    },
  })
}
