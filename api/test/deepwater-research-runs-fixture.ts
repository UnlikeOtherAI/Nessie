import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { deepWaterBriefTools } from '@nessie/mcp-manage'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify, { type FastifyInstance } from 'fastify'

import { registerResearchRunRoutes } from '../src/routes/integrations/research-runs.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * A real team on the DeepWater brief contract for the brief API suites: its
 * switch on, its connector projecting the brief tools, a public room with a
 * thread, and three people — the requester (linked to DeepWater through UOA on
 * this team), a colleague in the same room, and an organisation owner. The app
 * is the brief API alone, with each request acting as whichever person the
 * suite names.
 *
 * No UOA deployment is configured in this process, so disclosure reads the
 * local organisation membership; the UOA link and the team's external ids are
 * what the brief API itself checks.
 */

export const dbTest = process.env.DATABASE_URL ? test : test.skip

process.env.LEDGER_PROXY_TOKEN = 'nessie-ledger-app-api-key'

export type Person = 'requester' | 'colleague' | 'owner'

export type BriefApiFixture = {
  prisma: PrismaClient
  app: FastifyInstance
  ids: Record<'organization' | 'project' | 'team' | 'channel' | 'thread' | 'connector' | Person, string>
  identity: { subject: string; organizationId: string; teamId: string; tokenVersion: number }
  published: Array<{ event: string; data: unknown }>
  /** Every request acts as this person from now on. */
  actAs: (person: Person) => void
  /** Give a person a live UOA session identity (the requester has one from the start). */
  signIn: (person: Person, identity: BriefApiFixture['identity']) => void
  request: (method: 'GET' | 'POST', url: string, body?: unknown) =>
    Promise<{ statusCode: number; body: { data?: Record<string, unknown>; error?: { code: string; details?: unknown } } }>
  briefJobs: (runId: string) => Promise<Array<{ payload: Record<string, unknown> }>>
}

export const RUNS = '/api/integrations/products/deep-water/research-runs'

const seed = async (): Promise<{ fixture: BriefApiFixture; cleanup: () => Promise<void> }> => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `dw-brief-api-${suffix}` } })
  const users = {
    requester: await prisma.user.create({ data: { displayName: 'Requester', email: `req-${suffix}@example.test` } }),
    colleague: await prisma.user.create({ data: { displayName: 'Colleague', email: `col-${suffix}@example.test` } }),
    owner: await prisma.user.create({ data: { displayName: 'Owner', email: `own-${suffix}@example.test` } }),
  }
  for (const [person, user] of Object.entries(users)) {
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id, role: person === 'owner' ? 'owner' : 'member' },
    })
  }
  const project = await prisma.project.create({ data: { name: 'Research', organizationId: organization.id } })
  const team = await prisma.team.create({
    data: {
      name: 'Research',
      projectId: project.id,
      externalOrgId: `uoa-org-${suffix}`,
      externalTeamId: `uoa-team-${suffix}`,
    },
  })
  const channel = await prisma.channel.create({
    data: {
      label: 'research', slug: `research-${suffix}`,
      organizationId: organization.id, projectId: project.id, teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const catalog = await prisma.mcpCatalogEntry.findFirstOrThrow({
    where: { name: 'deep-water', organizationId: null, visibility: 'public' },
    select: { id: true },
  })
  const connector = await prisma.mcpServerInstance.create({
    data: {
      catalogEntryId: catalog.id,
      credentialRef: 'LEDGER_PROXY_TOKEN',
      installedBy: users.owner.id,
      lifecycleState: 'active',
      organizationId: organization.id,
      scopeId: team.id,
      scopeType: 'team',
      discoveredTools: deepWaterBriefTools.map((tool) => ({ name: tool.name })),
    },
  })
  await prisma.productTeamEnablement.create({
    data: { organizationId: organization.id, teamId: team.id, productSlug: 'deep-water', enabled: true },
  })
  const identity = {
    subject: `uoa|${users.requester.id}`,
    organizationId: team.externalOrgId ?? '',
    teamId: team.externalTeamId ?? '',
    tokenVersion: 3,
  }
  await prisma.productAccountLink.create({
    data: {
      organizationId: organization.id,
      userId: users.requester.id,
      productSlug: 'deep-water',
      uoaSub: identity.subject,
      uoaTokenVersion: identity.tokenVersion,
      status: 'linked',
    },
  })

  let actor: Person = 'requester'
  const identities: Partial<Record<Person, BriefApiFixture['identity']>> = { requester: identity }
  const contextFor = (person: Person): AuthorizedActionContext => ({
    actionContext: {
      requestId: `request-${randomUUID()}`,
      teamId: team.id,
      ...(identities[person] ? { uoaIdentity: identities[person] } : {}),
    },
    actor: { actorId: users[person].id, actorType: 'user', roles: [person === 'owner' ? 'owner' : 'member'] },
    tenant: { organizationId: organization.id, projectId: project.id, teamId: team.id },
  }) as unknown as AuthorizedActionContext
  const published: BriefApiFixture['published'] = []
  const app = Fastify({ logger: false })
  registerResearchRunRoutes(app, {
    prisma,
    realtimeHub: {
      publishWs: async (_scopes: unknown, input: { event: string; data: unknown }) => {
        published.push({ event: input.event, data: input.data })
      },
    },
    requireActorContext: () => contextFor(actor),
    requireUserActor: () => true,
    loadPersonalAssistantState: async () => null,
    ledgerIdentity: { requestHeaders: async () => ({}) },
  } as unknown as RouteDeps)
  await app.ready()

  const fixture: BriefApiFixture = {
    prisma,
    app,
    ids: {
      organization: organization.id, project: project.id, team: team.id, channel: channel.id,
      thread: thread.id, connector: connector.id,
      requester: users.requester.id, colleague: users.colleague.id, owner: users.owner.id,
    },
    identity,
    published,
    actAs: (person) => { actor = person },
    signIn: (person, next) => { identities[person] = next },
    request: async (method, url, body) => {
      const response = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) })
      return { statusCode: response.statusCode, body: response.json() }
    },
    briefJobs: (runId) => prisma.$queryRawUnsafe(
      `SELECT payload FROM queue_jobs WHERE topic = 'deep_water.brief.action' AND payload->>'runId' = $1`,
      runId,
    ),
  }
  return {
    fixture,
    cleanup: async () => {
      await app.close()
      await prisma.$executeRawUnsafe(`DELETE FROM queue_jobs WHERE payload->>'organizationId' = $1`, organization.id)
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((user) => user.id) } } })
      await prisma.$disconnect()
    },
  }
}

export const withBriefApi = (name: string, body: (fixture: BriefApiFixture) => Promise<void>): void => {
  dbTest(name, async () => {
    const { fixture, cleanup } = await seed()
    try {
      await body(fixture)
    } finally {
      await cleanup()
    }
  })
}
