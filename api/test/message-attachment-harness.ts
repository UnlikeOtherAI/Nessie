import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'

import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { PrismaClient } from '@prisma/client'
import { createFileService, getStorage, type FileService } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerCreateThreadMessageRoute } from '../src/routes/thread-message-create.js'
import { registerUploadRoutes } from '../src/routes/uploads.js'

/**
 * Shared database harness for the attachment route tests: a seeded team, a
 * Fastify app with the upload + message-create routes, a filesystem-backed
 * FileService, and teardown. Extracted so message-attachments.test.ts (linking
 * and deletion rules) and attachment-thumbnails.test.ts (previews, caching,
 * counts) exercise exactly the same setup rather than each keeping a copy.
 */

export type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  channelId: string
  threadId: string
  senderId: string
  otherUserId: string
}

export const actorContextFor = (seed: Seed, userId: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId: seed.organizationId, projectId: seed.projectId },
  actionContext: { requestId: `req-message-attachments-${userId}` },
})

export const seedTeam = async (prisma: PrismaClient): Promise<Seed> => {
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

export const cleanup = async (prisma: PrismaClient, seed: Seed) => {
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

export const buildApp = (
  prisma: PrismaClient,
  fileService: FileService,
  seed: Seed,
  actingUserId: string,
) => {
  const app = Fastify({ logger: false })
  void app.register(multipart)
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

export const storeFile = (
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

export const withHarness = async (
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
  const seed = await seedTeam(prisma)
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

export type { FileService }
