import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { PrismaClient } from '@prisma/client'
import type { FileService } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { runKnowledgeInferenceRequestContext } from '../src/services/knowledge-inference-origin.js'
import { registerKnowledgeSpreadsheetRoutes } from '../src/routes/knowledge-spreadsheets.js'
import { registerKnowledgeBaseRoutes } from '../src/routes/knowledge-base.js'
import { createSpreadsheetRouteContext } from '../src/routes/knowledge-spreadsheets-context.js'
import { seedDefaultPolicies } from '../src/services/policy-seed.js'

/**
 * The app and the seed the spreadsheet route tests share.
 *
 * Everything is scoped to one throwaway organization: a suite never counts
 * globally, and two suites can run against one database at the same time,
 * which CI does.
 */

export const dbAvailable = Boolean(process.env['DATABASE_URL'])

export type RouteActor = 'owner' | 'member' | 'reader' | 'outsider'

export type SpreadsheetRouteFixture = {
  app: FastifyInstance
  prisma: PrismaClient
  organizationId: string
  projectId: string
  spaceId: string
  /** A space the reader may read but not write. */
  readOnlySpaceId: string
  /**
   * The owner's personal documents: private, and nobody else's by any space
   * rule. A `KnowledgePageShare` is the only way another person reaches a page
   * in it, which is what makes it the space the sharing matrix runs in.
   */
  personalSpaceId: string
  ids: Record<RouteActor, string>
  published: { event: string; pageId: string; data: unknown }[]
  enqueued: { topic: string; payload: unknown }[]
  request: (
    actor: RouteActor,
    input: Parameters<FastifyInstance['inject']>[0],
  ) => ReturnType<FastifyInstance['inject']>
  teardown: () => Promise<void>
}

const memoryFileService = (prisma: PrismaClient): FileService => {
  const bytes = new Map<string, Buffer>()
  return {
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
      return attachment && body ? { stream: Readable.from([body]), attachment } : null
    },
    openDownload: async () => null,
    delete: async (attachmentId: string) => {
      bytes.delete(attachmentId)
      await prisma.attachment.deleteMany({ where: { id: attachmentId } })
      return true
    },
    purgeKnowledgePageFiles: async () => undefined,
    purgeEmailMessageFiles: async () => undefined,
    checkQuota: async () => ({ allowed: true }),
    currentUsage: async () => ({ usedBytes: 0n, limitBytes: null }),
    usageForScope: async () => 0n,
    setThumbnail: async () => undefined,
  } as unknown as FileService
}

