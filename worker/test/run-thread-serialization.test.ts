import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseOrganizationId,
  parseProjectId,
  parseRunId,
  parseTaskId,
  parseTeamId,
  parseThreadId,
  type AuthorizedActionContext,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import {
  claimThreadRunOrPend,
  drainPendingThreadMessages,
  sweepPendingThreadMessages,
} from '../src/run/thread-serialization.js'
import { finalizeCancelledRun } from '../src/run/execute/cancel-stop.js'
import type {
  ExecutionDependencies,
  RunContext,
} from '../src/run/execute/types.js'

// Integration tests against the local Postgres (see AGENTS.md): the invariant
// under test — at most one in-flight run per (agent, thread), with mid-run
// messages batched into one durable follow-up — only exists in the database.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  channelId: string
  threadId: string
  agentId: string
  userId: string
}

const seedWorkspace = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `run-ser ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const user = await prisma.user.create({
    data: { email: `run-ser-${randomUUID()}@example.com`, displayName: 'Owner' },
  })
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      slug: `c-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({ data: { name: 'A', organizationId: org.id } })
  return {
    organizationId: org.id,
    projectId: project.id,
    teamId: team.id,
    channelId: channel.id,
    threadId: thread.id,
    agentId: agent.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  await prisma.$executeRaw`DELETE FROM queue_jobs WHERE idempotency_key LIKE ${'run:batch:%'}`
    .catch(() => undefined)
  await prisma.runThreadPendingMessage.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.taskEvent.deleteMany({ where: { task: { organizationId: seed.organizationId } } })
  await prisma.task.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.message.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.run.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.thread.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.channel.deleteMany({ where: { id: seed.channelId } })
  await prisma.agent.deleteMany({ where: { id: seed.agentId } })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.user.deleteMany({ where: { id: seed.userId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

const actorFor = (seed: Seed): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: seed.userId, roles: ['owner'] },
  tenant: {
    organizationId: parseOrganizationId(seed.organizationId),
    projectId: parseProjectId(seed.projectId),
    teamId: parseTeamId(seed.teamId),
  },
  actionContext: {
    requestId: `req-${randomUUID()}`,
    teamId: parseTeamId(seed.teamId),
  },
})

const postMessage = async (
  prisma: PrismaClient,
  seed: Seed,
  content: string,
): Promise<{ id: string; content: string }> => {
  return prisma.message.create({
    data: { threadId: seed.threadId, role: 'user', content, userId: seed.userId },
    select: { id: true, content: true },
  })
}

// Mirrors the orchestrate.decide reply path: claim the (agent, thread) slot
// and, only when claimed, create the run + task in the same transaction.
const decideReplyForMessage = async (
  prisma: PrismaClient,
  seed: Seed,
  message: { id: string; content: string },
): Promise<'claimed' | 'pended'> => {
  return prisma.$transaction(async (tx) => {
    const claim = await claimThreadRunOrPend(tx, {
      agentId: seed.agentId,
      threadId: seed.threadId,
      pending: {
        actorContext: actorFor(seed),
        channelId: seed.channelId,
        interactive: true,
        messageId: message.id,
      },
    })
    if (claim === 'pended') {
      return 'pended'
    }
    const run = await tx.run.create({
      data: {
        agentId: seed.agentId,
        threadId: seed.threadId,
        status: 'pending',
        triggerMessageId: message.id,
      },
      select: { id: true },
    })
    await tx.task.create({
      data: {
        agentId: seed.agentId,
        organizationId: seed.organizationId,
        purpose: message.content.slice(0, 200),
        runId: run.id,
        status: 'inbox',
      },
      select: { id: true },
    })
    return 'claimed'
  })
}

const runsForThread = (prisma: PrismaClient, seed: Seed) =>
  prisma.run.findMany({
    where: { agentId: seed.agentId, threadId: seed.threadId },
    orderBy: { createdAt: 'asc' },
  })

const queueJobCount = async (prisma: PrismaClient, idempotencyKey: string) => {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM queue_jobs WHERE idempotency_key = ${idempotencyKey}
  `
  return Number(rows[0]?.count ?? 0)
}

runDatabaseTest('5 rapid messages spawn at most 2 runs; the batch preserves order', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  // Sequential inserts so array order IS the thread's arrival order.
  const messages = []
  for (const content of ['first', 'second', 'third', 'fourth', 'fifth']) {
    messages.push(await postMessage(prisma, seed, content))
  }

  // Five rapid decides race for the same (agent, thread) slot.
  const outcomes = await Promise.all(
    messages.map((message) => decideReplyForMessage(prisma, seed, message)),
  )
  assert.deepEqual(
    outcomes.filter((outcome) => outcome === 'claimed'),
    ['claimed'],
  )
  assert.equal(outcomes.filter((outcome) => outcome === 'pended').length, 4)

  // The four mid-run messages are durably recorded; the drain delivers them
  // in thread arrival order regardless of decide-job interleaving. Whichever
  // decide won the slot claimed its message; the other four pended.
  const firstRun = (await runsForThread(prisma, seed))[0]
  assert.ok(firstRun)
  const pendedMessages = messages.filter((message) => message.id !== firstRun.triggerMessageId)
  assert.equal(pendedMessages.length, 4)
  const pendings = await prisma.runThreadPendingMessage.findMany({
    where: { agentId: seed.agentId, threadId: seed.threadId },
    orderBy: [{ message: { createdAt: 'asc' } }, { seq: 'asc' }],
  })
  assert.deepEqual(
    pendings.map((pending) => pending.messageId),
    pendedMessages.map((message) => message.id),
  )

  // The in-flight run completes; the completion path drains the batch.
  await prisma.run.update({
    where: { id: firstRun.id },
    data: { status: 'completed', finishedAt: new Date() },
  })
  const followUpRunId = await drainPendingThreadMessages(prisma, {
    agentId: seed.agentId,
    threadId: seed.threadId,
  })
  assert.ok(followUpRunId)

  // At most 2 runs total: the first run plus ONE batched follow-up.
  const runs = await runsForThread(prisma, seed)
  assert.equal(runs.length, 2)
  const followUp = runs[1]
  assert.ok(followUp)
  assert.equal(followUp.status, 'pending')
  // The latest pending message drives the batch run's prompt/replay backlink.
  assert.equal(followUp.triggerMessageId, pendedMessages[pendedMessages.length - 1]?.id)

  // The batch consumed every pending marker and enqueued exactly one job.
  assert.equal(
    await prisma.runThreadPendingMessage.count({
      where: { agentId: seed.agentId, threadId: seed.threadId },
    }),
    0,
  )
  assert.equal(await queueJobCount(prisma, `run:batch:${followUp.id}`), 1)

  // A drained batch is not re-delivered.
  assert.equal(
    await drainPendingThreadMessages(prisma, {
      agentId: seed.agentId,
      threadId: seed.threadId,
    }),
    null,
  )

  // The follow-up now holds the slot: the next rapid message pends again.
  const sixth = await postMessage(prisma, seed, 'sixth')
  assert.equal(await decideReplyForMessage(prisma, seed, sixth), 'pended')
})

runDatabaseTest('pending survives a lost drain: the re-poll sweep enqueues the follow-up', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const first = await postMessage(prisma, seed, 'first')
  const second = await postMessage(prisma, seed, 'second')
  const third = await postMessage(prisma, seed, 'third')

  assert.equal(await decideReplyForMessage(prisma, seed, first), 'claimed')
  assert.equal(await decideReplyForMessage(prisma, seed, second), 'pended')
  assert.equal(await decideReplyForMessage(prisma, seed, third), 'pended')

  // The run goes terminal without draining — worker crash between the status
  // update and the drain, or an API-side queued cancel no worker observes.
  const run = (await runsForThread(prisma, seed))[0]
  assert.ok(run)
  await prisma.run.update({
    where: { id: run.id },
    data: { status: 'cancelled', finishedAt: new Date() },
  })

  // The re-poll finds the orphaned pendings and enqueues the batched follow-up.
  assert.equal(await sweepPendingThreadMessages(prisma), 1)
  const runs = await runsForThread(prisma, seed)
  assert.equal(runs.length, 2)
  assert.equal(runs[1]?.triggerMessageId, third.id)
  assert.equal(await queueJobCount(prisma, `run:batch:${runs[1]?.id}`), 1)

  // Idempotent: a later sweep finds nothing to do.
  assert.equal(await sweepPendingThreadMessages(prisma), 0)
  assert.equal((await runsForThread(prisma, seed)).length, 2)
})

runDatabaseTest('cancelling the in-flight run still fires the batched follow-up', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const first = await postMessage(prisma, seed, 'first')
  const second = await postMessage(prisma, seed, 'second')
  const third = await postMessage(prisma, seed, 'third')

  assert.equal(await decideReplyForMessage(prisma, seed, first), 'claimed')
  assert.equal(await decideReplyForMessage(prisma, seed, second), 'pended')
  assert.equal(await decideReplyForMessage(prisma, seed, third), 'pended')

  const run = (await runsForThread(prisma, seed))[0]
  assert.ok(run)
  await prisma.run.update({ where: { id: run.id }, data: { status: 'running' } })
  const task = await prisma.task.findFirstOrThrow({ where: { runId: run.id } })

  const deps = {
    prisma,
    realtimeTransport: {
      publishSse: async () => undefined,
      publishWs: async () => undefined,
    },
  } as unknown as ExecutionDependencies
  const context = {
    agent: { id: seed.agentId, agentKind: 'shared' },
    channel: {
      id: seed.channelId,
      organizationId: seed.organizationId,
      systemChannelType: null,
    },
    run: { id: run.id, threadId: seed.threadId, createdAt: run.createdAt },
    task: { id: task.id },
  } as unknown as RunContext
  const payload: RunExecuteJobPayload = {
    actorContext: actorFor(seed),
    agentId: parseAgentId(seed.agentId),
    interactive: true,
    messageId: first.id,
    runId: parseRunId(run.id),
    taskId: parseTaskId(task.id),
    threadId: parseThreadId(seed.threadId),
  }

  // The cooperative cancel terminalizes the run; the cancel path drains.
  await finalizeCancelledRun(deps, payload, context, null, {
    invocations: [],
    responseText: 'partial answer',
    hadPartialText: true,
    notice: '⚠️ This run was cancelled.',
  })

  const cancelled = await prisma.run.findUniqueOrThrow({ where: { id: run.id } })
  assert.equal(cancelled.status, 'cancelled')

  // The pended messages became exactly one batched follow-up run.
  const runs = await runsForThread(prisma, seed)
  assert.equal(runs.length, 2)
  assert.equal(runs[1]?.status, 'pending')
  assert.equal(runs[1]?.triggerMessageId, third.id)
  assert.equal(await queueJobCount(prisma, `run:batch:${runs[1]?.id}`), 1)
  assert.equal(
    await prisma.runThreadPendingMessage.count({
      where: { agentId: seed.agentId, threadId: seed.threadId },
    }),
    0,
  )
})
