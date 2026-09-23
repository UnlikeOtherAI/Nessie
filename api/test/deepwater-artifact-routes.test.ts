import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'

import { PrismaClient, type Attachment } from '@prisma/client'
import { insertDeepWaterBriefRun, resolveLiveEntitlements } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify, { type FastifyReply } from 'fastify'

import {
  registerDeepWaterArtifactRoutes,
  type DeepWaterArtifactRouteDeps,
} from '../src/routes/integrations/deep-water-artifacts.js'

/**
 * A finished research's artifacts (Water plan nessie.md §7.9, amendments N6)
 * are served only to whoever may see the research — the run's viewer
 * predicate — and only once it was delivered. The bytes are the exact ones
 * stored at delivery.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const REPORT = '# Heat pumps in older houses\n\nThey work, with care — and "insulation" first.\n'
const SOURCES = 'title,url,accessed_at\r\nA survey,https://example.test/a,2026-09-20\r\n'

type Seed = {
  prisma: PrismaClient
  organizationId: string
  projectId: string
  teamId: string
  requesterId: string
  memberId: string
  publicChannelId: string
  publicThreadId: string
  privateChannelId: string
  privateThreadId: string
  connectorId: string
  bytes: Map<string, Buffer>
  cleanup: () => Promise<void>
}

const seed = async (): Promise<Seed> => {
  const prisma = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const [requester, member] = await Promise.all([
    prisma.user.create({ data: { displayName: 'Requester', email: `dw-art-req-${suffix}@example.test` } }),
    prisma.user.create({ data: { displayName: 'Colleague', email: `dw-art-mem-${suffix}@example.test` } }),
  ])
  const organization = await prisma.organization.create({ data: { name: `dw-artifacts-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'member', userId: requester.id },
      { organizationId: organization.id, role: 'member', userId: member.id },
    ],
  })
  const project = await prisma.project.create({ data: { name: `dw-art-${suffix}`, organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: `dw-art-${suffix}`, projectId: project.id } })
  const base = { organizationId: organization.id, projectId: project.id, teamId: team.id, type: 'standard' as const }
  const publicChannel = await prisma.channel.create({
    data: { ...base, label: `research-${suffix}`, slug: `research-${suffix}`, visibility: 'public' },
  })
  const privateChannel = await prisma.channel.create({
    data: { ...base, label: `deal-${suffix}`, slug: `deal-${suffix}`, visibility: 'private' },
  })
  await prisma.channelMember.create({ data: { channelId: privateChannel.id, userId: requester.id } })
  const [publicThread, privateThread] = await Promise.all([
    prisma.thread.create({ data: { channelId: publicChannel.id } }),
    prisma.thread.create({ data: { channelId: privateChannel.id } }),
  ])
  const catalog = await prisma.mcpCatalogEntry.findFirstOrThrow({ where: { name: 'deep-water', organizationId: null } })
  const connector = await prisma.mcpServerInstance.create({
    data: {
      catalogEntryId: catalog.id,
      installedBy: requester.id,
      lifecycleState: 'active',
      organizationId: organization.id,
      scopeId: team.id,
      scopeType: 'team',
    },
  })
  return {
    prisma,
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
    requesterId: requester.id,
    memberId: member.id,
    publicChannelId: publicChannel.id,
    publicThreadId: publicThread.id,
    privateChannelId: privateChannel.id,
    privateThreadId: privateThread.id,
    connectorId: connector.id,
    bytes: new Map(),
    cleanup: async () => {
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [requester.id, member.id] } } })
      await prisma.$disconnect()
    },
  }
}

const storeArtifact = async (s: Seed, input: { filename: string; mime: string; body: Buffer | null }) => {
  const attachment = await s.prisma.attachment.create({
    data: {
      organizationId: s.organizationId,
      kind: 'file',
      mime: input.mime,
      filename: input.filename,
      sizeBytes: BigInt(input.body?.length ?? 0),
      storageKey: `test/deep-water/${randomUUID()}`,
    },
  })
  if (input.body) s.bytes.set(attachment.id, input.body)
  return attachment
}

type RunShape = {
  channelThread: 'public' | 'private'
  delivered: boolean
  status?: 'drafting' | 'running' | 'completed' | 'failed'
  report?: Buffer | null
  /**
   * Whether the watch saw the brief launched (`launched_at`). Defaults to
   * every shape but a drafting one: a person's brief stays theirs until then.
   */
  launched?: boolean
}

