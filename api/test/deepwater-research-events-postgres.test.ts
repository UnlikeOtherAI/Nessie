import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { applyDeepWaterScopeResult, insertDeepWaterBriefRun, readDeepWaterBriefRun } from '@nessie/runtime'
import { DeepWaterResearchEventJobPayloadSchema, LedgerScopeBriefSchema, type WsScope } from '@nessie/schemas'
import { handleDeepWaterResearchEvent, type DeepWaterWatchDeps } from '@nessie/worker'
import Fastify from 'fastify'

import { registerGlobalAuthHook } from '../src/lib/global-auth-hook.js'
import { registerRawBodyJsonParser } from '../src/lib/raw-body-json-parser.js'
import { DEEP_WATER_EVENTS_PATH, registerDeepWaterEventRoutes } from '../src/routes/integrations/deep-water-events.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * DeepWater's research events end to end (Water plan amendments-streaming S2):
 * a body shaped exactly like DeepWater's published example, signed as
 * DeepWater signs it, posted to the real receiver behind the real global auth
 * hook with no session, queued, and handled by the worker's own handler — the
 * progress lands on the run and `integration.run.updated` is published to the
 * requester. The receiver's other answers (503, 401, 400, the two
 * `accepted: false` reasons, a resent event) are pinned beside it.
 *
 * DB-backed: resolution and the queue key are Postgres facts. Everything this
 * suite writes hangs off its own organisation.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const SECRET = 'nessie-events-e2e-secret-0123456789abcdefghij'

const examples = (JSON.parse(readFileSync(
  new URL('./fixtures/deepwater-research-event.v1.examples.json', import.meta.url),
  'utf8',
)) as { examples: Record<string, Record<string, unknown>> }).examples

type Seed = {
  organizationId: string
  teamId: string
  requesterId: string
  runId: string
  rs: string
  cleanup: () => Promise<void>
}

