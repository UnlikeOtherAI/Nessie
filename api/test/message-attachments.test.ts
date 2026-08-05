import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import { createFileService, getStorage, type FileService } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { CreateThreadMessageBodySchema } from '../src/contracts.js'
import { registerCreateThreadMessageRoute } from '../src/routes/thread-message-create.js'
import { registerUploadRoutes } from '../src/routes/uploads.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const attachmentId = () => randomUUID()

// ─── Body contract: attachment-only posts, and the linked-id cap ────────────

test('message body accepts attachments without any text', () => {
  const parsed = CreateThreadMessageBodySchema.safeParse({
    attachmentIds: [attachmentId()],
  })

  assert.equal(parsed.success, true)
})

test('message body rejects neither text nor attachments', () => {
  assert.equal(CreateThreadMessageBodySchema.safeParse({}).success, false)
  assert.equal(CreateThreadMessageBodySchema.safeParse({ content: '' }).success, false)
  assert.equal(CreateThreadMessageBodySchema.safeParse({ content: '   ' }).success, false)
  assert.equal(
    CreateThreadMessageBodySchema.safeParse({ content: '  ', attachmentIds: [] }).success,
    false,
  )
})

test('message body caps linked attachments at ten', () => {
  const ten = Array.from({ length: 10 }, attachmentId)
  assert.equal(CreateThreadMessageBodySchema.safeParse({ attachmentIds: ten }).success, true)
  assert.equal(
    CreateThreadMessageBodySchema.safeParse({ attachmentIds: [...ten, attachmentId()] })
      .success,
    false,
  )
})

// ─── Route behaviour against a real database ────────────────────────────────

type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  channelId: string
  threadId: string
  senderId: string
  otherUserId: string
}

const actorContextFor = (seed: Seed, userId: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId: seed.organizationId, projectId: seed.projectId },
  actionContext: { requestId: `req-message-attachments-${userId}` },
})

