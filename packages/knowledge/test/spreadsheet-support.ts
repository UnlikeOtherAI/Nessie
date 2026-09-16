import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { PrismaClient } from '@prisma/client'
import type { FileService } from '@nessie/runtime'

import { createNativeKnowledgeProvider } from '../src/native-provider.js'
import {
  createSpreadsheetModelCache,
  createSpreadsheetService,
  type SpreadsheetServiceDeps,
} from '../src/spreadsheet/index.js'

/**
 * The seed and the doubles every spreadsheet test shares.
 *
 * Every row is scoped to one throwaway organization and torn down with it, so
 * a suite never counts globally and two suites can run against one database at
 * the same time (which CI does).
 */

export const dbAvailable = Boolean(process.env['DATABASE_URL'])

export type SpreadsheetSeed = {
  prisma: PrismaClient
  organizationId: string
  projectId: string
  spaceId: string
  userId: string
  otherUserId: string
  files: FakeFileService
  teardown: () => Promise<void>
}

/**
 * A `FileService` that keeps bytes in memory but writes **real** `Attachment`
 * rows: `addFileVersion` reads the row back to decide whether the attachment is
 * Markdown, and `purgeKnowledgePageFiles` walks the same table, so a double
 * that skipped the rows would pass tests the production path fails.
 */
export type FakeFileService = FileService & {
  bytes: Map<string, Buffer>
  deleted: string[]
}

export const createFakeFileService = (prisma: PrismaClient): FakeFileService => {
  const bytes = new Map<string, Buffer>()
  const deleted: string[] = []

  const service = {
    bytes,
    deleted,
    store: async (input: Parameters<FileService['store']>[0]) => {
      const chunks: Buffer[] = []
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk as Buffer))
      const body = Buffer.concat(chunks)
      const attachment = await prisma.attachment.create({
        data: {
          organizationId: input.organizationId,
          uploaderId: input.uploaderId ?? null,
          knowledgePageId: input.knowledgePageId ?? null,
          kind: 'file',
          mime: input.mime,
          filename: input.filename,
          sizeBytes: BigInt(body.byteLength),
          storageKey: `memory/${randomUUID()}`,
        },
      })
      bytes.set(attachment.id, body)
      return { attachment, bytesWritten: body.byteLength }
    },
    openStream: async (attachmentId: string, organizationId: string) => {
      const attachment = await prisma.attachment.findFirst({
        where: { id: attachmentId, organizationId },
      })
      const body = bytes.get(attachmentId)
      if (!attachment || !body) return null
      return { stream: Readable.from([body]), attachment }
    },
    openDownload: async () => null,
    delete: async (attachmentId: string, organizationId: string) => {
      deleted.push(attachmentId)
      bytes.delete(attachmentId)
      await prisma.attachment.deleteMany({ where: { id: attachmentId, organizationId } })
      return true
    },
    purgeKnowledgePageFiles: async (pageId: string, organizationId: string) => {
      const pageAttachments = await prisma.attachment.findMany({
        where: { knowledgePageId: pageId, organizationId },
        select: { id: true },
      })
      const versions = await prisma.knowledgePageVersion.findMany({
        where: { pageId, attachmentId: { not: null } },
        select: { attachmentId: true },
      })
      for (const id of [
        ...pageAttachments.map((row) => row.id),
        ...versions.map((row) => row.attachmentId).filter((id): id is string => Boolean(id)),
      ]) {
        deleted.push(id)
        bytes.delete(id)
        await prisma.attachment.deleteMany({ where: { id, organizationId } })
      }
    },
    purgeEmailMessageFiles: async () => undefined,
    checkQuota: async () => ({ allowed: true }),
    currentUsage: async () => ({ usedBytes: 0n, limitBytes: null }),
    usageForScope: async () => 0n,
    setThumbnail: async () => undefined,
  } as unknown as FakeFileService

  return service
}

export const seedSpreadsheetFixture = async (label: string): Promise<SpreadsheetSeed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const otherUserId = randomUUID()

  await prisma.organization.create({ data: { id: organizationId, name: `${label}-${organizationId}` } })
  await prisma.user.createMany({
    data: [userId, otherUserId].map((id) => ({
      id,
      email: `${id}@${label}.test`,
      displayName: `Sheet tester ${id.slice(0, 8)}`,
    })),
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId, userId, role: 'owner' },
      { organizationId, userId: otherUserId, role: 'member' },
    ],
  })
  const project = await prisma.project.create({ data: { organizationId, name: `${label} project` } })
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, userId, role: 'owner' },
      { projectId: project.id, userId: otherUserId, role: 'member' },
    ],
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      organizationId,
      projectId: project.id,
      name: `${label} space`,
      visibility: 'project',
      createdBy: userId,
    },
  })

  return {
    prisma,
    organizationId,
    projectId: project.id,
    spaceId: space.id,
    userId,
    otherUserId,
    files: createFakeFileService(prisma),
    teardown: async () => {
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } })
      await prisma.$disconnect()
    },
  }
}

export type TestService = ReturnType<typeof createSpreadsheetService> & {
  published: { event: string; pageId: string; data: unknown }[]
  compactions: { pageId: string; seq: number }[]
}

/**
 * A service instance. Tests that prove the cache is not an authority build
 * two of them over one database, which is only meaningful because the cache is
 * closure state of this factory rather than module scope.
 */
export const createTestService = (
  seed: SpreadsheetSeed,
  options: { cache?: SpreadsheetServiceDeps['cache'] } = {},
): TestService => {
  const provider = createNativeKnowledgeProvider(seed.prisma)
  const published: TestService['published'] = []
  const compactions: TestService['compactions'] = []
  const service = createSpreadsheetService({
    prisma: seed.prisma,
    fileService: seed.files,
    cache: options.cache ?? createSpreadsheetModelCache(),
    createPage: (input) => provider.createPage(input),
    addFileVersion: (input) => provider.addFileVersion(input),
    publish: async (event, input) => {
      published.push({ event, pageId: input.pageId, data: input.data })
    },
    enqueueCompaction: async (input) => {
      compactions.push({ pageId: input.pageId, seq: input.seq })
    },
  })
  return Object.assign(service, { published, compactions })
}

export const attributionFor = (seed: SpreadsheetSeed) =>
  ({
    organizationId: seed.organizationId,
    actorType: 'user',
    actorId: seed.userId,
  }) as unknown as Parameters<
    typeof import('../src/spreadsheet/snapshot.js').createSpreadsheetSnapshot
  >[1]['attribution']

export const userActor = (seed: SpreadsheetSeed) =>
  ({ type: 'user' as const, id: seed.userId, displayName: 'Sheet tester' })
