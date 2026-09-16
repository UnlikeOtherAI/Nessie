import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import Fastify, { type FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import { collectStream, createFileService, type FileService, type Storage } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerKnowledgeTransferRoutes } from '../src/routes/knowledge-transfers.js'
import { seedDefaultPolicies } from '../src/services/policy-seed.js'

/**
 * The world a cross-space transfer needs, seeded with real rows: an
 * organisation with two projects, a personal root folder, a project root
 * folder, an organisation-visible one and a second person who can write none of
 * them.
 *
 * Shared by the transfer suites rather than duplicated, because every one of
 * them asserts on the *same* seeded scopes — a chunk's `project_id`, a ledger
 * event's `space_id` — and two seeds that drifted would make those assertions
 * mean different things in different files.
 */

export type TransferSeed = {
  prisma: PrismaClient
  fileService: FileService
  organizationId: string
  projectId: string
  otherProjectId: string
  teamId: string
  ownerId: string
  outsiderId: string
  channelId: string
  /** The owner's personal root folder: `private`, owned by them. */
  personalSpaceId: string
  /** The project's Documents root folder: `project` visibility. */
  projectSpaceId: string
  /** An organisation-visible root folder. */
  orgSpaceId: string
  /** Every object the suite's FileService wrote, by storage key. */
  blobs: Map<string, Buffer>
}

// The api suite asserts on ledger rows and page rows, never on bytes at rest,
// so the store is a map. `FileService` still does all of its own work — the
// quota gate, the Attachment row, the signed events — against real Postgres.
const memoryStorage = (): Storage & { blobs: Map<string, Buffer> } => {
  const blobs = new Map<string, Buffer>()
  return {
    blobs,
    putStream: async (key, body) => {
      const buffer = await collectStream(body)
      blobs.set(key, buffer)
      return { bytesWritten: buffer.length }
    },
    getStream: async (key) => (blobs.has(key) ? Readable.from(blobs.get(key) as Buffer) : null),
    put: async (key, bytes) => {
      blobs.set(key, bytes)
    },
    get: async (key) => blobs.get(key) ?? null,
    delete: async (key) => {
      blobs.delete(key)
    },
  }
}

export const seedTransferWorld = async (): Promise<TransferSeed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const ownerId = randomUUID()
  const outsiderId = randomUUID()

  await prisma.organization.create({
    data: { id: organizationId, name: `transfers-${organizationId}` },
  })
  await prisma.user.createMany({
    data: [ownerId, outsiderId].map((id) => ({
      id,
      email: `${id}@transfers.test`,
      displayName: `Transfer ${id.slice(0, 8)}`,
    })),
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId, userId: ownerId, role: 'owner' },
      { organizationId, userId: outsiderId, role: 'member' },
    ],
  })
  const [project, otherProject] = await Promise.all([
    prisma.project.create({ data: { organizationId, name: 'Marketing' } }),
    prisma.project.create({ data: { organizationId, name: 'Legal' } }),
  ])
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, userId: ownerId, role: 'owner' },
      { projectId: otherProject.id, userId: ownerId, role: 'owner' },
    ],
  })
  const team = await prisma.team.create({
    data: { projectId: project.id, name: 'Core' },
  })
  const channel = await prisma.channel.create({
    data: {
      organizationId,
      projectId: project.id,
      teamId: team.id,
      label: 'private-room',
      slug: `private-room-${randomUUID().slice(0, 8)}`,
      visibility: 'private',
    },
  })
  await seedDefaultPolicies(prisma, organizationId, ownerId)

  const space = (input: {
    name: string
    projectId: string
    visibility: 'private' | 'project' | 'organization'
    userId?: string
  }) => prisma.knowledgeSpace.create({
    data: {
      organizationId,
      projectId: input.projectId,
      teamId: team.id,
      name: input.name,
      createdBy: ownerId,
      visibility: input.visibility,
      userId: input.userId ?? null,
    },
    select: { id: true },
  })
  const [personal, projectSpace, orgSpace] = await Promise.all([
    space({ name: 'My Documents', projectId: project.id, visibility: 'private', userId: ownerId }),
    space({ name: 'Marketing Documents', projectId: project.id, visibility: 'project' }),
    space({ name: 'Everyone', projectId: project.id, visibility: 'organization' }),
  ])

  const storage = memoryStorage()
  return {
    prisma,
    blobs: storage.blobs,
    fileService: createFileService({
      prisma,
      storage,
      maxUploadBytes: 10 * 1024 * 1024,
    }),
    organizationId,
    projectId: project.id,
    otherProjectId: otherProject.id,
    teamId: team.id,
    ownerId,
    outsiderId,
    channelId: channel.id,
    personalSpaceId: personal.id,
    projectSpaceId: projectSpace.id,
    orgSpaceId: orgSpace.id,
  }
}

export const teardownTransferWorld = async (seeded: TransferSeed): Promise<void> => {
  await seeded.prisma.organization.delete({ where: { id: seeded.organizationId } })
  await seeded.prisma.user.deleteMany({
    where: { id: { in: [seeded.ownerId, seeded.outsiderId] } },
  })
  await seeded.prisma.$disconnect()
}

export const contextFor = (
  seeded: TransferSeed,
  userId: string,
  role: 'member' | 'owner',
): AuthorizedActionContext => ({
  // `requestId` and `teamId` are not decoration: the copy path chunks a
  // published document inside its transaction and completes a ledger
  // attribution to enqueue the embed pass, which refuses without both.
  actionContext: { requestId: `transfer-${userId}`, teamId: seeded.teamId },
  actor: { actorId: userId, actorType: 'user', roles: [role] },
  tenant: {
    organizationId: seeded.organizationId,
    projectId: seeded.projectId,
    teamId: seeded.teamId,
  },
}) as AuthorizedActionContext

export const buildTransferApp = (seeded: TransferSeed): FastifyInstance => {
  const app = Fastify({ logger: false })
  const actors = new Map([
    ['owner', contextFor(seeded, seeded.ownerId, 'owner')],
    ['outsider', contextFor(seeded, seeded.outsiderId, 'member')],
  ])
  registerKnowledgeTransferRoutes(app, {
    prisma: seeded.prisma,
    fileService: seeded.fileService,
    sharedModelClient: null,
    knowledgeProvider: createNativeKnowledgeProvider(seeded.prisma),
    requireActorContext: (request: { headers: Record<string, unknown> }) => {
      const actor = request.headers['x-transfer-actor']
      return typeof actor === 'string' ? actors.get(actor) : undefined
    },
  } as unknown as Parameters<typeof registerKnowledgeTransferRoutes>[1])
  return app
}

export const transferAs = (
  app: FastifyInstance,
  actor: 'owner' | 'outsider',
  payload: unknown,
) => app.inject({
  method: 'POST',
  url: '/api/knowledge-base/transfers',
  headers: { 'x-transfer-actor': actor },
  payload: payload as Record<string, unknown>,
})

/** The scope columns a chunk mirrors, read back as retrieval would filter them. */
export const chunkScopes = (
  seeded: TransferSeed,
  pageId: string,
): Promise<Array<{
  project_id: string
  space_visibility: string
  user_id: string | null
  team_id: string | null
}>> => seeded.prisma.$queryRawUnsafe(
  `SELECT project_id, visibility::text AS space_visibility, user_id, team_id
   FROM knowledge_page_chunks WHERE page_id = $1::uuid ORDER BY chunk_index`,
  pageId,
)
