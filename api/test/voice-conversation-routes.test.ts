import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify, { type FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema, type AuthorizedActionContext } from '@nessie/schemas'

import { registerVoiceConversationRoutes } from '../src/routes/voice-conversation.js'

/**
 * The call's conversation bridge, which is the only way a *native* call can
 * reach the assistant at all: the voice-scoped device credential is refused on
 * the generic message routes on purpose.
 *
 * What is worth asserting is not that a row appears. It is that the row is
 * followed by everything that makes a message real — the run, the push, the
 * announcement — because the reason these routes call a shared service rather
 * than their own copy of that sequence is precisely that a copy drifts: a
 * hand-off that writes a message and never wakes the assistant looks like it
 * worked and answers nothing. So the assertions are the queue rows the message
 * produced, read back out of Postgres.
 *
 * Seed-scoped throughout: this database is shared with suites running
 * concurrently, so no global delete and no global count appears here.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  prisma: PrismaClient
  projectId: string
  published: { event: string; data: Record<string, unknown> }[]
  sessionId: string
  teamId: string
  threadId: string
  userId: string
}

const actorContextFor = (seed: Seed): AuthorizedActionContext =>
  AuthorizedActionContextSchema.parse({
    actor: { actorId: seed.userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: seed.organizationId, projectId: seed.projectId, teamId: seed.teamId },
    actionContext: { requestId: randomUUID() },
  })

const seed = async (label: string): Promise<Seed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()

  await prisma.organization.create({
    data: { id: organizationId, name: `${label}-${organizationId}` },
  })
  await prisma.user.create({
    data: { displayName: 'Caller', email: `${userId}@voice.test`, id: userId },
  })
  await prisma.organizationMember.create({ data: { organizationId, role: 'owner', userId } })
  const project = await prisma.project.create({
    data: { name: `${label} project`, organizationId },
  })
  const team = await prisma.team.create({ data: { name: `${label} team`, projectId: project.id } })

  const agent = await prisma.agent.create({
    data: {
      agentKind: 'personal_assistant',
      delegationMode: 'act_as_requesting_user',
      name: 'Personal Assistant',
      organizationId,
      surfacePolicy: 'dm_only',
      systemManaged: true,
      teamId: team.id,
    },
  })
  const channel = await prisma.channel.create({
    data: {
      dmKey: `pa:${organizationId}:${userId}`,
      label: 'Personal Assistant',
      members: { create: { userId } },
      organizationId,
      projectId: project.id,
      systemChannelType: 'personal_assistant',
      teamId: team.id,
      threads: { create: { title: 'Personal Assistant' } },
      type: 'dm',
      visibility: 'private',
    },
    select: { id: true, threads: { select: { id: true } } },
  })
  // The PA's own DM carries a plain binding — a per-user *presence* is for a
  // shared channel, and the database refuses one on a system channel.
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const installation = await prisma.voiceInstallation.create({
    data: { organizationId, platform: 'ios', userId },
  })
  const session = await prisma.voiceSession.create({
    data: {
      agentId: agent.id,
      channelId: channel.id,
      credentialExpiresAt: new Date(Date.now() + 1_800_000),
      installationId: installation.id,
      ledgerSessionId: `ledger-${randomUUID()}`,
      maxDurationMs: 1_800_000,
      maxToolCalls: 3,
      model: 'gemini-live-test',
      organizationId,
      threadId: channel.threads[0]!.id,
      userId,
    },
  })

  return {
    agentId: agent.id,
    channelId: channel.id,
    organizationId,
    prisma,
    projectId: project.id,
    published: [],
    sessionId: session.id,
    teamId: team.id,
    threadId: channel.threads[0]!.id,
    userId,
  }
}

const teardown = async (seeded: Seed): Promise<void> => {
  // Scoped to this seed's own rows. `queue_jobs` has no tenant column, so the
  // jobs are matched on the thread inside their own payload — never a `LIKE`
  // over a shared key prefix, which would delete another suite's work.
  await seeded.prisma.$executeRaw`
    DELETE FROM queue_jobs WHERE payload->>'threadId' = ${seeded.threadId}
  `
  await seeded.prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await seeded.prisma.user.deleteMany({ where: { id: seeded.userId } })
  await seeded.prisma.$disconnect()
}

/**
 * The real routes on real deps.
 *
 * Only the realtime hub is a stand-in, and it records rather than discards:
 * the announcement is one of the things the shared delivery step is supposed
 * to perform, so it has to be observable.
 */
const appFor = async (seeded: Seed, actor?: AuthorizedActionContext): Promise<FastifyInstance> => {
  const app = Fastify()
  const actorContext = actor ?? actorContextFor(seeded)
  registerVoiceConversationRoutes(
    app,
    {
      buildChannelRealtimeScopes: (input: { channelId: string }) =>
        [{ kind: 'channel', channelId: input.channelId }],
      messageMemoryCaptureConfig: null,
      prisma: seeded.prisma,
      realtimeHub: {
        publishWs: async (_scopes: unknown, input: { data: unknown; event: string }) => {
          seeded.published.push({ data: input.data as Record<string, unknown>, event: input.event })
        },
      },
      requireActorContext: () => actorContext,
      requireUserActor: () => true,
    } as never,
    { config: { voiceCredential: true } },
  )
  await app.ready()
  return app
}

