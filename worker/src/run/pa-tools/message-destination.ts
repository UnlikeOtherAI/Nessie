import type { ChannelSystemType, PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  parseOrganizationId,
} from '@nessie/schemas'
import { isDelegatedSystemDmChannelType } from '../delegated-identity.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import {
  buildVisibleChannelWhere,
  requireActingUserId,
  type ChannelAgent,
} from './access.js'
import { formatChannelScope } from './tool-output.js'

const ensureThreadForChannel = async (
  prisma: PrismaClient,
  channelId: string,
): Promise<string> => {
  const existingThread = await prisma.thread.findFirst({
    where: { channelId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })

  if (existingThread) {
    return existingThread.id
  }

  try {
    const thread = await prisma.thread.create({
      data: {
        channelId,
        title: 'General',
      },
      select: { id: true },
    })
    return thread.id
  } catch {
    const fallback = await prisma.thread.findFirst({
      where: { channelId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (!fallback) {
      throw new Error(`Failed to resolve a thread for channel ${channelId}`)
    }
    return fallback.id
  }
}

const resolveChannelAgents = async (
  prisma: PrismaClient,
  channelId: string,
  organizationId: string,
): Promise<ChannelAgent[]> => {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      agentBindings: {
        orderBy: { createdAt: 'asc' },
        include: {
          agent: {
            select: { id: true, name: true, role: true, systemPrompt: true },
          },
        },
      },
      organizationId: true,
    },
  })

  if (!channel || channel.organizationId !== organizationId) {
    throw new Error('Channel not found')
  }

  // Only members (bound agents) participate. An @mention of an agent that is not
  // a member of the channel does not dispatch it — the API surfaces such
  // mentions as pending invites so the mentioner can add the agent first.
  return channel.agentBindings.map((binding) => ({
    id: binding.agent.id,
    name: binding.agent.name,
    role: binding.agent.role,
    systemPrompt: binding.agent.systemPrompt,
  }))
}

const resolveDmChannel = async (
  prisma: PrismaClient,
  input: {
    currentUserId: string
    organizationId: string
    teamId: string
    targetUserId: string
  },
): Promise<{ channelId: string; channelLabel: string; channelScope: string }> => {
  if (input.currentUserId === input.targetUserId) {
    throw new Error('targetUserId must refer to another user.')
  }

  const memberCount = await prisma.organizationMember.count({
    where: {
      organizationId: input.organizationId,
      userId: { in: [input.currentUserId, input.targetUserId] },
    },
  })
  if (memberCount < 2) {
    throw new Error('Both users must belong to the organization.')
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { displayName: true },
  })
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    select: {
      projectId: true,
      project: { select: { organizationId: true } },
    },
  })
  if (!team || team.project.organizationId !== input.organizationId) {
    throw new Error('Unable to resolve a team context for DM creation.')
  }

  const dmKey = [
    input.organizationId,
    input.teamId,
    ...[input.currentUserId, input.targetUserId].sort(),
  ].join(':')

  try {
    const channel = await prisma.channel.upsert({
      where: { dmKey },
      create: {
        label: targetUser?.displayName ?? 'Direct Message',
        type: 'dm',
        organizationId: input.organizationId,
        projectId: team.projectId,
        teamId: input.teamId,
        visibility: 'private',
        dmKey,
        members: {
          create: [
            { userId: input.currentUserId },
            { userId: input.targetUserId },
          ],
        },
      },
      update: {},
      select: {
        id: true,
        label: true,
        team: {
          select: {
            name: true,
            project: { select: { name: true } },
          },
        },
      },
    })

    return {
      channelId: channel.id,
      channelLabel: channel.label,
      channelScope: formatChannelScope(channel),
    }
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error as { code?: string }).code === 'P2002'
    ) {
      const channel = await prisma.channel.findUniqueOrThrow({
        where: { dmKey },
        select: {
          id: true,
          label: true,
          team: {
            select: {
              name: true,
              project: { select: { name: true } },
            },
          },
        },
      })
      return {
        channelId: channel.id,
        channelLabel: channel.label,
        channelScope: formatChannelScope(channel),
      }
    }

    throw error
  }
}

