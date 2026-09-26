import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, request as httpRequest, type Server } from 'node:http'

import { Prisma, type PrismaClient } from '@prisma/client'
import type { MockScenario } from '@nessie/mock-llm'
import { EMBEDDING_DIMENSIONS, RunExecuteJobPayloadSchema } from '@nessie/schemas'

import { runDatabaseTest } from './support.js'

// A scheduled post into a public room, end to end through the real trigger
// fire and run executor, with only inference pointed at the mock provider.
//
// Seen live: a "Morning Joke" agent's daily joke in #random recalled its
// owner's DM with the agent — the schedule reads as its owner — and every joke
// was withheld from everyone else in the room, with a card telling the owner
// its sources were private. Deleting the DM would not have helped: each joke
// inherited the stamp from the one before it through the room's own history.
// docs/standards/disclosure-boundaries.md → "Assembled context never restricts
// a reply".
//
// Model config must be in place before any worker module loads, so every
// worker import is dynamic, as in `ticket-work-run.test.ts`.

process.env['NESSIE_MODEL_PROVIDER'] ??= 'openai'
process.env['NESSIE_MODEL_API_KEY'] ??= 'mock-token'
process.env['OPENAI_API_KEY'] ??= 'mock-token'
process.env['NESSIE_DB_URL'] ??= process.env['DATABASE_URL'] ?? ''

const DM_TEXT = 'Try one on me first: tell me a joke about my divorce lawyer.'
const STAMPED_JOKE = 'What do you call a fake noodle? An impasta.'

let reply = 'Nothing to say.'
// The engine picks its turn by the assistant turns already in the window.
const scenarioFor = (text: string, parse: (input: unknown) => MockScenario): MockScenario =>
  parse({ name: 'joke', turns: Array.from({ length: 30 }, () => ({ latencyMs: 0, text })) })

// What the model was sent, read off the wire between the worker and the mock.
const requests: string[] = []
const startRecordingProxy = async (target: string): Promise<{ server: Server; url: string }> => {
  const upstream = new URL(target)
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const body = Buffer.concat(chunks)
      if ((incoming.url ?? '').includes('/chat/completions')) requests.push(body.toString('utf8'))
      const forward = httpRequest({
        headers: incoming.headers,
        host: upstream.hostname,
        method: incoming.method,
        path: incoming.url,
        port: upstream.port,
      }, (proxied) => {
        outgoing.writeHead(proxied.statusCode ?? 500, proxied.headers)
        proxied.pipe(outgoing)
      })
      forward.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` }
}

const seed = async (prisma: PrismaClient, pool: { query: (sql: string, params: unknown[]) => Promise<unknown> }, embeddingModel: string) => {
  const suffix = randomUUID()
  const [owner, colleague] = await Promise.all(['Ondrej', 'Colleague'].map((name) =>
    prisma.user.create({ data: { displayName: name, email: `scheduled-post-${name}-${suffix}@example.test` } })))
  const organization = await prisma.organization.create({ data: { name: `scheduled-post-${suffix}` } })
  const people = [owner!, colleague!]
  await prisma.organizationMember.createMany({
    data: people.map((user) => ({ organizationId: organization.id, role: 'member', userId: user.id })),
  })
  const project = await prisma.project.create({ data: { name: `Company ${suffix}`, organizationId: organization.id } })
  await prisma.projectMember.createMany({ data: people.map((user) => ({ projectId: project.id, userId: user.id })) })
  const team = await prisma.team.create({ data: { name: `Everyone ${suffix}`, projectId: project.id } })
  await prisma.teamMember.createMany({ data: people.map((user) => ({ teamId: team.id, userId: user.id })) })
  const random = await prisma.channel.create({
    data: {
      label: 'random',
      organizationId: organization.id,
      projectId: project.id,
      slug: `random-${suffix}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'public',
    },
  })
  await prisma.channelMember.createMany({ data: people.map((user) => ({ channelId: random.id, userId: user.id })) })
  const roomThread = await prisma.thread.create({ data: { channelId: random.id } })
  const agent = await prisma.agent.create({
    data: {
      name: 'Morning Joke',
      organizationId: organization.id,
      ownerUserId: owner!.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: random.id } })

  // The owner tried the agent out in its DM before scheduling it, and that
  // conversation is indexed like any other.
  const { ensureSharedAgentDm } = await import('@nessie/team-admin')
  const dmId = await ensureSharedAgentDm(prisma, {
    agentId: agent.id,
    agentName: agent.name,
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
    userId: owner!.id,
  })
  const dmThread = await prisma.thread.create({ data: { agentId: agent.id, channelId: dmId } })
  const dmTurns = [
    await prisma.message.create({
      data: { content: DM_TEXT, role: 'user', threadId: dmThread.id, userId: owner!.id },
    }),
    await prisma.message.create({
      data: {
        agentId: agent.id,
        content: 'Your lawyer bills by the hour, so this one is free.',
        role: 'assistant',
        threadId: dmThread.id,
      },
    }),
  ]
  // The mock provider embeds every text alike, so these are the query's
  // nearest neighbours.
  const vector = `[${[1, ...Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0)].join(',')}]`
  for (const turn of dmTurns) {
    await pool.query(
      `INSERT INTO message_embeddings (id, message_id, content_hash, embedding, embedding_model, dims, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3::vector, $4, $5, 'indexed', now(), now())`,
      [turn.id, createHash('sha256').update(turn.content, 'utf8').digest('hex'), vector, embeddingModel, EMBEDDING_DIMENSIONS],
    )
  }

  const config = {
    createdByUserId: owner!.id,
    launchOrigin: { organizationId: organization.id, projectId: project.id, teamId: team.id, userId: owner!.id },
    prompt: 'Post one short, original joke to start the day.',
  }
  const trigger = await prisma.agentTrigger.create({
    data: { agentId: agent.id, config, targetChannelId: random.id, targetThreadId: roomThread.id, type: 'scheduled' },
  })

  return {
    agentId: agent.id,
    colleagueId: colleague!.id,
    config,
    dmId,
    organizationId: organization.id,
    ownerId: owner!.id,
    projectId: project.id,
    roomId: random.id,
    roomThreadId: roomThread.id,
    teamId: team.id,
    triggerId: trigger.id,
    cleanup: async () => {
      await prisma.$executeRaw(Prisma.sql`
        DELETE FROM queue_jobs
        WHERE payload->>'organizationId' = ${organization.id}
           OR payload->'actorContext'->'tenant'->>'organizationId' = ${organization.id}`)
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: people.map((user) => user.id) } } })
    },
  }
}