const seedRun = async (s: Seed, shape: RunShape) => {
  const privateOrigin = shape.channelThread === 'private'
  const { run } = await s.prisma.$transaction((tx) => insertDeepWaterBriefRun(tx, {
    organizationId: s.organizationId,
    teamId: s.teamId,
    connectorId: s.connectorId,
    requestedByUserId: s.requesterId,
    channelId: privateOrigin ? s.privateChannelId : s.publicChannelId,
    threadId: privateOrigin ? s.privateThreadId : s.publicThreadId,
    identity: { subject: `uoa|${s.requesterId}`, organizationId: 'uoa-org', teamId: 'uoa-team', tokenVersion: 1 },
    input: {
      schemaVersion: 1,
      topic: 'Heat pumps in older houses',
      context: null,
      pillars: null,
      settings: { depth: 'light' },
      originRootMessageId: null,
    },
    // A room that is not public seeds its own scope (N6); a public one nothing.
    sourceScopes: privateOrigin ? [{ scopeType: 'channel', scopeId: s.privateChannelId }] : [],
    disclosureSources: privateOrigin
      ? [{ sourceChannelId: s.privateChannelId, sourceAuthorUserId: s.requesterId }]
      : [],
    origin: { kind: 'person', actionId: randomUUID() },
  }))
  const report = await storeArtifact(s, {
    filename: 'heat-pumps-in-older-houses.md',
    mime: 'text/markdown',
    body: shape.report === undefined ? Buffer.from(REPORT) : shape.report,
  })
  const sources = await storeArtifact(s, {
    filename: 'heat-pumps-in-older-houses.csv',
    mime: 'text/csv',
    body: Buffer.from(SOURCES),
  })
  const status = shape.status ?? (shape.delivered ? 'completed' : 'running')
  const launched = shape.launched ?? status !== 'drafting'
  await s.prisma.productIntegrationRun.update({
    where: { id: run.id },
    data: {
      externalRunId: `rs_${randomUUID().replaceAll('-', '')}`,
      status,
      launchedAt: launched ? new Date() : null,
      reportFileId: report.id,
      sourcesFileId: sources.id,
      reportKind: 'full',
      reportTruncated: true,
      sourceCount: 1,
      deliveredAt: shape.delivered ? new Date() : null,
    },
  })
  return run.id
}

const actorFor = (s: Seed, userId: string, organizationId = s.organizationId): AuthorizedActionContext => ({
  actionContext: { requestId: randomUUID() },
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId, projectId: s.projectId, teamId: s.teamId },
} as AuthorizedActionContext)

const buildApp = async (s: Seed, actor: () => AuthorizedActionContext) => {
  const app = Fastify()
  const attachmentOf = (id: string, organizationId: string): Promise<Attachment | null> =>
    s.prisma.attachment.findFirst({ where: { id, organizationId } })
  const fileService = {
    openDownload: async (id: string, organizationId: string) => {
      const attachment = await attachmentOf(id, organizationId)
      const body = s.bytes.get(id)
      return attachment && body ? { kind: 'stream' as const, stream: Readable.from([body]), attachment } : null
    },
    openStream: async (id: string, organizationId: string) => {
      const attachment = await attachmentOf(id, organizationId)
      const body = s.bytes.get(id)
      return attachment && body ? { stream: Readable.from([body]), attachment } : null
    },
  }
  registerDeepWaterArtifactRoutes(app, {
    prisma: s.prisma,
    fileService,
    requireActorContext: () => actor(),
    requireUserActor: (context: AuthorizedActionContext, reply: FastifyReply) => {
      if (context.actor.actorType === 'user') return true
      void reply.code(403).send({ error: { code: 'FORBIDDEN' } })
      return false
    },
    // A local organisation: membership is the live entitlement.
    resolveLiveEntitlements: (prisma, input) => resolveLiveEntitlements(prisma, input, { uoaConfigured: false }),
  } as unknown as DeepWaterArtifactRouteDeps)
  await app.ready()
  return app
}

