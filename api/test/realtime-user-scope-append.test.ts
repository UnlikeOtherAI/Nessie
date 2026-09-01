import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createRealtimeEventStore } from '../src/services/realtime-events.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000003'
const channelId = '00000000-0000-4000-8000-00000000000a'

type CreatedRow = {
  organizationId: string
  channelId: string | null
  recipientUserId: string | null
  eventType: string
}

const storeWithRecorder = (): { store: ReturnType<typeof createRealtimeEventStore>; created: CreatedRow[] } => {
  const created: CreatedRow[] = []
  let nextId = 1n
  const prisma = {
    realtimeEvent: {
      create: async ({ data }: { data: CreatedRow }) => {
        created.push(data)
        return { ...data, id: nextId++, createdAt: new Date(0) }
      },
      deleteMany: async () => ({ count: 0 }),
    },
    channel: {
      findUnique: async () => ({ organizationId }),
    },
  } as unknown as PrismaClient
  return { store: createRealtimeEventStore(prisma), created }
}

/**
 * The incoming-call ring is published to one user scope alone — it carries no
 * organization or channel scope, because a mixed publication would be dropped
 * on the other side (the store keeps only the first scope of each kind and the
 * hub treats any user scope as user-only). `append` used to derive the
 * organization from an organization or channel scope exclusively, so a
 * user-only publication resolved to null and was never persisted. The hub gates
 * its entire user-SSE fan-out on that persisted row, so the ring reached
 * nobody. Reverting the `?? userScope?.organizationId` fallback fails this test.
 */
test('a user-only publication is persisted using the user scope organization', async () => {
  const { store, created } = storeWithRecorder()

  const event = await store.append({
    kind: 'ws',
    message: {
      data: { callId: '00000000-0000-4000-8000-0000000000ca' },
      event: 'call.incoming',
      ts: new Date(0).toISOString(),
      type: 'event',
    },
    scopes: [{ kind: 'user', organizationId, userId }],
  } as Parameters<typeof store.append>[0])

  assert.ok(event, 'a user-only publication must produce a replay row')
  assert.equal(created.length, 1)
  assert.equal(created[0]?.organizationId, organizationId)
  assert.equal(created[0]?.recipientUserId, userId)
  assert.equal(created[0]?.channelId, undefined)
})

test('an organization scope still wins over the user scope organization', async () => {
  const { store, created } = storeWithRecorder()

  await store.append({
    kind: 'ws',
    message: {
      data: {},
      event: 'call.invite.updated',
      ts: new Date(0).toISOString(),
      type: 'event',
    },
    scopes: [
      { kind: 'channel', channelId },
      { kind: 'user', organizationId, userId },
    ],
  } as Parameters<typeof store.append>[0])

  assert.equal(created.length, 1)
  assert.equal(created[0]?.organizationId, organizationId)
  assert.equal(created[0]?.channelId, channelId)
})