runDatabaseTest('a scheduled post into a public room', async (t) => {
  const { createMockLlmServer, parseScenario } = await import('@nessie/mock-llm')
  const mock = await createMockLlmServer({
    scenario: scenarioFor(reply, parseScenario),
    mainScenarioResolver: () => scenarioFor(reply, parseScenario),
  })
  const proxy = await startRecordingProxy(mock.url)
  process.env['NESSIE_MODEL_BASE_URL'] = `${proxy.url}/v1`
  const { startMockPipeline } = await import('../../test-harness/pipeline.js')
  const pipeline = await startMockPipeline({ workers: 0 })
  const { executeRunJob } = await import('../../src/run/execute.js')
  const { queueTriggerRun } = await import('../../src/control/trigger-run.js')
  const { partitionByDisclosure, resolveDisclosureViewer } = await import('@nessie/runtime')
  const prisma = pipeline.prisma
  t.after(async () => {
    await pipeline.stop()
    await new Promise<void>((resolve) => proxy.server.close(() => resolve()))
    await mock.close()
  })

  type Fixture = Awaited<ReturnType<typeof seed>>
  const withFixture = async (
    st: { after: (fn: () => Promise<void>) => void },
    body: (s: Fixture) => Promise<void>,
  ): Promise<void> => {
    const s = await seed(prisma, pipeline.pool, pipeline.deps.modelClient.embeddingModel)
    st.after(s.cleanup)
    await body(s)
  }

  const execute = async (runId: string, text: string) => {
    reply = text
    requests.length = 0
    const job = await prisma.queueJob.findFirstOrThrow({
      where: { topic: 'run.execute', payload: { path: ['runId'], equals: runId } },
    })
    await executeRunJob(pipeline.deps, RunExecuteJobPayloadSchema.parse(job.payload), { attempt: 1, maxAttempts: 3 })
    assert.equal((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status, 'completed')
    const posted = await prisma.message.findFirstOrThrow({
      where: { agentId: { not: null }, content: text, role: 'assistant' },
      include: { basisScopes: true, disclosureSources: true },
    })
    return { posted, sent: requests.join('\n') }
  }

  // The fire the scheduler makes, admission and all.
  const fire = async (s: Fixture, text: string) => {
    await queueTriggerRun(prisma, {
      admissionPolicy: 'scheduled_fail_closed',
      dedupeKey: `${s.triggerId}:${randomUUID()}`,
      payload: { scheduledFor: new Date().toISOString() },
      source: 'scheduler',
      trigger: {
        agent: { agentKind: 'shared', organizationId: s.organizationId, projectId: s.projectId, teamId: s.teamId },
        agentId: s.agentId,
        config: s.config,
        id: s.triggerId,
        targetChannelId: s.roomId,
        targetThreadId: s.roomThreadId,
        type: 'scheduled',
      },
    })
    const run = await prisma.run.findFirstOrThrow({ where: { triggerId: s.triggerId }, orderBy: { createdAt: 'desc' } })
    return execute(run.id, text)
  }

  // The owner's own live turn in the room, as the channel route starts one.
  const ask = async (s: Fixture, question: string, text: string) => {
    const asked = await prisma.message.create({
      data: { content: question, role: 'user', threadId: s.roomThreadId, userId: s.ownerId },
    })
    const run = await prisma.run.create({
      data: { agentId: s.agentId, threadId: s.roomThreadId, triggerMessageId: asked.id },
    })
    const task = await prisma.task.create({
      data: { agentId: s.agentId, organizationId: s.organizationId, projectId: s.projectId, runId: run.id, title: 'ask' },
    })
    await prisma.queueJob.create({
      data: {
        payload: RunExecuteJobPayloadSchema.parse({
          actorContext: {
            actor: { actorId: s.ownerId, actorType: 'user', roles: ['member'] },
            actionContext: {
              agentId: s.agentId,
              channelId: s.roomId,
              correlationId: randomUUID(),
              effectiveUserId: s.ownerId,
              requestId: randomUUID(),
              taskId: task.id,
              teamId: s.teamId,
              threadId: s.roomThreadId,
            },
            tenant: { channelId: s.roomId, organizationId: s.organizationId, projectId: s.projectId, teamId: s.teamId },
          },
          agentId: s.agentId,
          interactive: true,
          messageId: asked.id,
          runId: run.id,
          taskId: task.id,
          threadId: s.roomThreadId,
        }) as unknown as Prisma.InputJsonValue,
        topic: 'run.execute',
      },
    })
    return execute(run.id, text)
  }

  const readableBy = async (s: Fixture, userId: string, message: { basisScopes: { scopeId: string; scopeType: string }[] }) =>
    partitionByDisclosure([message], await resolveDisclosureViewer(prisma, s.organizationId, userId)).visible.length === 1

  // A post the room already holds, stamped from the owner's DM the way every
  // joke was before this fix.
  const seedStampedPost = (s: Fixture) => prisma.message.create({
    data: {
      agentId: s.agentId,
      basisScopes: { create: { organizationId: s.organizationId, scopeId: s.dmId, scopeType: 'channel' } },
      content: STAMPED_JOKE,
      disclosureSources: {
        create: { organizationId: s.organizationId, sourceAuthorUserId: s.ownerId, sourceChannelId: s.dmId },
      },
      role: 'assistant',
      threadId: s.roomThreadId,
    },
  })

  await t.test('recalls none of its owner\'s DM with the agent, and the whole room reads it', async (st) => {
    await withFixture(st, async (s) => {
      const { posted, sent } = await fire(s, 'Why did the math book look sad? It had too many problems.')
      assert.ok(!sent.includes(DM_TEXT), 'the owner\'s DM never reaches the model')
      assert.deepEqual(posted.basisScopes, [])
      assert.deepEqual(posted.disclosureSources, [])
      assert.equal(await readableBy(s, s.colleagueId, posted), true)
    })
  })

  await t.test('one restricted post no longer keeps the next one restricted', async (st) => {
    await withFixture(st, async (s) => {
      await seedStampedPost(s)
      const { posted, sent } = await fire(s, 'Why don\'t scientists trust atoms? Because they make up everything.')
      assert.ok(!sent.includes(STAMPED_JOKE), 'the room\'s restricted post is withheld from the schedule')
      assert.deepEqual(posted.basisScopes, [])
      assert.equal(await readableBy(s, s.colleagueId, posted), true)
    })
  })

  await t.test('its owner\'s live turn still continues the restricted post, restricted', async (st) => {
    await withFixture(st, async (s) => {
      await seedStampedPost(s)
      const { posted, sent } = await ask(s, 'Explain that one?', 'It is a pun on imposter.')
      assert.ok(sent.includes(STAMPED_JOKE), 'a live requester keeps the history they may read')
      assert.deepEqual(posted.basisScopes.map(({ scopeId, scopeType }) => ({ scopeId, scopeType })), [
        { scopeId: s.dmId, scopeType: 'channel' },
      ])
      assert.equal(await readableBy(s, s.ownerId, posted), true)
      assert.equal(await readableBy(s, s.colleagueId, posted), false)
    })
  })
})
