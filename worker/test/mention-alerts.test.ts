import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { parseChannelId, type WsScope } from '@nessie/schemas'

import { createMessageMentionAlerts } from '../src/run/mention-alerts.js'

// Agent-authored mention alerts (#246): an agent/PA message that @mentions a
// user must create the same durable alert rows (and alert.created fan-out) as
// a human-authored one.
const ORG = '00000000-0000-4000-8000-000000000401'
const CHANNEL = '00000000-0000-4000-8000-000000000402'
const THREAD = '00000000-0000-4000-8000-000000000403'
const MESSAGE = '00000000-0000-4000-8000-000000000404'
const AGENT = '00000000-0000-4000-8000-000000000405'
const OWNER = '00000000-0000-4000-8000-000000000406'
const MEMBER = '00000000-0000-4000-8000-000000000407'

const SCOPES: WsScope[] = [{ kind: 'channel', channelId: parseChannelId(CHANNEL) }]

type AlertCreate = {
  organizationId: string
  userId: string
  kind: string
  actorUserId: string | null
  actorAgentId: string | null
}

const makeDeps = (input: {
  members: { id: string; displayName: string }[]
  failCreateMany?: boolean
  visibility?: 'public' | 'protected' | 'private'
  organizationMembers?: { id: string; displayName: string }[]
}) => {
  const created: AlertCreate[] = []
  const follows: { rootMessageId: string; userId: string }[] = []
  const published: { data: Record<string, unknown>; event: string }[] = []
  const prisma = {
    channel: {
      findUnique: async () => ({
        systemChannelType: null,
        type: 'standard',
        visibility: input.visibility ?? 'private',
      }),
    },
    channelMember: {
      findMany: async () => input.members.map((member) => ({ user: member })),
    },
    organizationMember: {
      findMany: async () => (input.organizationMembers ?? []).map((user) => ({ user })),
    },
    userAlert: {
      createMany: async ({ data }: { data: AlertCreate[] }) => {
        if (input.failCreateMany) throw new Error('db down')
        created.push(...data)
        return { count: data.length }
      },
    },
    message: {
      findUnique: async () => ({ rootMessageId: null }),
    },
    messageThreadFollow: {
      createMany: async ({ data }: { data: { rootMessageId: string; userId: string }[] }) => {
        follows.push(...data)
        return { count: data.length }
      },
    },
  } as unknown as PrismaClient
  const realtimeTransport = {
    publishWs: async (_scopes: WsScope[], event: { data: Record<string, unknown>; event: string }) => {
      published.push(event)
      return {}
    },
  }
  return { prisma, realtimeTransport, created, follows, published }
}

const baseInput = {
  organizationId: ORG,
  channelId: CHANNEL,
  threadId: THREAD,
  messageId: MESSAGE,
  messageCreatedAt: new Date('2026-07-24T12:00:00.000Z'),
  scopes: SCOPES,
}

test('an agent-authored @mention creates an alert row and publishes alert.created', async () => {
  const deps = makeDeps({
    members: [
      { id: MEMBER, displayName: 'Mentioned One' },
      { id: OWNER, displayName: 'Owner One' },
    ],
  })

  await createMessageMentionAlerts(
    { prisma: deps.prisma, realtimeTransport: deps.realtimeTransport },
    {
      ...baseInput,
      content: '@Mentioned One please review this',
      actorUserId: null,
      actorAgentId: AGENT,
    },
  )

  assert.equal(deps.created.length, 1)
  assert.equal(deps.created[0]?.userId, MEMBER)
  assert.equal(deps.created[0]?.kind, 'mention')
  assert.equal(deps.created[0]?.actorUserId, null)
  assert.equal(deps.created[0]?.actorAgentId, AGENT)
  assert.equal(deps.created[0]?.organizationId, ORG)
  assert.deepEqual(deps.follows, [{ rootMessageId: MESSAGE, userId: MEMBER }])

  assert.equal(deps.published.length, 1)
  assert.equal(deps.published[0]?.event, 'alert.created')
  assert.equal(deps.published[0]?.data['userId'], MEMBER)
  assert.equal(deps.published[0]?.data['actorAgentId'], AGENT)
  assert.equal(deps.published[0]?.data['messageId'], MESSAGE)
})

