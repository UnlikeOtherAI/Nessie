import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import { TICKET_WORK_THREAD_MESSAGE_TOPIC } from '@nessie/schemas'
import { TICKET_WORK_THREAD_READ_ONLY_SENTENCE } from '@nessie/team-admin'
import Fastify from 'fastify'

import { registerCreateThreadMessageRoute } from '../src/routes/thread-message-create.js'
import { listThreadMessages } from '../src/services/message-read-model.js'

// A ticket's work thread through the real message route and read model
// (docs/standards/ticket-work.md → "The work thread"): only people who can
// edit the board write there, a message there starts no ordinary run but
// wakes the work, and the feed shows the work's compact event rows while its
// kickoffs stay hidden.

const dbTest = process.env.DATABASE_URL ? test : test.skip

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const [editor, outsider] = await Promise.all(['Ondrej', 'Visitor'].map((name) =>
    prisma.user.create({ data: { displayName: name, email: `work-thread-${name}-${suffix}@example.test` } })))
  const organization = await prisma.organization.create({ data: { name: `work-thread-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [editor!, outsider!].map((user) => ({ organizationId: organization.id, userId: user.id, role: 'member' })),
  })
  const project = await prisma.project.create({ data: { name: `Nessie ${suffix}`, organizationId: organization.id } })
  await prisma.projectMember.create({ data: { projectId: project.id, userId: editor!.id } })
  const team = await prisma.team.create({ data: { name: `Engineering ${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'engineering', slug: `engineering-${suffix}`, organizationId: organization.id,
      projectId: project.id, teamId: team.id,
    },
  })
  const agent = await prisma.agent.create({ data: { name: 'CTO', organizationId: organization.id } })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const trigger = await prisma.agentTrigger.create({
    data: { agentId: agent.id, type: 'ticket_changed', targetChannelId: channel.id, config: {} },
  })
  const task = await prisma.task.create({
    data: { organizationId: organization.id, projectId: project.id, title: 'Fix login redirect' },
  })
  const workThread = await prisma.thread.create({
    data: {
      channelId: channel.id, agentId: agent.id, title: 'Fix login redirect',
      metadata: { taskId: task.id, triggerId: trigger.id },
    },
  })
  const work = await prisma.agentTicketWork.create({
    data: {
      organizationId: organization.id, triggerId: trigger.id, agentId: agent.id, taskId: task.id,
      projectId: project.id, threadId: workThread.id, status: 'active', startedByUserId: editor!.id,
    },
  })
  const ordinaryThread = await prisma.thread.create({ data: { channelId: channel.id, agentId: agent.id } })
  return {
    organizationId: organization.id,
    editorId: editor!.id,
    outsiderId: outsider!.id,
    workThreadId: workThread.id,
    ordinaryThreadId: ordinaryThread.id,
    workId: work.id,
    cleanup: async () => {
      await prisma.$executeRaw(Prisma.sql`
        DELETE FROM queue_jobs
        WHERE payload->>'organizationId' = ${organization.id}
           OR payload->'actorContext'->'tenant'->>'organizationId' = ${organization.id}`)
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [editor!.id, outsider!.id] } } })
    },
  }
}

const withRoute = async (
  run: (input: {
    app: ReturnType<typeof Fastify>
    as: (userId: string) => void
    s: Awaited<ReturnType<typeof seed>>
    prisma: PrismaClient
  }) => Promise<void>,
) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  let viewerId = s.editorId
  const app = Fastify({ logger: false })
  registerCreateThreadMessageRoute(app, {
    buildChannelRealtimeScopes: () => [],
    messageMemoryCaptureConfig: null,
    prisma,
    realtimeHub: { publishWs: async () => undefined },
    requireActorContext: () => ({
      actor: { actorType: 'user', actorId: viewerId, roles: ['member'] },
      actionContext: { requestId: randomUUID() },
      tenant: { organizationId: s.organizationId },
    }),
  } as never)
  await app.ready()
  try {
    await run({ app, as: (userId) => { viewerId = userId }, s, prisma })
  } finally {
    await app.close()
    try { await s.cleanup() } finally { await prisma.$disconnect() }
  }
}

