import type { Prisma, PrismaClient } from '@prisma/client'
import type { RealtimeReplayEvent } from '@nessie/runtime'
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

const toJsonPayload = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

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

// Only the writer seam remains on the api side. Durable ws events are
// persisted once by `PgRealtimeTransport.publishWs` on the publish side;
// the api hub publishes through its own Prisma client so the row insert
// shares the api's connection lifecycle (and can join a transaction), while
// the NOTIFY still carries the persisted row id.
export const createRealtimeEventStore = (prisma: PrismaClient) => {
  const resolveOrganizationIdForChannel = async (
    channelId: string,
  ): Promise<string | null> => {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { organizationId: true },
    })

    return channel?.organizationId ?? null
  }

  const append = async (input: {
    message: {
      data: unknown
      event: string
      ts: string
      type: 'event'
    }
    scopes: WsScope[]
  }): Promise<RealtimeReplayEvent | null> => {
    const channelScope = input.scopes.find(
      (scope): scope is Extract<WsScope, { kind: 'channel' }> => scope.kind === 'channel',
    )
    const userScope = input.scopes.find(
      (scope): scope is Extract<WsScope, { kind: 'user' }> => scope.kind === 'user',
    )
    if (!channelScope && !userScope) {
      return null
    }

    const organizationScope = input.scopes.find(
      (scope): scope is Extract<WsScope, { kind: 'organization' }> =>
        scope.kind === 'organization',
    )
    // A user-scoped publication (the incoming-call ring) carries neither an
    // organization nor a channel scope, but the user scope names its own
    // organization. Without this fallback `append` returned null for it, and
    // the hub gates the whole user-SSE fan-out on a persisted row — so the
    // event was never stored, replayed, or delivered to anyone.
    const organizationId =
      organizationScope?.organizationId
      ?? (channelScope ? await resolveOrganizationIdForChannel(channelScope.channelId) : null)
      ?? userScope?.organizationId
      ?? null

    if (!organizationId) {
      return null
    }

    const event = await prisma.realtimeEvent.create({
      data: {
        organizationId,
        channelId: channelScope?.channelId,
        eventType: input.message.event,
        payload: toJsonPayload(input.message),
        recipientUserId: userScope?.userId,
      },
    })

    return event
  }

  return { append }
}