const paSend = (
  app: FastifyInstance,
  sessionId: string,
  text: string,
  idempotencyKey?: string,
) =>
  app.inject({
    method: 'POST',
    payload: { text },
    url: `/api/voice/sessions/${sessionId}/pa-send`,
    ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
  })

const queuedKinds = async (prisma: PrismaClient, threadId: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<{ idempotency_key: string }[]>`
    SELECT idempotency_key FROM queue_jobs WHERE payload->>'threadId' = ${threadId}
  `
  return rows.map((row) => row.idempotency_key.split(':')[0]!).sort()
}

dbTest('a hand-off posts as the person and starts the run a typed message would', async () => {
  const seeded = await seed('voice-pa-send')
  const app = await appFor(seeded)
  try {
    const response = await paSend(app, seeded.sessionId, 'Book the flights, please.')
    assert.equal(response.statusCode, 201)
    const body = response.json().data as { messageId: string; rootMessageId: string }

    const message = await seeded.prisma.message.findUniqueOrThrow({
      where: { id: body.messageId },
    })
    // As the person, in the call's own thread: an `assistant` record would not
    // wake the PA at all, and a thread the client named would be the whole
    // point of the scope gone.
    assert.equal(message.role, 'user')
    assert.equal(message.userId, seeded.userId)
    assert.equal(message.threadId, seeded.threadId)
    assert.equal(message.content, 'Book the flights, please.')

    // A top-level hand-off is the root of the reply thread the run answers in,
    // which is what the client polls against.
    assert.equal(body.rootMessageId, body.messageId)

    // The three things that make it real. Without them the message exists and
    // nothing happens: no agent wakes, no phone rings, no open feed updates.
    assert.deepEqual(await queuedKinds(seeded.prisma, seeded.threadId), ['orchestrate', 'push'])
    assert.deepEqual(
      seeded.published.map((entry) => entry.event),
      ['message.new'],
    )
    assert.equal(seeded.published[0]?.data['messageId'], body.messageId)

    // The hand-off spends from the call's tool budget: it is a model-chosen
    // action that starts a real run.
    const after = await seeded.prisma.voiceSession.findUniqueOrThrow({
      where: { id: seeded.sessionId },
    })
    assert.equal(after.toolCallCount, 1)
  } finally {
    await app.close()
    await teardown(seeded)
  }
})

dbTest('a retried hand-off is one message, one run and one unit of budget', async () => {
  const seeded = await seed('voice-pa-send-retry')
  const app = await appFor(seeded)
  try {
    // Gemini retries a tool call it did not see answered; its own call id
    // arrives as the transport spelling of an idempotency key.
    const key = `voice-tool-${randomUUID()}`
    const first = await paSend(app, seeded.sessionId, 'Same request', key)
    const second = await paSend(app, seeded.sessionId, 'Same request', key)

    assert.equal(first.statusCode, 201)
    assert.equal(second.statusCode, 200)
    assert.equal(
      (first.json().data as { messageId: string }).messageId,
      (second.json().data as { messageId: string }).messageId,
    )

    const messages = await seeded.prisma.message.findMany({ where: { threadId: seeded.threadId } })
    assert.equal(messages.length, 1)
    assert.deepEqual(await queuedKinds(seeded.prisma, seeded.threadId), ['orchestrate', 'push'])
    const after = await seeded.prisma.voiceSession.findUniqueOrThrow({
      where: { id: seeded.sessionId },
    })
    assert.equal(after.toolCallCount, 1)
  } finally {
    await app.close()
    await teardown(seeded)
  }
})

dbTest('the call cannot start unbounded work: the tool budget covers hand-offs', async () => {
  const seeded = await seed('voice-pa-send-budget')
  const app = await appFor(seeded)
  try {
    await seeded.prisma.voiceSession.update({
      data: { toolCallCount: 3 },
      where: { id: seeded.sessionId },
    })
    const refused = await paSend(app, seeded.sessionId, 'One more thing')
    assert.equal(refused.statusCode, 429)
    assert.equal(refused.json().error.code, 'VOICE_TOOL_LIMIT')
    assert.equal(await seeded.prisma.message.count({ where: { threadId: seeded.threadId } }), 0)
  } finally {
    await app.close()
    await teardown(seeded)
  }
})

dbTest('a call that has ended cannot still hand work over', async () => {
  const seeded = await seed('voice-pa-send-ended')
  const app = await appFor(seeded)
  try {
    await seeded.prisma.voiceSession.update({
      data: { endedAt: new Date(), status: 'ended' },
      where: { id: seeded.sessionId },
    })
    const refused = await paSend(app, seeded.sessionId, 'Still there?')
    assert.equal(refused.statusCode, 409)
    assert.equal(refused.json().error.code, 'VOICE_SESSION_ENDED')
  } finally {
    await app.close()
    await teardown(seeded)
  }
})