export const seedSpreadsheetRoutes = async (
  label: string,
  options: { corsOrigins?: string[]; teamHostBaseDomain?: string } = {},
): Promise<SpreadsheetRouteFixture> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const ids: Record<RouteActor, string> = {
    owner: randomUUID(),
    member: randomUUID(),
    reader: randomUUID(),
    outsider: randomUUID(),
  }

  await prisma.organization.create({ data: { id: organizationId, name: `${label}-${organizationId}` } })
  await prisma.user.createMany({
    data: Object.values(ids).map((id) => ({
      id,
      email: `${id}@${label}.test`,
      displayName: `Route tester ${id.slice(0, 8)}`,
    })),
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId, userId: ids.owner, role: 'owner' },
      { organizationId, userId: ids.member, role: 'member' },
      { organizationId, userId: ids.reader, role: 'member' },
      { organizationId, userId: ids.outsider, role: 'member' },
    ],
  })
  const project = await prisma.project.create({ data: { organizationId, name: `${label} project` } })
  // A team, because a knowledge version's indexing origin resolves through the
  // page's team: a space with none cannot write a durable version at all, so a
  // fixture without one would quietly exercise half the path.
  const team = await prisma.team.create({
    data: { projectId: project.id, name: `${label} team` },
  })
  await prisma.projectMember.createMany({
    data: [ids.owner, ids.member, ids.reader].map((userId) => ({
      projectId: project.id,
      userId,
      role: userId === ids.owner ? 'owner' : 'member',
    })),
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      organizationId,
      projectId: project.id,
      name: `${label} space`,
      visibility: 'project',
      createdBy: ids.owner,
      teamId: team.id,
    },
  })
  // Write-restricted with an explicit member list: the reader may read it and
  // may not write it, which is the row the permission matrix turns on.
  const readOnlySpace = await prisma.knowledgeSpace.create({
    data: {
      organizationId,
      projectId: project.id,
      name: `${label} read-only space`,
      visibility: 'project',
      createdBy: ids.owner,
      writeRestricted: true,
      teamId: team.id,
    },
  })
  await prisma.knowledgeSpaceMember.createMany({
    data: [ids.owner, ids.member].map((userId) => ({
      spaceId: readOnlySpace.id,
      organizationId,
      userId,
    })),
  })
  const personalSpace = await prisma.knowledgeSpace.create({
    data: {
      organizationId,
      projectId: project.id,
      name: `${label} personal space`,
      visibility: 'private',
      metadata: { personal: true },
      userId: ids.owner,
      createdBy: ids.owner,
      teamId: team.id,
    },
  })
  await seedDefaultPolicies(prisma, organizationId, ids.owner)

  const published: SpreadsheetRouteFixture['published'] = []
  const enqueued: SpreadsheetRouteFixture['enqueued'] = []

  const contexts: Record<RouteActor, AuthorizedActionContext> = Object.fromEntries(
    (Object.keys(ids) as RouteActor[]).map((actor) => [
      actor,
      {
        actionContext: { requestId: `${label}-${actor}` },
        actor: { actorId: ids[actor], actorType: 'user', roles: [actor === 'owner' ? 'owner' : 'member'] },
        // `teamId` as a real request carries it: a version's inference origin is
        // built from the actor context first, and `completeLedgerAttribution`
        // refuses one without a team. Omitting it let the persisted-origin
        // fallback answer instead, which is not the path production takes.
        tenant: { organizationId, projectId: project.id, teamId: team.id },
      } as AuthorizedActionContext,
    ]),
  ) as Record<RouteActor, AuthorizedActionContext>

  const app = Fastify({ logger: false })
  // The same hook `buildApp` installs: every request gets its own async
  // context, so the actor a route resolves reaches the provider's
  // transactional hooks. Without it a version written deeper than one await
  // from the route falls through to the persisted-origin lookup and 500s — a
  // fixture artefact that looked exactly like a permission bug.
  app.addHook('onRequest', (_request, _reply, done) => {
    runKnowledgeInferenceRequestContext(done)
  })
  await app.register(multipart)

  const deps = {
    prisma,
    fileService: memoryFileService(prisma),
    config: { mode: 'production' },
    // A Set, as `ServerContext` builds it: `isOriginAllowed` calls `.has`, and
    // an array here would throw *after* the live route hijacked the reply,
    // leaving the socket open forever instead of failing the request.
    allowedCorsOrigins: new Set(options.corsOrigins ?? ['https://app.nessie.works']),
    teamHostBaseDomain: options.teamHostBaseDomain ?? 'nessie.works',
    realtimeHub: {
      publishDocumentEphemeral: async (
        pageId: string,
        _organizationId: string,
        event: string,
        data: unknown,
      ) => {
        published.push({ event, pageId, data })
        return { inlined: true }
      },
      addDocumentConnection: () => ({}),
      removeDocumentConnection: () => undefined,
    },
    requireActorContext: (request: { headers: Record<string, unknown> }) => {
      const actor = request.headers['x-spreadsheet-actor']
      return typeof actor === 'string' ? contexts[actor as RouteActor] : undefined
    },
  } as unknown as Parameters<typeof registerKnowledgeSpreadsheetRoutes>[1]

  const context = createSpreadsheetRouteContext(deps)
  // The queue seam, replaced so a test can prove a parse was *handed off*
  // rather than performed inline.
  const patched = Object.assign(context.service, {
    enqueueCompaction: async (input: { pageId: string; organizationId: string; seq: number }) => {
      enqueued.push({ topic: 'spreadsheet.compact', payload: input })
    },
  })
  registerKnowledgeSpreadsheetRoutes(app, deps, { ...context, service: patched })
  registerKnowledgeBaseRoutes(app, deps, { ...context, service: patched })
  await app.ready()

  return {
    app,
    prisma,
    organizationId,
    projectId: project.id,
    spaceId: space.id,
    readOnlySpaceId: readOnlySpace.id,
    personalSpaceId: personalSpace.id,
    ids,
    published,
    enqueued,
    request: (actor, input) =>
      app.inject({
        ...input,
        headers: { ...input.headers, 'x-spreadsheet-actor': actor },
      }),
    teardown: async () => {
      await app.close()
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } })
      await prisma.$disconnect()
    },
  }
}

/** Create a spreadsheet and return its page id, failing loudly if the route did not. */
export const createSpreadsheetVia = async (
  fixture: SpreadsheetRouteFixture,
  actor: RouteActor = 'owner',
  spaceId?: string,
): Promise<string> => {
  const response = await fixture.request(actor, {
    method: 'POST',
    url: `/api/knowledge-base/spaces/${spaceId ?? fixture.spaceId}/spreadsheets`,
    payload: { title: 'Route test sheet' },
  })
  if (response.statusCode !== 201) {
    throw new Error(`create failed: ${response.statusCode} ${response.body}`)
  }
  return (response.json() as { data: { id: string } }).data.id
}