export const resolveMessageDestination = async (
  context: BuiltinToolRuntimeContext,
  input: {
    channelId?: string
    content: string
    targetUserId?: string
    threadId?: string
  },
): Promise<{
  channelId: string
  channelLabel: string
  channelScope: string
  channelAgents: ChannelAgent[]
  channelType: 'dm' | 'standard'
  systemChannelType: ChannelSystemType | null
  threadId: string
  threadLabel: string | null
}> => {
  const userId = requireActingUserId(context)
  const organizationId = context.channel.organizationId
  const explicitDestinationCount = [
    input.threadId ? 1 : 0,
    input.channelId ? 1 : 0,
    input.targetUserId ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0)

  if (explicitDestinationCount > 1) {
    throw new Error('Provide only one of threadId, channelId, or targetUserId.')
  }

  if (input.targetUserId) {
    const teamId = context.actorContext.tenant.teamId
    if (!teamId) {
      throw new Error('Unable to resolve a team context for DM creation.')
    }

    const dm = await resolveDmChannel(context.prisma, {
      currentUserId: userId,
      organizationId,
      targetUserId: input.targetUserId,
      teamId,
    })
    const threadId = await ensureThreadForChannel(context.prisma, dm.channelId)
    const thread = await context.prisma.thread.findUnique({
      where: { id: threadId },
      select: { id: true, title: true },
    })

    return {
      channelAgents: await resolveChannelAgents(
        context.prisma,
        dm.channelId,
        organizationId,
      ),
      channelId: dm.channelId,
      channelLabel: dm.channelLabel,
      channelScope: dm.channelScope,
      channelType: 'dm',
      systemChannelType: null,
      threadId,
      threadLabel: thread?.title ?? null,
    }
  }

  if (input.channelId) {
    const channel = await context.prisma.channel.findFirst({
      where: {
        id: input.channelId,
        ...buildVisibleChannelWhere(organizationId, userId),
      },
      select: {
        id: true,
        label: true,
        type: true,
        systemChannelType: true,
        team: {
          select: {
            name: true,
            project: { select: { name: true } },
          },
        },
      },
    })

    if (!channel) {
      throw new Error('Channel not found or not visible.')
    }

    const threadId = await ensureThreadForChannel(context.prisma, channel.id)
    const thread = await context.prisma.thread.findUnique({
      where: { id: threadId },
      select: { id: true, title: true },
    })

    return {
      channelAgents: await resolveChannelAgents(
        context.prisma,
        channel.id,
        organizationId,
      ),
      channelId: channel.id,
      channelLabel: channel.label,
      channelScope: formatChannelScope(channel),
      channelType: channel.type,
      systemChannelType: channel.systemChannelType,
      threadId,
      threadLabel: thread?.title ?? null,
    }
  }

  if (input.threadId) {
    const thread = await context.prisma.thread.findFirst({
      where: {
        id: input.threadId,
        channel: buildVisibleChannelWhere(organizationId, userId),
      },
      select: {
        id: true,
        title: true,
        channel: {
          select: {
            id: true,
            label: true,
            type: true,
            systemChannelType: true,
            team: {
              select: {
                name: true,
                project: { select: { name: true } },
              },
            },
          },
        },
      },
    })

    if (!thread) {
      throw new Error('Thread not found or not visible.')
    }

    return {
      channelAgents: await resolveChannelAgents(
        context.prisma,
        thread.channel.id,
        organizationId,
      ),
      channelId: thread.channel.id,
      channelLabel: thread.channel.label,
      channelScope: formatChannelScope(thread.channel),
      channelType: thread.channel.type,
      systemChannelType: thread.channel.systemChannelType,
      threadId: thread.id,
      threadLabel: thread.title ?? null,
    }
  }

  const fallbackThreadId =
    context.actorContext.actionContext.threadId ?? context.run.threadId
  const thread = await context.prisma.thread.findFirst({
    where: {
      id: fallbackThreadId,
      channel: buildVisibleChannelWhere(organizationId, userId),
    },
    select: {
      id: true,
      title: true,
      channel: {
        select: {
          id: true,
          label: true,
          type: true,
          systemChannelType: true,
          team: {
            select: {
              name: true,
              project: { select: { name: true } },
            },
          },
        },
      },
    },
  })

  if (!thread) {
    throw new Error('Unable to resolve a destination thread.')
  }

  return {
    channelAgents: await resolveChannelAgents(
      context.prisma,
      thread.channel.id,
      organizationId,
    ),
    channelId: thread.channel.id,
    channelLabel: thread.channel.label,
    channelScope: formatChannelScope(thread.channel),
    channelType: thread.channel.type,
    systemChannelType: thread.channel.systemChannelType,
    threadId: thread.id,
    threadLabel: thread.title ?? null,
  }
}

export const buildRealtimeScopesForChannel = (input: {
  channelId: string
  organizationId: string
  systemChannelType: ChannelSystemType | null
}) =>
  // Any single-member delegated system DM — the PA's or a global agent's home —
  // publishes on its channel lane alone. Keying this on `personal_assistant`
  // alone would have put a global agent's home DM on the organisation lane the
  // moment a tool posted into one.
  isDelegatedSystemDmChannelType(input.systemChannelType)
    ? [{ kind: 'channel' as const, channelId: parseChannelId(input.channelId) }]
    : [
        {
          kind: 'organization' as const,
          organizationId: parseOrganizationId(input.organizationId),
        },
        { kind: 'channel' as const, channelId: parseChannelId(input.channelId) },
      ]