const seedWorkspace = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({
    data: { name: `message-attachments ${randomUUID()}` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const makeUser = (displayName: string) =>
    prisma.user.create({
      data: { email: `message-attachments-${randomUUID()}@example.com`, displayName },
    })
  const sender = await makeUser('Sender')
  const other = await makeUser('Other')
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      slug: `c-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
      members: { create: [{ userId: sender.id }, { userId: other.id }] },
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  return {
    organizationId: org.id,
    projectId: project.id,
    teamId: team.id,
    channelId: channel.id,
    threadId: thread.id,
    senderId: sender.id,
    otherUserId: other.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  const messages = await prisma.message.findMany({
    where: { threadId: seed.threadId },
    select: { id: true },
  })
  await prisma.queueJob.deleteMany({
    where: { idempotencyKey: { in: messages.map((message) => `push:${message.id}`) } },
  })
  await prisma.storageUsageEvent.deleteMany({
    where: { organizationId: seed.organizationId },
  })
  await prisma.attachment.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.message.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.thread.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.channel.deleteMany({ where: { id: seed.channelId } })
  await prisma.user.deleteMany({ where: { id: { in: [seed.senderId, seed.otherUserId] } } })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

const buildApp = (
  prisma: PrismaClient,
  fileService: FileService,
  seed: Seed,
  actingUserId: string,
) => {
  const app = Fastify({ logger: false })
  const deps = {
    prisma,
    fileService,
    realtimeHub: { publishWs: async () => undefined },
    requireActorContext: () => actorContextFor(seed, actingUserId),
    buildChannelRealtimeScopes: () => [],
    isPersonalAssistantChannelType: () => false,
    messageMemoryCaptureConfig: null,
  } as unknown as Parameters<typeof registerCreateThreadMessageRoute>[1]
  registerCreateThreadMessageRoute(app, deps)
  registerUploadRoutes(app, deps as unknown as Parameters<typeof registerUploadRoutes>[1])
  return app
}

const storeFile = (
  fileService: FileService,
  seed: Seed,
  uploaderId: string,
  filename = 'note.txt',
) =>
  fileService.store({
    attribution: {
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      actorId: uploaderId,
      actorType: 'user',
    },
    organizationId: seed.organizationId,
    uploaderId,
    filename,
    mime: 'text/plain',
    body: Readable.from(['hello world']),
  })

const withHarness = async (
  actingUserIdFor: (seed: Seed) => string,
  run: (context: {
    app: ReturnType<typeof buildApp>
    fileService: FileService
    prisma: PrismaClient
    seed: Seed
  }) => Promise<void>,
) => {
  const prisma = new PrismaClient()
  const storagePath = `.tmp/message-attachments-${randomUUID()}`
  const fileService = createFileService({
    prisma,
    storage: getStorage({ provider: 'filesystem', localPath: storagePath }),
    maxUploadBytes: 5_000_000,
  })
  const seed = await seedWorkspace(prisma)
  const app = buildApp(prisma, fileService, seed, actingUserIdFor(seed))
  try {
    await run({ app, fileService, prisma, seed })
  } finally {
    await app.close()
    await cleanup(prisma, seed)
    await prisma.$disconnect()
    await rm(storagePath, { force: true, recursive: true })
  }
}

runDatabaseTest('an attachment-only message is created and linked', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, prisma, seed }) => {
      const { attachment } = await storeFile(fileService, seed, seed.senderId)

      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: { attachmentIds: [attachment.id] },
      })

      assert.equal(response.statusCode, 201)
      const body = response.json() as { data: { message: { id: string; content: string } } }
      assert.equal(body.data.message.content, '')
      const linked = await prisma.attachment.findUnique({ where: { id: attachment.id } })
      assert.equal(linked?.messageId, body.data.message.id)
    },
  )
})

runDatabaseTest('a message with neither text nor attachments is rejected', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, seed }) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: { content: '   ' },
      })

      assert.equal(response.statusCode, 400)
    },
  )
})

runDatabaseTest('more than ten attachment ids is rejected', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, seed }) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: { content: 'many', attachmentIds: Array.from({ length: 11 }, attachmentId) },
      })

      assert.equal(response.statusCode, 400)
    },
  )
})

runDatabaseTest('linking skips an attachment uploaded by another member', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, prisma, seed }) => {
      const mine = await storeFile(fileService, seed, seed.senderId, 'mine.txt')
      const theirs = await storeFile(fileService, seed, seed.otherUserId, 'theirs.txt')

      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: {
          content: 'with files',
          attachmentIds: [mine.attachment.id, theirs.attachment.id],
        },
      })

      assert.equal(response.statusCode, 201)
      const messageId = (response.json() as { data: { message: { id: string } } }).data.message.id
      const linkedMine = await prisma.attachment.findUnique({ where: { id: mine.attachment.id } })
      const linkedTheirs = await prisma.attachment.findUnique({
        where: { id: theirs.attachment.id },
      })
      assert.equal(linkedMine?.messageId, messageId)
      assert.equal(linkedTheirs?.messageId, null)
    },
  )
})

runDatabaseTest('the uploader can delete their own unlinked attachment', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, prisma, seed }) => {
      const { attachment } = await storeFile(fileService, seed, seed.senderId)

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/attachments/${attachment.id}`,
      })

      assert.equal(response.statusCode, 204)
      assert.equal(await prisma.attachment.findUnique({ where: { id: attachment.id } }), null)
      const events = await prisma.storageUsageEvent.findMany({
        where: { attachmentId: attachment.id },
        orderBy: { occurredAt: 'asc' },
      })
      const deltas = events.map((event) => event.deltaBytes)
      assert.deepEqual(deltas, [11n, -11n])
    },
  )
})

runDatabaseTest('a linked attachment cannot be deleted', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, prisma, seed }) => {
      const { attachment } = await storeFile(fileService, seed, seed.senderId)
      const created = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: { content: 'keep', attachmentIds: [attachment.id] },
      })
      assert.equal(created.statusCode, 201)

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/attachments/${attachment.id}`,
      })

      assert.equal(response.statusCode, 404)
      assert.notEqual(await prisma.attachment.findUnique({ where: { id: attachment.id } }), null)
    },
  )
})

runDatabaseTest('another member cannot delete an attachment they did not upload', async () => {
  await withHarness(
    (seed) => seed.otherUserId,
    async ({ app, fileService, prisma, seed }) => {
      const { attachment } = await storeFile(fileService, seed, seed.senderId)

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/attachments/${attachment.id}`,
      })

      assert.equal(response.statusCode, 404)
      assert.notEqual(await prisma.attachment.findUnique({ where: { id: attachment.id } }), null)
    },
  )
})
