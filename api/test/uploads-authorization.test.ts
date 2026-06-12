import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerUploadRoutes } from '../src/routes/uploads.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const userA = '00000000-0000-4000-8000-00000000000a'
const userB = '00000000-0000-4000-8000-00000000000b'
const privateChannelId = '00000000-0000-4000-8000-000000000010'
const privateThreadId = '00000000-0000-4000-8000-000000000011'
const privateMessageId = '00000000-0000-4000-8000-000000000012'

type AttachmentRow = {
  id: string
  organizationId: string
  uploaderId: string | null
  messageId: string | null
  kind: string
  mime: string
  filename: string
  sizeBytes: number
  storageKey: string
  width: number | null
  height: number | null
  createdAt: Date
}

type ChannelRow = {
  id: string
  organizationId: string
  visibility: 'private' | 'protected' | 'public'
  memberIds: string[]
}

type ThreadRow = { id: string; channelId: string }
type MessageRow = { id: string; threadId: string }

const actorContextFor = (userId: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId, projectId },
  actionContext: { requestId: `req-uploads-${userId}` },
})

const messageMatchesAccessWhere = (
  message: MessageRow,
  where: {
    id: string
    thread: {
      channel: {
        organizationId: string
        OR: Array<
          | { visibility: 'public' }
          | { members: { some: { userId: string } } }
        >
      }
    }
  },
  threads: ThreadRow[],
  channels: ChannelRow[],
): boolean => {
  if (message.id !== where.id) return false
  const thread = threads.find((candidate) => candidate.id === message.threadId)
  const channel = thread
    ? channels.find((candidate) => candidate.id === thread.channelId)
    : null
  if (!channel || channel.organizationId !== where.thread.channel.organizationId) {
    return false
  }
  return where.thread.channel.OR.some((clause) => {
    if ('visibility' in clause) return channel.visibility === clause.visibility
    return channel.memberIds.includes(clause.members.some.userId)
  })
}

const makeApp = (
  userId: string,
  storagePath: string,
) => {
  const usageEvents: unknown[] = []
  const attachments: AttachmentRow[] = [
    {
      id: '00000000-0000-4000-8000-0000000000a1',
      organizationId,
      uploaderId: userA,
      messageId: privateMessageId,
      kind: 'text',
      mime: 'text/plain',
      filename: 'private.txt',
      sizeBytes: 11,
      storageKey: `${organizationId}/private-file`,
      width: null,
      height: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ]
  const threads: ThreadRow[] = [{ id: privateThreadId, channelId: privateChannelId }]
  const messages: MessageRow[] = [{ id: privateMessageId, threadId: privateThreadId }]
  const channels: ChannelRow[] = [
    {
      id: privateChannelId,
      organizationId,
      visibility: 'private',
      memberIds: [userA],
    },
  ]

  const prisma = {
    attachment: {
      findMany: async ({ where }: { where: { messageId: string; organizationId: string } }) =>
        attachments.filter((attachment) =>
          attachment.messageId === where.messageId &&
          attachment.organizationId === where.organizationId,
        ),
      findUnique: async ({ where }: { where: { id: string } }) =>
        attachments.find((attachment) => attachment.id === where.id) ?? null,
    },
    message: {
      findFirst: async ({ where }: { where: Parameters<typeof messageMatchesAccessWhere>[1] }) =>
        messages.find((message) =>
          messageMatchesAccessWhere(message, where, threads, channels),
        ) ?? null,
    },
    connectorUsageEvent: {
      create: async ({ data }: { data: unknown }) => {
        usageEvents.push(data)
        return data
      },
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerUploadRoutes(app, {
    config: {
      storage: {
        provider: 'filesystem',
        localPath: storagePath,
      },
    },
    prisma,
    requireActorContext: () => actorContextFor(userId),
  } as unknown as Parameters<typeof registerUploadRoutes>[1])
  return { app, usageEvents }
}

test('message attachment listing requires access to the linked thread channel', async () => {
  const storagePath = `.tmp/uploads-auth-list-${Date.now()}`
  const { app } = makeApp(userB, storagePath)
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/messages/${privateMessageId}/attachments`,
    })

    assert.equal(response.statusCode, 404)
  } finally {
    await app.close()
    await rm(storagePath, { force: true, recursive: true })
  }
})

test('attachment download requires access to the linked thread channel', async () => {
  const storagePath = `.tmp/uploads-auth-download-${Date.now()}`
  const { app, usageEvents } = makeApp(userB, storagePath)
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/attachments/00000000-0000-4000-8000-0000000000a1',
    })

    assert.equal(response.statusCode, 404)
    assert.equal(usageEvents.length, 0)
  } finally {
    await app.close()
    await rm(storagePath, { force: true, recursive: true })
  }
})

test('channel members can download attachments from accessible messages', async () => {
  const storagePath = `.tmp/uploads-auth-allow-${Date.now()}`
  await mkdir(`${storagePath}/${organizationId}`, { recursive: true })
  await writeFile(`${storagePath}/${organizationId}/private-file`, 'hello world')

  const { app, usageEvents } = makeApp(userA, storagePath)
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/attachments/00000000-0000-4000-8000-0000000000a1',
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'text/plain')
    assert.equal(response.body, 'hello world')
    assert.equal(usageEvents.length, 1)
    const usageEvent = usageEvents[0] as Record<string, unknown>
    assert.equal(usageEvent.organizationId, organizationId)
    assert.equal(usageEvent.projectId, projectId)
    assert.equal(usageEvent.actorId, userA)
    assert.equal(usageEvent.actorType, 'user')
    assert.equal(usageEvent.requestId, `req-uploads-${userA}`)
    assert.equal(usageEvent.connectorType, 'storage')
    assert.equal(usageEvent.target, 'attachment')
    assert.equal(usageEvent.operation, 'download')
    assert.equal(usageEvent.calls, 1)
    assert.equal(usageEvent.units, 11)
    assert.equal(usageEvent.unitType, 'bytes')
    assert.equal(usageEvent.success, true)
    assert.equal(typeof usageEvent.latencyMs, 'number')
    assert.ok(usageEvent.occurredAt instanceof Date)
    assert.deepEqual(usageEvent.metadata, {
      attachmentId: '00000000-0000-4000-8000-0000000000a1',
      source: 'api.attachments',
    })
  } finally {
    await app.close()
    await rm(storagePath, { force: true, recursive: true })
  }
})
