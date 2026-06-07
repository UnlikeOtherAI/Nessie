import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerChannelRoutes } from '../src/routes/channels.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000099'
const projectId = '00000000-0000-4000-8000-000000000002'
const channelId = '00000000-0000-4000-8000-000000000003'
const userA = '00000000-0000-4000-8000-00000000000a'
const userB = '00000000-0000-4000-8000-00000000000b'

type ChannelMemberRow = {
  id: string
  channelId: string
  organizationId: string
  userId: string
  muted: boolean
}

type FindFirstArgs = {
  where: {
    channelId: string
    userId: string
    channel: { is: { organizationId: string } }
  }
}

type UpdateArgs = {
  where: { id: string }
  data: { muted: boolean }
}

const actorContextFor = (userId: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId, projectId },
  actionContext: { requestId: `req-channel-notifications-${userId}` },
})

const makeApp = (userId: string, rows: ChannelMemberRow[]) => {
  const prisma = {
    channelMember: {
      findFirst: async ({ where }: FindFirstArgs) =>
        rows.find(
          (row) =>
            row.channelId === where.channelId
            && row.userId === where.userId
            && row.organizationId === where.channel.is.organizationId,
        ) ?? null,
      update: async ({ where, data }: UpdateArgs) => {
        const row = rows.find((candidate) => candidate.id === where.id)
        if (!row) {
          throw new Error(`Missing channel member ${where.id}`)
        }
        row.muted = data.muted
        return { muted: row.muted }
      },
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerChannelRoutes(app, {
    prisma,
    requireActorContext: () => actorContextFor(userId),
    requireUserActor: () => true,
    loadPersonalAssistantState: async () => null,
    getChannelIfMember: async () => null,
  } as unknown as Parameters<typeof registerChannelRoutes>[1])
  return app
}

test('PATCH /api/channels/:channelId/notifications updates only the caller membership', async () => {
  const rows: ChannelMemberRow[] = [
    { id: 'member-a', channelId, organizationId, userId: userA, muted: false },
    { id: 'member-b', channelId, organizationId, userId: userB, muted: false },
  ]
  const app = makeApp(userA, rows)

  const response = await app.inject({
    method: 'PATCH',
    url: `/api/channels/${channelId}/notifications`,
    payload: { muted: true },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { data: { muted: true } })
  assert.equal(rows.find((row) => row.userId === userA)?.muted, true)
  assert.equal(rows.find((row) => row.userId === userB)?.muted, false)
  await app.close()
})

test('PATCH /api/channels/:channelId/notifications returns 404 when caller is not a member', async () => {
  const rows: ChannelMemberRow[] = [
    { id: 'member-a', channelId, organizationId: otherOrganizationId, userId: userA, muted: false },
  ]
  const app = makeApp(userA, rows)

  const response = await app.inject({
    method: 'PATCH',
    url: `/api/channels/${channelId}/notifications`,
    payload: { muted: true },
  })

  assert.equal(response.statusCode, 404)
  assert.equal(rows[0]?.muted, false)
  await app.close()
})