/** A person's research, launched and running, on a team with a DeepWater connector. */
const seedRunningResearch = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `dw-events-${suffix}` } })
  const requester = await prisma.user.create({ data: { displayName: 'Requester', email: `dw-ev-${suffix}@example.test` } })
  const project = await prisma.project.create({ data: { name: 'Research', organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: 'Research', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: { label: 'research', slug: `research-${suffix}`, organizationId: organization.id, projectId: project.id, teamId: team.id },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const catalog = await prisma.mcpCatalogEntry.findFirstOrThrow({
    where: { name: 'deep-water', organizationId: null, visibility: 'public' },
    select: { id: true },
  })
  const connector = await prisma.mcpServerInstance.create({
    data: {
      catalogEntryId: catalog.id, credentialRef: 'LEDGER_PROXY_TOKEN', installedBy: requester.id,
      lifecycleState: 'active', organizationId: organization.id, scopeId: team.id, scopeType: 'team',
    },
  })
  const { run } = await prisma.$transaction((tx) => insertDeepWaterBriefRun(tx, {
    organizationId: organization.id,
    teamId: team.id,
    connectorId: connector.id,
    requestedByUserId: requester.id,
    channelId: channel.id,
    threadId: thread.id,
    identity: { subject: `uoa|${requester.id}`, organizationId: 'uoa-org', teamId: 'uoa-team', tokenVersion: 1 },
    input: {
      schemaVersion: 1, topic: 'EV battery recycling in Europe', context: null, pillars: null,
      settings: null, originRootMessageId: null,
    },
    sourceScopes: [],
    disclosureSources: [],
    origin: { kind: 'person', actionId: randomUUID() },
  }))
  const rs = `rs_${randomUUID().replaceAll('-', '')}`
  await prisma.$transaction((tx) => applyDeepWaterScopeResult(tx, {
    organizationId: organization.id,
    runId: run.id,
    result: {
      id: rs, status: 'running', errorCode: null, title: 'EV battery recycling in Europe', turn: null,
      brief: LedgerScopeBriefSchema.parse({
        state: 'launched', revision: 2, topic: 'EV battery recycling in Europe', reply: null, pillars: ['Costs'],
        settings: {
          depth: 'light', chapter_depth: 'standard', search_quality: 'standard', languages: [],
          output_language: 'en', recency: 'any', writing_style: 'standard',
        },
        locked_settings: [], open_questions: [], analysis: null, ready: true,
      }),
    },
  }))
  return {
    organizationId: organization.id,
    teamId: team.id,
    requesterId: requester.id,
    runId: run.id,
    rs,
    cleanup: async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM queue_jobs WHERE payload->>'organizationId' = $1`, organization.id)
      await prisma.organization.delete({ where: { id: organization.id } })
      await prisma.user.delete({ where: { id: requester.id } })
    },
  }
}

/** The receiver as production mounts it: JSON kept raw, behind the global auth hook, with no session. */
const createReceiverApp = async (prisma: PrismaClient) => {
  const app = Fastify()
  registerRawBodyJsonParser(app)
  registerGlobalAuthHook(app, {
    authenticateRequest: (async (_request: unknown, reply: { code: (status: number) => { send: (body: unknown) => void } }) => {
      reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Sign in.' } })
    }) as never,
    config: { api: { rateLimit: {} } } as never,
    rateLimiter: { guard: async () => ({ allowed: true }) } as never,
    prisma,
  })
  registerDeepWaterEventRoutes(app, {
    prisma,
    readFirstHeader: (request, names) => {
      for (const name of names) {
        const value = request.headers[name]
        const first = Array.isArray(value) ? value[0] : value
        if (first) return first
      }
      return undefined
    },
  } as Pick<RouteDeps, 'prisma' | 'readFirstHeader'>)
  await app.ready()
  return app
}

/** DeepWater's example of `type`, addressed to this seed and sent now. */
const exampleFor = (seed: Seed, type: string, overrides: Record<string, unknown> = {}) => {
  const body = structuredClone(examples[type]) as Record<string, any>
  body.event_id = `evt_${randomUUID().replaceAll('-', '')}`
  body.sent_at = new Date().toISOString()
  body.research.ledger_research_id = seed.rs
  body.nessie = { ...body.nessie, organization_id: seed.organizationId, team_id: seed.teamId, user_id: seed.requesterId,
    run_id: seed.runId, agent_id: null, tool_call_id: null, thread_id: null }
  return { ...body, ...overrides }
}

const post = (app: Awaited<ReturnType<typeof createReceiverApp>>, body: Record<string, any>, secret = SECRET) => {
  const raw = JSON.stringify(body)
  return app.inject({
    method: 'POST',
    url: DEEP_WATER_EVENTS_PATH,
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-deepwater-event-id': String(body.event_id),
      'x-deepwater-signature': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
  })
}

const eventJobs = (prisma: PrismaClient, organizationId: string) => prisma.queueJob.findMany({
  where: { topic: 'deep_water.research.event', payload: { path: ['organizationId'], equals: organizationId } },
})

const withReceiver = (name: string, body: (context: {
  prisma: PrismaClient
  app: Awaited<ReturnType<typeof createReceiverApp>>
  seed: Seed
}) => Promise<void>) => {
  dbTest(name, async () => {
    const previous = process.env.DEEPWATER_EVENTS_SECRET
    process.env.DEEPWATER_EVENTS_SECRET = SECRET
    const prisma = new PrismaClient()
    const seed = await seedRunningResearch(prisma)
    const app = await createReceiverApp(prisma)
    try {
      await body({ prisma, app, seed })
    } finally {
      await app.close()
      await seed.cleanup()
      await prisma.$disconnect()
      if (previous === undefined) delete process.env.DEEPWATER_EVENTS_SECRET
      else process.env.DEEPWATER_EVENTS_SECRET = previous
    }
  })
}

withReceiver('a signed progress event reaches the run\'s card: queued, stored and announced', async ({ prisma, app, seed }) => {
  const sent = exampleFor(seed, 'research.progress')
  const response = await post(app, sent)
  assert.equal(response.statusCode, 202, response.body)
  assert.deepEqual(response.json(), { accepted: true })

  const [job, ...more] = await eventJobs(prisma, seed.organizationId)
  assert.equal(more.length, 0)
  assert.equal(job?.idempotencyKey, `deep-water-event:${sent.event_id}`)
  const payload = DeepWaterResearchEventJobPayloadSchema.parse(job?.payload)
  assert.equal(payload.runId, seed.runId)

  // The worker handles the queued job with its own handler.
  const published: Array<{ scopes: WsScope[]; event: string; data: unknown }> = []
  const deps: DeepWaterWatchDeps = {
    prisma,
    ledgerIdentity: null,
    embeddingModel: null,
    fileService: {
      store: async () => { throw new Error('progress stores no file') },
      delete: async () => { throw new Error('progress deletes no file') },
      openStream: async () => null,
    },
    realtime: {
      publishWs: async (scopes, input) => {
        published.push({ scopes, event: input.event, data: input.data })
        return { type: 'event', event: input.event, data: input.data, ts: new Date().toISOString() } as never
      },
    },
  }
  await handleDeepWaterResearchEvent(deps, payload)

  const run = await readDeepWaterBriefRun(prisma, { organizationId: seed.organizationId, runId: seed.runId })
  assert.deepEqual(run?.scopeState?.progress, {
    phase: 'gathering', note: 'Finding and reading sources', percent: 40, sourcesFound: 23, at: '2026-09-23T10:15:00.000Z',
  })
  assert.ok(run?.lastEventAt)
  assert.deepEqual(published, [{
    scopes: [{ kind: 'user', organizationId: seed.organizationId, userId: seed.requesterId }],
    event: 'integration.run.updated',
    data: { productSlug: 'deep-water', runId: seed.runId },
  }])
})

withReceiver('a resent event is queued once; an event about nothing Nessie holds is not accepted', async ({ prisma, app, seed }) => {
  const sent = exampleFor(seed, 'research.completed')
  assert.equal((await post(app, sent)).statusCode, 202)
  // DeepWater re-signs every attempt with a fresh sent_at; the event id stays.
  assert.equal((await post(app, { ...sent, sent_at: new Date(Date.now() + 1_000).toISOString() })).statusCode, 202)
  assert.equal((await eventJobs(prisma, seed.organizationId)).length, 1)

  const elsewhere = exampleFor(seed, 'research.failed')
  elsewhere.nessie = { ...elsewhere.nessie, organization_id: randomUUID() }
  const notFound = await post(app, elsewhere)
  assert.equal(notFound.statusCode, 200)
  assert.deepEqual(notFound.json(), { accepted: false, reason: 'run_not_found' })

  const launcherResearch = `rs_${randomUUID().replaceAll('-', '')}`
  await prisma.productIntegrationRun.create({
    data: {
      organizationId: seed.organizationId, teamId: seed.teamId, productSlug: 'deep-water', status: 'running',
      externalRunId: launcherResearch,
    },
  })
  const legacy = exampleFor(seed, 'research.progress')
  legacy.research = { ...legacy.research, ledger_research_id: launcherResearch }
  assert.deepEqual((await post(app, legacy)).json(), { accepted: false, reason: 'legacy_run' })
  assert.equal((await eventJobs(prisma, seed.organizationId)).length, 1, 'nothing more was queued')
})

withReceiver('the receiver refuses what it cannot trust, and says so in DeepWater\'s terms', async ({ prisma, app, seed }) => {
  const wrongKey = await post(app, exampleFor(seed, 'research.progress'), `${SECRET}-other`)
  assert.equal(wrongKey.statusCode, 401)
  assert.equal(wrongKey.json().error.code, 'DEEP_WATER_EVENT_SIGNATURE_INVALID')

  const stale = await post(app, exampleFor(seed, 'research.progress', {
    sent_at: new Date(Date.now() - 11 * 60_000).toISOString(),
  }))
  assert.equal(stale.statusCode, 401)
  assert.equal(stale.json().error.code, 'DEEP_WATER_EVENT_STALE')
  const future = await post(app, exampleFor(seed, 'research.progress', {
    sent_at: new Date(Date.now() + 11 * 60_000).toISOString(),
  }))
  assert.equal(future.json().error.code, 'DEEP_WATER_EVENT_STALE')

  const malformed = await post(app, exampleFor(seed, 'research.progress', { turn: { turn_id: randomUUID(), status: 'complete', revision: 1 } }))
  assert.equal(malformed.statusCode, 400)
  assert.equal(malformed.json().error.code, 'DEEP_WATER_EVENT_MALFORMED')
  assert.equal((await eventJobs(prisma, seed.organizationId)).length, 0)

  // No key configured: 503, which DeepWater retries until the deploy installs one.
  delete process.env.DEEPWATER_EVENTS_SECRET
  const unconfigured = await post(app, exampleFor(seed, 'research.progress'))
  assert.equal(unconfigured.statusCode, 503)
  assert.equal(unconfigured.json().error.code, 'DEEP_WATER_EVENTS_UNCONFIGURED')
})