test('a delegated owner-authored message skips the owner self-mention', async () => {
  const deps = makeDeps({
    members: [
      { id: MEMBER, displayName: 'Mentioned One' },
      { id: OWNER, displayName: 'Owner One' },
    ],
  })

  await createMessageMentionAlerts(
    { prisma: deps.prisma, realtimeTransport: deps.realtimeTransport },
    {
      ...baseInput,
      content: '@Owner One @Mentioned One sync later',
      actorUserId: OWNER,
      actorAgentId: AGENT,
    },
  )

  assert.deepEqual(
    deps.created.map((alert) => alert.userId),
    [MEMBER],
  )
  assert.equal(deps.created[0]?.actorUserId, OWNER)
  assert.equal(deps.published.length, 1)
})

test('no @ token means no work at all', async () => {
  const deps = makeDeps({ members: [{ id: MEMBER, displayName: 'Mentioned One' }] })

  await createMessageMentionAlerts(
    { prisma: deps.prisma, realtimeTransport: deps.realtimeTransport },
    { ...baseInput, content: 'nothing to see here', actorAgentId: AGENT },
  )

  assert.equal(deps.created.length, 0)
  assert.equal(deps.published.length, 0)
})

test('a persistence failure is swallowed (best-effort, never breaks delivery)', async () => {
  const deps = makeDeps({
    members: [{ id: MEMBER, displayName: 'Mentioned One' }],
    failCreateMany: true,
  })

  await createMessageMentionAlerts(
    { prisma: deps.prisma, realtimeTransport: deps.realtimeTransport },
    { ...baseInput, content: '@Mentioned One hi', actorAgentId: AGENT },
  )

  assert.equal(deps.published.length, 0)
})

test('a durable completion mention propagates persistence failure for replay', async () => {
  const deps = makeDeps({
    members: [{ id: MEMBER, displayName: 'Mentioned One' }],
    failCreateMany: true,
  })

  await assert.rejects(
    createMessageMentionAlerts(
      { prisma: deps.prisma, realtimeTransport: deps.realtimeTransport },
      {
        ...baseInput,
        actorAgentId: AGENT,
        content: '@Mentioned One hi',
        durableEventKey: `run-completion:${MESSAGE}:mention-alert`,
      },
    ),
    /db down/,
  )
})

// Who a mention can address (docs/standards/user-alerts.md): an open channel
// adds every active organisation member; a private one adds nobody, so a
// non-member named in an agent's message there is never alerted.
const OUTSIDER = '00000000-0000-4000-8000-000000000408'

test('an agent @mention of a non-member alerts them in a public channel', async () => {
  const deps = makeDeps({
    members: [{ id: MEMBER, displayName: 'Mentioned One' }],
    organizationMembers: [
      { id: MEMBER, displayName: 'Mentioned One' },
      { id: OUTSIDER, displayName: 'Otto Outsider' },
    ],
    visibility: 'public',
  })

  await createMessageMentionAlerts(
    { prisma: deps.prisma, realtimeTransport: deps.realtimeTransport },
    { ...baseInput, content: '@Otto Outsider can you check', actorAgentId: AGENT },
  )

  assert.deepEqual(deps.created.map((row) => row.userId), [OUTSIDER])
})

test('an agent @mention of a non-member alerts nobody in a private channel', async () => {
  const deps = makeDeps({
    members: [{ id: MEMBER, displayName: 'Mentioned One' }],
    organizationMembers: [{ id: OUTSIDER, displayName: 'Otto Outsider' }],
    visibility: 'private',
  })

  await createMessageMentionAlerts(
    { prisma: deps.prisma, realtimeTransport: deps.realtimeTransport },
    { ...baseInput, content: '@Otto Outsider can you check', actorAgentId: AGENT },
  )

  assert.deepEqual(deps.created, [])
  assert.deepEqual(deps.published, [])
})