const path = (runId: string, artifact: string) =>
  `/api/integrations/products/deep-water/research-runs/${runId}/artifacts/${artifact}`

dbTest('the requester downloads the exact report and sources, and copies the markdown', async (t) => {
  const s = await seed()
  let viewer = s.requesterId
  const app = await buildApp(s, () => actorFor(s, viewer))
  t.after(async () => { await app.close(); await s.cleanup() })
  const runId = await seedRun(s, { channelThread: 'public', delivered: true })

  const report = await app.inject({ method: 'GET', url: path(runId, 'report.md') })
  assert.equal(report.statusCode, 200)
  assert.equal(report.body, REPORT)
  assert.equal(report.headers['content-type'], 'text/markdown')
  assert.equal(report.headers['content-disposition'], 'attachment; filename="heat-pumps-in-older-houses.md"')
  assert.equal(report.headers['x-content-type-options'], 'nosniff')

  const sources = await app.inject({ method: 'GET', url: path(runId, 'sources.csv') })
  assert.equal(sources.statusCode, 200)
  assert.equal(sources.body, SOURCES)
  assert.equal(sources.headers['content-disposition'], 'attachment; filename="heat-pumps-in-older-houses.csv"')

  const copy = await app.inject({ method: 'GET', url: path(runId, 'report') })
  assert.equal(copy.statusCode, 200)
  assert.equal(copy.headers['cache-control'], 'private, no-store')
  assert.deepEqual(copy.json(), { data: { markdown: REPORT, truncated: true, reportKind: 'full' } })

  // A colleague who can read the room where it was asked sees the finished research too.
  viewer = s.memberId
  const colleague = await app.inject({ method: 'GET', url: path(runId, 'report.md') })
  assert.equal(colleague.statusCode, 200)
  assert.equal(colleague.body, REPORT)
})

dbTest('a research built from a private room stays with the people who may read it', async (t) => {
  const s = await seed()
  let viewer = s.memberId
  const app = await buildApp(s, () => actorFor(s, viewer))
  t.after(async () => { await app.close(); await s.cleanup() })
  const runId = await seedRun(s, { channelThread: 'private', delivered: true })

  for (const artifact of ['report.md', 'sources.csv', 'report']) {
    const refused = await app.inject({ method: 'GET', url: path(runId, artifact) })
    assert.equal(refused.statusCode, 404, artifact)
    assert.equal(refused.json().error.code, 'DEEP_WATER_RESEARCH_NOT_FOUND', artifact)
  }

  viewer = s.requesterId
  assert.equal((await app.inject({ method: 'GET', url: path(runId, 'report.md') })).statusCode, 200)

  // Once the requester leaves that room, the research's lineage no longer reaches them either.
  await s.prisma.channelMember.deleteMany({ where: { channelId: s.privateChannelId, userId: s.requesterId } })
  const gone = await app.inject({ method: 'GET', url: path(runId, 'report') })
  assert.equal(gone.statusCode, 404)
  assert.equal(gone.json().error.code, 'DEEP_WATER_RESEARCH_NOT_FOUND')
})