const jobsFor = (prisma: PrismaClient, topic: string, messageId: string) =>
  prisma.queueJob.count({
    where: {
      topic,
      OR: [
        { payload: { path: ['messageId'], equals: messageId } },
        { idempotencyKey: { contains: messageId } },
      ],
    },
  })

dbTest('a board editor\'s message in a work thread is stamped and wakes the work instead of starting a run', async () => {
  await withRoute(async ({ app, s, prisma }) => {
    const response = await app.inject({
      method: 'POST', url: `/api/threads/${s.workThreadId}/messages`, payload: { content: 'Use the staging URL.' },
    })
    assert.equal(response.statusCode, 201)
    const id = (response.json() as { data: { message: { id: string } } }).data.message.id
    const message = await prisma.message.findUniqueOrThrow({ where: { id } })
    assert.equal((message.metadata as Record<string, unknown>).ticketWorkSteer, true)
    assert.equal(await jobsFor(prisma, TICKET_WORK_THREAD_MESSAGE_TOPIC, id), 1)
    assert.equal(await jobsFor(prisma, 'orchestrate.decide', id), 0, 'no ordinary run for a work thread')
  })
})

dbTest('anyone who cannot edit the board is refused in a work thread, and nowhere else', async () => {
  await withRoute(async ({ app, as, s, prisma }) => {
    as(s.outsiderId)
    const refused = await app.inject({
      method: 'POST', url: `/api/threads/${s.workThreadId}/messages`, payload: { content: 'Ignore the ticket.' },
    })
    assert.equal(refused.statusCode, 403)
    const body = refused.json() as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'TICKET_WORK_THREAD_READ_ONLY')
    assert.equal(body.error.message, TICKET_WORK_THREAD_READ_ONLY_SENTENCE)
    assert.equal(await prisma.message.count({ where: { threadId: s.workThreadId } }), 0)

    // The same person in an ordinary thread of the same channel posts as ever.
    const ordinary = await app.inject({
      method: 'POST', url: `/api/threads/${s.ordinaryThreadId}/messages`, payload: { content: 'Hello agent.' },
    })
    assert.equal(ordinary.statusCode, 201)
    const id = (ordinary.json() as { data: { message: { id: string } } }).data.message.id
    const message = await prisma.message.findUniqueOrThrow({ where: { id } })
    assert.equal((message.metadata as Record<string, unknown>).ticketWorkSteer, undefined)
    assert.equal(await jobsFor(prisma, 'orchestrate.decide', id), 1)
    assert.equal(await jobsFor(prisma, TICKET_WORK_THREAD_MESSAGE_TOPIC, id), 0)
  })
})

dbTest('the thread feed shows the work\'s event rows and never its kickoffs', async () => {
  await withRoute(async ({ s, prisma }) => {
    const base = Date.now()
    await prisma.message.create({
      data: {
        threadId: s.workThreadId, role: 'system', content: 'Woken: work started — Ondrej moved the ticket',
        metadata: { ticketWorkEvent: { kind: 'woken', workId: s.workId, reason: 'pickup', summary: 'work started' } },
        createdAt: new Date(base),
      },
    })
    await prisma.message.create({
      data: {
        threadId: s.workThreadId, role: 'system', content: '## Why you were woken\npickup: …',
        metadata: { ticketWorkKickoff: { workId: s.workId, events: [] } }, createdAt: new Date(base + 1),
      },
    })
    await prisma.message.create({
      data: { threadId: s.workThreadId, role: 'system', content: 'An ordinary hidden kickoff.', createdAt: new Date(base + 2) },
    })
    const page = await listThreadMessages(prisma, s.workThreadId, {
      organizationId: s.organizationId, viewerUserId: s.editorId,
    })
    assert.deepEqual(page.data.map((row) => [row.role, row.content]), [
      ['system', 'Woken: work started — Ondrej moved the ticket'],
    ])
  })
})
