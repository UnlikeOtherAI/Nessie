import type { PrismaClient } from '@prisma/client'
import { parseOrganizationId, parseUserId, type WsScope } from '@nessie/schemas'

export type { RealtimeReplayEvent } from '@nessie/runtime'

type ChannelRealtimeScopeInput = {
  channelId: string
  organizationId: string
  systemChannelType: string | null
}

type BuildChannelRealtimeScopes = (input: {
  channelId: string
  organizationId: string
  systemChannelType?: string | null
}) => WsScope[]

export const buildUserChannelRealtimeScopes = (
  channels: ChannelRealtimeScopeInput[],
  buildChannelRealtimeScopes: BuildChannelRealtimeScopes,
): WsScope[] => {
  const scopeKeys = new Set<string>()
  const scopes: WsScope[] = []

  for (const channel of channels) {
    for (const scope of buildChannelRealtimeScopes({
      channelId: channel.channelId,
      organizationId: channel.organizationId,
      systemChannelType: channel.systemChannelType,
    })) {
      if (scope.kind !== 'channel') {
        continue
      }

      const key = JSON.stringify(scope)
      if (scopeKeys.has(key)) {
        continue
      }

      scopeKeys.add(key)
      scopes.push(scope)
    }
  }

  return scopes
}

export const resolveUserChannelRealtimeScopes = async (
  prisma: PrismaClient,
  input: {
    buildChannelRealtimeScopes: BuildChannelRealtimeScopes
    organizationId: string
    userId: string
  },
): Promise<WsScope[]> => {
  const memberships = await prisma.channelMember.findMany({
    where: {
      userId: input.userId,
      channel: {
        organizationId: input.organizationId,
      },
    },
    orderBy: { channelId: 'asc' },
    select: {
      channel: {
        select: {
          id: true,
          organizationId: true,
          systemChannelType: true,
        },
      },
    },
  })

  // Public channels do not have ChannelMember rows. A person who follows a
  // reply conversation there is nevertheless entitled to its activity and
  // must receive the same live/replayed events as a member; otherwise the
  // Threads badge changes only on polling.
  const followedPublicRoots = await prisma.messageThreadFollow.findMany({
    where: {
      userId: input.userId,
      rootMessage: {
        thread: { channel: { organizationId: input.organizationId, visibility: 'public' } },
      },
    },
    select: {
      rootMessage: {
        select: {
          thread: { select: { channel: { select: { id: true, organizationId: true, systemChannelType: true } } } },
        },
      },
    },
  })

  // TODO: mid-stream channel join/leave is not reflected until reconnect.
  return [
    {
      kind: 'user',
      organizationId: parseOrganizationId(input.organizationId),
      userId: parseUserId(input.userId),
    },
    ...buildUserChannelRealtimeScopes(
      [
      ...memberships.map((membership) => ({
      channelId: membership.channel.id,
      organizationId: membership.channel.organizationId,
      systemChannelType: membership.channel.systemChannelType,
      })),
      ...followedPublicRoots.map((follow) => ({
        channelId: follow.rootMessage.thread.channel.id,
        organizationId: follow.rootMessage.thread.channel.organizationId,
        systemChannelType: follow.rootMessage.thread.channel.systemChannelType,
      })),
      ],
      input.buildChannelRealtimeScopes,
    ),
  ]
}