dbTest('nothing is offered before delivery, and a missing research looks the same as a hidden one', async (t) => {
  const s = await seed()
  let viewer = s.requesterId
  let organizationId = s.organizationId
  const app = await buildApp(s, () => actorFor(s, viewer, organizationId))
  t.after(async () => { await app.close(); await s.cleanup() })
  const running = await seedRun(s, { channelThread: 'public', delivered: false })

  const early = await app.inject({ method: 'GET', url: path(running, 'report.md') })
  assert.equal(early.statusCode, 404)
  assert.equal(early.json().error.code, 'DEEP_WATER_ARTIFACT_NOT_FOUND')

  // A person's brief is theirs until it is launched.
  const drafting = await seedRun(s, { channelThread: 'public', delivered: false, status: 'drafting' })
  viewer = s.memberId
  const brief = await app.inject({ method: 'GET', url: path(drafting, 'report') })
  assert.equal(brief.json().error.code, 'DEEP_WATER_RESEARCH_NOT_FOUND')

  const unknown = await app.inject({ method: 'GET', url: path(randomUUID(), 'report.md') })
  assert.equal(unknown.statusCode, 404)
  assert.equal(unknown.json().error.code, 'DEEP_WATER_RESEARCH_NOT_FOUND')

  assert.equal((await app.inject({ method: 'GET', url: path('not-a-run', 'report.md') })).statusCode, 400)

  // Another organisation's session never reaches the run.
  viewer = s.requesterId
  organizationId = randomUUID()
  const foreign = await app.inject({ method: 'GET', url: path(running, 'report.md') })
  assert.equal(foreign.statusCode, 404)
  assert.equal(foreign.json().error.code, 'DEEP_WATER_RESEARCH_NOT_FOUND')
})

dbTest('a person\'s brief that was never launched stays theirs, whatever became of it', async (t) => {
  const s = await seed()
  let viewer = s.memberId
  const app = await buildApp(s, () => actorFor(s, viewer))
  t.after(async () => { await app.close(); await s.cleanup() })

  // Delivered or failed without the watch ever seeing a launch: the room was
  // never shown the research, so a colleague finds nothing, not even a hint.
  for (const [label, shape] of [
    ['delivered', { channelThread: 'public', delivered: true, launched: false }],
    ['failed', { channelThread: 'public', delivered: true, status: 'failed', launched: false }],
  ] satisfies Array<[string, RunShape]>) {
    viewer = s.memberId
    const runId = await seedRun(s, shape)
    for (const artifact of ['report.md', 'sources.csv', 'report']) {
      const hidden = await app.inject({ method: 'GET', url: path(runId, artifact) })
      assert.equal(hidden.statusCode, 404, `${label} ${artifact}`)
      assert.equal(hidden.json().error.code, 'DEEP_WATER_RESEARCH_NOT_FOUND', `${label} ${artifact}`)
    }
    viewer = s.requesterId
    const own = await app.inject({ method: 'GET', url: path(runId, 'report.md') })
    assert.equal(own.statusCode, 200, `${label}: the requester still has their own research`)
  }
})

dbTest('lost bytes are a storage fault, and a report past the proxy budget is downloaded, not copied', async (t) => {
  const s = await seed()
  const app = await buildApp(s, () => actorFor(s, s.requesterId))
  t.after(async () => { await app.close(); await s.cleanup() })

  const lost = await seedRun(s, { channelThread: 'public', delivered: true, report: null })
  const missing = await app.inject({ method: 'GET', url: path(lost, 'report.md') })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().error.code, 'ATTACHMENT_BYTES_MISSING')

  const huge = await seedRun(s, {
    channelThread: 'public',
    delivered: true,
    report: Buffer.alloc(8 * 1024 * 1024 + 1, 'a'),
  })
  const copy = await app.inject({ method: 'GET', url: path(huge, 'report') })
  assert.equal(copy.statusCode, 413)
  assert.equal(copy.json().error.code, 'DEEP_WATER_REPORT_TOO_LARGE_TO_COPY')
  assert.equal((await app.inject({ method: 'GET', url: path(huge, 'report.md') })).statusCode, 200)
})
