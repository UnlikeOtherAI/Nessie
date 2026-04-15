import { Prisma, type PrismaClient } from '@prisma/client'
import { parseAgentId, parseChannelId, parseThreadId } from '@nessie/schemas'
import { ensureDefaultThread } from './channels.js'

const PERSONAL_ASSISTANT_AGENT_KIND = 'personal_assistant' as const
const PERSONAL_ASSISTANT_CHANNEL_TYPE = 'personal_assistant' as const
const PERSONAL_ASSISTANT_DELEGATION_MODE = 'act_as_requesting_user' as const
const PERSONAL_ASSISTANT_SURFACE_POLICY = 'dm_only' as const

export const PERSONAL_ASSISTANT_NAME = 'Personal Assistant'

export type PersonalAssistantAgentConfig = {
  model?: string
  provider?: string
  role?: string
  systemPrompt?: string
  toolPolicy?: Record<string, boolean>
}

type PersonalAssistantAgentCurrentConfig = {
  model: string | null
  provider: string | null
  role: string
  systemPrompt: string | null
  toolPolicy: Prisma.JsonValue | null
}

export type PersonalAssistantBootstrapInput = {
  agentConfig?: PersonalAssistantAgentConfig
  organizationId: string
  teamId: string
  userId: string
}

export type PersonalAssistantBootstrapResult = {
  agentId: string
  channelId: string
  threadId: string
}

const createPersonalAssistantAgentData = (
  organizationId: string,
  config?: PersonalAssistantAgentConfig,
  current?: PersonalAssistantAgentCurrentConfig,
) => ({
  agentKind: PERSONAL_ASSISTANT_AGENT_KIND,
  delegationMode: PERSONAL_ASSISTANT_DELEGATION_MODE,
  model: config?.model ?? current?.model ?? null,
  name: PERSONAL_ASSISTANT_NAME,
  organizationId,
  provider: config?.provider ?? current?.provider ?? null,
  role: config?.role ?? current?.role ?? 'assistant',
  surfacePolicy: PERSONAL_ASSISTANT_SURFACE_POLICY,
  systemManaged: true,
  systemPrompt: config?.systemPrompt ?? current?.systemPrompt ?? null,
  toolPolicy: config?.toolPolicy ?? current?.toolPolicy ?? undefined,
})

export const ensurePersonalAssistantAgent = async (
  prisma: PrismaClient,
  organizationId: string,
  config?: PersonalAssistantAgentConfig,
): Promise<string> => {
  const existing = await prisma.agent.findFirst({
    where: {
      organizationId,
      agentKind: PERSONAL_ASSISTANT_AGENT_KIND,
      systemManaged: true,
    },
    select: {
      id: true,
      model: true,
      provider: true,
      role: true,
      systemPrompt: true,
      toolPolicy: true,
    },
  })

  if (existing) {
    const agent = await prisma.agent.update({
      where: { id: existing.id },
      data: createPersonalAssistantAgentData(organizationId, config, existing),
      select: { id: true },
    })
    return parseAgentId(agent.id)
  }

  try {
    const agent = await prisma.agent.create({
      data: createPersonalAssistantAgentData(organizationId, config),
      select: { id: true },
    })
    return parseAgentId(agent.id)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const fallback = await prisma.agent.findFirst({
        where: {
          organizationId,
          agentKind: PERSONAL_ASSISTANT_AGENT_KIND,
          systemManaged: true,
        },
        select: {
          id: true,
          model: true,
          provider: true,
          role: true,
          systemPrompt: true,
          toolPolicy: true,
        },
      })
      if (!fallback) {
        throw error
      }

      const agent = await prisma.agent.update({
        where: { id: fallback.id },
        data: createPersonalAssistantAgentData(organizationId, config, fallback),
        select: { id: true },
      })
      return parseAgentId(agent.id)
    }

    throw error
  }
}

export const ensurePersonalAssistantChannel = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    teamId: string
    userId: string
  },
): Promise<string> => {
  const dmKey = `pa:${input.organizationId}:${input.userId}`

  try {
    const channel = await prisma.channel.upsert({
      where: { dmKey },
      create: {
        label: PERSONAL_ASSISTANT_NAME,
        type: 'dm',
        organizationId: input.organizationId,
        teamId: input.teamId,
        visibility: 'private',
        dmKey,
        systemChannelType: PERSONAL_ASSISTANT_CHANNEL_TYPE,
        members: {
          create: {
            userId: input.userId,
          },
        },
      },
      update: {
        label: PERSONAL_ASSISTANT_NAME,
        type: 'dm',
        organizationId: input.organizationId,
        teamId: input.teamId,
        visibility: 'private',
        systemChannelType: PERSONAL_ASSISTANT_CHANNEL_TYPE,
      },
      select: { id: true },
    })

    await prisma.channelMember.upsert({
      where: {
        channelId_userId: {
          channelId: channel.id,
          userId: input.userId,
        },
      },
      create: {
        channelId: channel.id,
        userId: input.userId,
      },
      update: {},
    })

    await prisma.channelMember.deleteMany({
      where: {
        channelId: channel.id,
        userId: {
          not: input.userId,
        },
      },
    })

    return parseChannelId(channel.id)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const fallback = await prisma.channel.findUnique({
        where: { dmKey },
        select: { id: true },
      })
      if (!fallback) {
        throw error
      }

      await prisma.channel.update({
        where: { id: fallback.id },
        data: {
          label: PERSONAL_ASSISTANT_NAME,
          type: 'dm',
          organizationId: input.organizationId,
          teamId: input.teamId,
          visibility: 'private',
          systemChannelType: PERSONAL_ASSISTANT_CHANNEL_TYPE,
        },
      })

      await prisma.channelMember.upsert({
        where: {
          channelId_userId: {
            channelId: fallback.id,
            userId: input.userId,
          },
        },
        create: {
          channelId: fallback.id,
          userId: input.userId,
        },
        update: {},
      })

      await prisma.channelMember.deleteMany({
        where: {
          channelId: fallback.id,
          userId: {
            not: input.userId,
          },
        },
      })

      return parseChannelId(fallback.id)
    }

    throw error
  }
}

export const ensurePersonalAssistantBinding = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    channelId: string
  },
): Promise<void> => {
  await prisma.agentBinding.upsert({
    where: {
      agentId_channelId: {
        agentId: input.agentId,
        channelId: input.channelId,
      },
    },
    create: {
      agentId: input.agentId,
      channelId: input.channelId,
    },
    update: {},
  })
}

export const ensurePersonalAssistantBootstrap = async (
  prisma: PrismaClient,
  input: PersonalAssistantBootstrapInput,
): Promise<PersonalAssistantBootstrapResult> => {
  const agentId = await ensurePersonalAssistantAgent(prisma, input.organizationId, input.agentConfig)
  const channelId = await ensurePersonalAssistantChannel(prisma, {
    organizationId: input.organizationId,
    teamId: input.teamId,
    userId: input.userId,
  })
  const threadId = await ensureDefaultThread(prisma, channelId)
  await ensurePersonalAssistantBinding(prisma, { agentId, channelId })

  return {
    agentId,
    channelId,
    threadId: parseThreadId(threadId),
  }
}
