import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { WsScope } from '@nessie/schemas'

import {
  listRealtimeEventsAfterCursor,
  parseLastRealtimeEventId,
  resolveUserChannelRealtimeScopes,
  type RealtimeReplayEvent,
} from '../src/services/realtime-events.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'
const channelA = '00000000-0000-4000-8000-00000000000a'
const channelB = '00000000-0000-4000-8000-00000000000b'
const channelC = '00000000-0000-4000-8000-00000000000c'

type FindManyArgs = {
  where: {
    organizationId: string
    id: { gt: bigint }
    OR: Array<{ channelId?: { in: string[] }; recipientUserId?: string }>
  }
  orderBy: { id: 'asc' }
  take: number
}

type ReplayTestRow = RealtimeReplayEvent & { payloadOrganizationId: string }

test('realtime replay query returns only accessible channel events after the cursor', async () => {
  const rows: ReplayTestRow[] = [
    makeEvent(5n, channelA, organizationId),
    makeEvent(1n, channelA, organizationId),
    makeEvent(4n, channelC, organizationId),
    makeEvent(3n, channelA, otherOrganizationId),
    makeEvent(2n, channelB, organizationId),
  ]
  let capturedArgs: FindManyArgs | null = null
  const prisma = {
    realtimeEvent: {
      findMany: async (args: FindManyArgs) => {
        capturedArgs = args
        const channelIds = args.where.OR
          .flatMap((clause) => clause.channelId?.in ?? [])
        const recipientUserIds = args.where.OR
          .flatMap((clause) => clause.recipientUserId ? [clause.recipientUserId] : [])
        return rows
          .filter((row) => row.id > args.where.id.gt)
          .filter((row) =>
            (row.channelId !== null && channelIds.includes(row.channelId))
            || (row.recipientUserId !== null && recipientUserIds.includes(row.recipientUserId)),
          )
          .filter((row) => row.payloadOrganizationId === args.where.organizationId)
          .sort((left, right) => (left.id < right.id ? -1 : 1))
      },
    },
  } as unknown as PrismaClient

  const result = await listRealtimeEventsAfterCursor(prisma, {
    afterEventId: 2n,
    channelIds: [channelA, channelB],
    organizationId,
    userId,
  })

  assert.deepEqual(result.map((row) => row.id), [5n])
  assert.deepEqual(capturedArgs, {
    where: {
      organizationId,
      id: { gt: 2n },
      OR: [
        { channelId: { in: [channelA, channelB] } },
        { recipientUserId: userId },
      ],
    },
    orderBy: { id: 'asc' },
    take: 5000,
  })
})

test('realtime membership resolution returns the union of channel scopes', async () => {
  const prisma = {
    channelMember: {
      findMany: async () => [
        {
          channel: {
            id: channelA,
            organizationId,
            systemChannelType: null,
          },
        },
        {
          channel: {
            id: channelB,
            organizationId,
            systemChannelType: 'personal_assistant',
          },
        },
      ],
    },
    messageThreadFollow: {
      findMany: async () => [],
    },
  } as unknown as PrismaClient

  const scopes = await resolveUserChannelRealtimeScopes(prisma, {
    buildChannelRealtimeScopes: ({ channelId, organizationId: orgId, systemChannelType }) =>
      systemChannelType === 'personal_assistant'
        ? [{ kind: 'channel', channelId }]
        : [
            { kind: 'organization', organizationId: orgId },
            { kind: 'channel', channelId },
          ],
    organizationId,
    userId,
  })

  assert.deepEqual(scopes, [
    { kind: 'user', organizationId, userId },
    { kind: 'channel', channelId: channelA },
    { kind: 'channel', channelId: channelB },
  ] satisfies WsScope[])
})

test('last realtime event id parser ignores invalid cursors', () => {
  assert.equal(parseLastRealtimeEventId('42'), 42n)
  assert.equal(parseLastRealtimeEventId(undefined), 0n)
  assert.equal(parseLastRealtimeEventId('not-a-number'), 0n)
})

const makeEvent = (
  id: bigint,
  channelId: string,
  payloadOrganizationId: string,
): ReplayTestRow => ({
  id,
  channelId,
  eventType: 'message.new',
  payload: { type: 'event', event: 'message.new', data: {}, ts: new Date().toISOString() },
  payloadOrganizationId,
  createdAt: new Date(),
  recipientUserId: null,
})
