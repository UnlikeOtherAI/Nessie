import type { Prisma, PrismaClient } from '@prisma/client'
import type { RealtimeNotificationPayload } from '@nessie/runtime'
import { type WsScope } from '@nessie/schemas'

const MAX_REPLAY_EVENTS = 5_000
const REALTIME_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000
const REALTIME_EVENT_PRUNE_INTERVAL_MS = 60_000

export type RealtimeReplayEvent = {
  id: bigint
  channelId: string
  eventType: string
  payload: unknown
  createdAt: Date
}

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

export const parseLastRealtimeEventId = (
  value: string | undefined,
): bigint => {
  const trimmed = value?.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return 0n
  }

  return BigInt(trimmed)
}

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

  // TODO: mid-stream channel join/leave is not reflected until reconnect.
  return buildUserChannelRealtimeScopes(
    memberships.map((membership) => ({
      channelId: membership.channel.id,
      organizationId: membership.channel.organizationId,
      systemChannelType: membership.channel.systemChannelType,
    })),
    input.buildChannelRealtimeScopes,
  )
}

export const listRealtimeEventsAfterCursor = async (
  prisma: PrismaClient,
  input: {
    afterEventId: bigint
    channelIds: string[]
    organizationId: string
  },
): Promise<RealtimeReplayEvent[]> => {
  if (input.channelIds.length === 0) {
    return []
  }

  return prisma.realtimeEvent.findMany({
    where: {
      organizationId: input.organizationId,
      channelId: { in: input.channelIds },
      id: { gt: input.afterEventId },
    },
    orderBy: { id: 'asc' },
    take: MAX_REPLAY_EVENTS,
  })
}

export const createRealtimeEventStore = (prisma: PrismaClient) => {
  let lastPruneAt = 0

  const resolveOrganizationIdForChannel = async (
    channelId: string,
  ): Promise<string | null> => {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { organizationId: true },
    })

    return channel?.organizationId ?? null
  }

  const pruneOldEvents = async (): Promise<void> => {
    const now = Date.now()
    if (now - lastPruneAt < REALTIME_EVENT_PRUNE_INTERVAL_MS) {
      return
    }

    lastPruneAt = now
    await prisma.realtimeEvent.deleteMany({
      where: {
        createdAt: { lt: new Date(now - REALTIME_EVENT_RETENTION_MS) },
      },
    })
  }

  const append = async (
    notification: Extract<RealtimeNotificationPayload, { kind: 'ws' }>,
  ): Promise<RealtimeReplayEvent | null> => {
    const channelScope = notification.scopes.find(
      (scope): scope is Extract<WsScope, { kind: 'channel' }> => scope.kind === 'channel',
    )
    if (!channelScope) {
      return null
    }

    const organizationScope = notification.scopes.find(
      (scope): scope is Extract<WsScope, { kind: 'organization' }> =>
        scope.kind === 'organization',
    )
    const organizationId =
      organizationScope?.organizationId
      ?? (await resolveOrganizationIdForChannel(channelScope.channelId))

    if (!organizationId) {
      return null
    }

    const event = await prisma.realtimeEvent.create({
      data: {
        organizationId,
        channelId: channelScope.channelId,
        eventType: notification.message.event,
        payload: toJsonPayload(notification.message),
      },
    })

    await pruneOldEvents()

    return event
  }

  return {
    append,
    listAfter: (input: {
      afterEventId: bigint
      channelIds: string[]
      organizationId: string
    }) => listRealtimeEventsAfterCursor(prisma, input),
  }
}
