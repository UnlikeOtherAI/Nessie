import type { PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  parseThreadId,
  parseUserId,
} from '@nessie/schemas'
import type { ChannelRecord, PersonalAssistantPresenceParticipant } from '../contracts.js'
import {
  canManageChannel,
  channelTeamInclude,
  ChannelSlugConflictError,
  ChannelValidationError,
  createChannelForUser,
  ensureDefaultThread,
  loadLastMessageAtByThread,
  loadUnreadCountsByThread,
  mapChannelRecord,
  resolveDmUserId,
  setChannelArchived,
  updateChannel,
} from '@nessie/team-admin'

// Channel creation, the manage check, and the writes it gates are shared with
// the worker (the assistant's `channel_create` / `channel_update` /
// `channel_archive` tools); the routes keep importing them from here.
export {
  canManageChannel,
  ChannelSlugConflictError,
  ChannelValidationError,
  createChannelForUser,
  setChannelArchived,
  updateChannel,
}

export const listChannelsForUser = async (
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  teamId?: string,
  includeArchived = false,
): Promise<ChannelRecord[]> => {
  const where: Record<string, unknown> = {
    organizationId,
    OR: [
      { visibility: 'public' },
      { members: { some: { userId } } },
    ],
  }
  if (teamId) {
    where['teamId'] = teamId
  }
  if (!includeArchived) {
    where['archivedAt'] = null
  }

  const channels = await prisma.channel.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    include: {
      threads: {
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { id: true },
      },
      members: {
        where: { userId },
        select: { role: true, muted: true },
        take: 1,
      },
      // A PA presence is a binding-level participant, not an agent the caller
      // can inspect. Keep the read to its explicit display projection inputs.
      agentBindings: {
        where: {
          principalUserId: { not: null },
          agent: { agentKind: 'personal_assistant' },
        },
        select: {
          agentId: true,
          id: true,
          principalUserId: true,
          agent: { select: { avatarAttachmentId: true } },
        },
      },
      team: {
        select: {
          name: true,
          project: {
            select: { channelRoot: true, id: true, name: true },
          },
        },
      },
    },
  })

  const needsThread = channels.filter((channel) => channel.threads.length === 0)
  if (needsThread.length > 0) {
    await prisma.thread.createMany({
      data: needsThread.map((channel) => ({ channelId: channel.id, title: 'General' })),
      skipDuplicates: true,
    })

    const createdThreads = await prisma.thread.findMany({
      where: { channelId: { in: needsThread.map((channel) => channel.id) } },
      orderBy: { createdAt: 'asc' },
      distinct: ['channelId'],
      select: { id: true, channelId: true },
    })
    const threadMap = new Map(createdThreads.map((thread) => [thread.channelId, thread.id]))
    for (const channel of needsThread) {
      const threadId = threadMap.get(channel.id)
      channel.threads = [{ id: threadId ?? await ensureDefaultThread(prisma, channel.id) }]
    }
  }

  channels.sort((left, right) => {
    const leftPriority = left.systemChannelType === 'personal_assistant' ? 0 : 1
    const rightPriority = right.systemChannelType === 'personal_assistant' ? 0 : 1
    return leftPriority - rightPriority || left.createdAt.getTime() - right.createdAt.getTime()
  })

  const defaultThreadIds = channels.map((channel) => channel.threads[0]!.id)
  const unreadCountsByThread = await loadUnreadCountsByThread(prisma, defaultThreadIds, userId)
  const lastMessageAtByThread = await loadLastMessageAtByThread(prisma, defaultThreadIds)

  const principalUserIds = [...new Set(
    channels.flatMap((channel) =>
      (channel.agentBindings ?? []).flatMap((binding) =>
        binding.principalUserId ? [binding.principalUserId] : [])),
  )]
  const principalNames = new Map<string, string>()
  if (principalUserIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: principalUserIds } },
      select: { displayName: true, id: true },
    })
    for (const principal of users) {
      principalNames.set(principal.id, principal.displayName)
    }
  }

  return channels.map((channel) => {
    const personalAssistantPresences: PersonalAssistantPresenceParticipant[] =
      (channel.agentBindings ?? []).flatMap((binding) => {
        const principalUserId = binding.principalUserId
        if (!principalUserId) return []
        const ownerName = principalNames.get(principalUserId)
        // The FK to channel_members makes this unreachable in production, but
        // fail closed rather than producing a malformed identity projection.
        if (!ownerName) return []
        const mentionName = `${ownerName} – PA`
        return [{
          agentId: parseAgentId(binding.agentId),
          avatarAttachmentId: binding.agent.avatarAttachmentId ?? undefined,
          displayName: principalUserId === userId ? 'Personal Assistant' : mentionName,
          id: binding.id,
          isPersonalAssistant: true as const,
          mentionName,
          principalUserId: parseUserId(principalUserId),
        }]
      }).sort((left, right) => {
        const leftIsViewer = left.principalUserId === userId
        const rightIsViewer = right.principalUserId === userId
        if (leftIsViewer !== rightIsViewer) return leftIsViewer ? -1 : 1
        return left.principalUserId.localeCompare(right.principalUserId)
      })

    return {
    id: parseChannelId(channel.id),
    label: channel.label,
    slug: channel.slug,
    type: channel.type,
    systemChannelType: channel.systemChannelType ?? undefined,
    dmUserId: resolveDmUserId(channel, userId),
    visibility: channel.visibility,
    organizationId: parseOrganizationId(channel.organizationId),
    scope: channel.team.project.channelRoot ? 'standalone' : 'project',
    projectId: parseProjectId(channel.team.project.id),
    projectName: channel.team.project.name,
    teamId: parseTeamId(channel.teamId),
    teamName: channel.team.name,
    defaultThreadId: parseThreadId(channel.threads[0]!.id),
    unreadCount: unreadCountsByThread.get(channel.threads[0]!.id) ?? 0,
    lastMessageAt: lastMessageAtByThread.get(channel.threads[0]!.id) ?? null,
    topic: channel.topic ?? null,
    description: channel.description ?? null,
    archivedAt: channel.archivedAt?.toISOString() ?? null,
    memberRole: channel.members[0]?.role ?? null,
    muted: channel.members[0]?.muted ?? false,
    personalAssistantPresences,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
    }
  })
}

export const joinPublicChannel = async (
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; channelId: string },
): Promise<ChannelRecord | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: input.channelId },
    select: { organizationId: true, visibility: true, archivedAt: true },
  })
  if (!channel || channel.organizationId !== input.organizationId) {
    return null
  }
  if (channel.visibility !== 'public' || channel.archivedAt) {
    return null
  }

  const isOrgMember = await prisma.organizationMember.count({
    where: { organizationId: input.organizationId, userId: input.userId },
  })
  if (!isOrgMember) {
    return null
  }

  await prisma.channelMember.upsert({
    where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
    create: { channelId: input.channelId, userId: input.userId },
    update: {},
  })

  const joined = await prisma.channel.findUniqueOrThrow({
    where: { id: input.channelId },
    include: channelTeamInclude,
  })
  return mapChannelRecord(prisma, joined, input.userId)
}