dbTest('someone else’s call is not a thread you may write to', async () => {
  const seeded = await seed('voice-pa-send-stranger')
  const stranger = AuthorizedActionContextSchema.parse({
    actor: { actorId: randomUUID(), actorType: 'user', roles: ['member'] },
    tenant: { organizationId: seeded.organizationId, teamId: seeded.teamId },
    actionContext: { requestId: randomUUID() },
  })
  const app = await appFor(seeded, stranger)
  try {
    // Indistinguishable from a call that does not exist: a session id is a
    // global UUID and confirming one exists would leak that.
    const refused = await paSend(app, seeded.sessionId, 'Not my call')
    assert.equal(refused.statusCode, 404)
    assert.equal(refused.json().error.code, 'VOICE_SESSION_NOT_FOUND')
    assert.equal(await seeded.prisma.message.count({ where: { threadId: seeded.threadId } }), 0)
  } finally {
    await app.close()
    await teardown(seeded)
  }
})

dbTest('a credential spoken aloud is refused, exactly as a typed one is', async () => {
  const seeded = await seed('voice-pa-send-secret')
  const app = await appFor(seeded)
  try {
    const refused = await paSend(
      app,
      seeded.sessionId,
      'Store this key: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    )
    assert.equal(refused.statusCode, 422)
    assert.equal(refused.json().error.code, 'SECRET_INTERCEPTED')
    assert.equal(await seeded.prisma.message.count({ where: { threadId: seeded.threadId } }), 0)
  } finally {
    await app.close()
    await teardown(seeded)
  }
})

dbTest('the reply poll finds the answer wherever the run chose to put it', async () => {
  const seeded = await seed('voice-replies')
  const app = await appFor(seeded)
  try {
    const handoff = await paSend(app, seeded.sessionId, 'What is on my calendar?')
    const { messageId } = handoff.json().data as { messageId: string }

    // A run triggered by a top-level message answers *in that message's reply
    // thread* by default, and top-level when it judged its answer a standalone
    // contribution. Reading one lane would lose the other half the time.
    const inThread = await seeded.prisma.message.create({
      data: {
        agentId: seeded.agentId,
        content: 'Two meetings.',
        role: 'assistant',
        rootMessageId: messageId,
        threadId: seeded.threadId,
      },
    })
    const topLevel = await seeded.prisma.message.create({
      data: {
        agentId: seeded.agentId,
        content: 'And a dentist appointment.',
        role: 'assistant',
        threadId: seeded.threadId,
      },
    })
    // Neither of these is an answer to the hand-off.
    await seeded.prisma.message.create({
      data: {
        agentId: seeded.agentId,
        content: 'Retracted.',
        deletedAt: new Date(),
        role: 'assistant',
        rootMessageId: messageId,
        threadId: seeded.threadId,
      },
    })
    await seeded.prisma.message.create({
      data: {
        content: 'Something the person said next.',
        role: 'user',
        threadId: seeded.threadId,
        userId: seeded.userId,
      },
    })

    const response = await app.inject({
      method: 'GET',
      url: `/api/voice/sessions/${seeded.sessionId}/replies?after=${messageId}`,
    })
    assert.equal(response.statusCode, 200)
    const { replies } = response.json().data as {
      replies: { messageId: string; text: string }[]
    }
    assert.deepEqual(
      replies.map((entry) => entry.messageId).sort(),
      [inThread.id, topLevel.id].sort(),
    )
    assert.ok(replies.some((entry) => entry.text === 'Two meetings.'))
  } finally {
    await app.close()
    await teardown(seeded)
  }
})

dbTest('a reply poll cannot read a message from a conversation the call is not in', async () => {
  const seeded = await seed('voice-replies-foreign')
  const other = await seeded.prisma.channel.create({
    data: {
      label: 'Elsewhere',
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      slug: `elsewhere-${randomUUID()}`,
      teamId: seeded.teamId,
      threads: { create: { title: 'General' } },
    },
    select: { threads: { select: { id: true } } },
  })
  const foreign = await seeded.prisma.message.create({
    data: {
      content: 'In another room entirely.',
      role: 'user',
      threadId: other.threads[0]!.id,
      userId: seeded.userId,
    },
  })
  const app = await appFor(seeded)
  try {
    // `after` is scoped to the call's own thread, so it cannot be used to
    // establish where a message sits in a conversation this call is not part of.
    const response = await app.inject({
      method: 'GET',
      url: `/api/voice/sessions/${seeded.sessionId}/replies?after=${foreign.id}`,
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error.code, 'VOICE_REPLY_ANCHOR_NOT_FOUND')
  } finally {
    await app.close()
    await teardown(seeded)
  }
})
