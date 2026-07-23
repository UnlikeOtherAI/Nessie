import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient, type Prisma } from '@prisma/client'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import {
  listActiveRuns,
  requestRunCancellation,
  restartRun,
} from '../src/services/runs.js'

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

const seedWorkspace = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `run-lc ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const user = await prisma.user.create({
    data: { email: `run-lc-${randomUUID()}@example.com`, displayName: 'Owner' },
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
  await prisma.$executeRaw`DELETE FROM queue_jobs WHERE idempotency_key LIKE ${'run:restart:%'}`
    .catch(() => undefined)
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

const createRun = async (
  prisma: PrismaClient,
  seed: Seed,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled',
  opts: { metadata?: Prisma.InputJsonValue; withTriggerMessage?: boolean } = {},
) => {
  let triggerMessageId: string | null = null
  if (opts.withTriggerMessage || opts.metadata) {
    const message = await prisma.message.create({
      data: {
        threadId: seed.threadId,
        role: 'user',
        content: 'do the thing',
        userId: seed.userId,
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      },
    })
    triggerMessageId = message.id
  }
  const run = await prisma.run.create({
    data: { agentId: seed.agentId, threadId: seed.threadId, status, triggerMessageId },
  })
  await prisma.task.create({
    data: { agentId: seed.agentId, organizationId: seed.organizationId, runId: run.id, status: 'inbox' },
  })
  return run
}

runDatabaseTest('cancel: a queued run is cancelled immediately and never executes', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createRun(prisma, seed, 'pending')
  const result = await requestRunCancellation(prisma, {
    organizationId: seed.organizationId,
    runId: run.id,
    cancelledByUserId: seed.userId,
  })
  assert.equal(result.kind, 'cancelled')

  const fresh = await prisma.run.findUnique({ where: { id: run.id } })
  assert.equal(fresh?.status, 'cancelled')
  assert.ok(fresh?.finishedAt)
  assert.equal(fresh?.cancelRequestedByUserId, seed.userId)

  const task = await prisma.task.findFirst({ where: { runId: run.id } })
  assert.equal(task?.status, 'cancelled')
  const events = await prisma.taskEvent.findMany({
    where: { taskId: task!.id, eventType: 'run.cancelled' },
  })
  assert.equal(events.length, 1)
})

runDatabaseTest('cancel: a running run gets the cooperative flag, not immediate terminal', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createRun(prisma, seed, 'running')
  const result = await requestRunCancellation(prisma, {
    organizationId: seed.organizationId,
    runId: run.id,
    cancelledByUserId: seed.userId,
  })
  assert.equal(result.kind, 'cancel_requested')

  const fresh = await prisma.run.findUnique({ where: { id: run.id } })
  assert.equal(fresh?.status, 'running')
  assert.ok(fresh?.cancelRequestedAt)
  assert.equal(fresh?.cancelRequestedByUserId, seed.userId)
})

runDatabaseTest('cancel: a completed run reports already-terminal and is untouched', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createRun(prisma, seed, 'completed')
  const result = await requestRunCancellation(prisma, {
    organizationId: seed.organizationId,
    runId: run.id,
    cancelledByUserId: seed.userId,
  })
  assert.deepEqual(result, { kind: 'already_terminal', status: 'completed' })
  const fresh = await prisma.run.findUnique({ where: { id: run.id } })
  assert.equal(fresh?.cancelRequestedAt, null)
})

runDatabaseTest('cancel: a DeepWater handoff run is rejected in favor of research_cancel', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createRun(prisma, seed, 'running', {
    metadata: { integrationLaunch: { productSlug: 'deep-water', runId: randomUUID() } },
  })
  const result = await requestRunCancellation(prisma, {
    organizationId: seed.organizationId,
    runId: run.id,
    cancelledByUserId: seed.userId,
  })
  assert.deepEqual(result, { kind: 'handoff_managed', productSlug: 'deep-water' })

  const fresh = await prisma.run.findUnique({ where: { id: run.id } })
  assert.equal(fresh?.status, 'running')
  assert.equal(fresh?.cancelRequestedAt, null)
})

runDatabaseTest('cancel: a run in another org is not found', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createRun(prisma, seed, 'running')
  const result = await requestRunCancellation(prisma, {
    organizationId: randomUUID(),
    runId: run.id,
    cancelledByUserId: seed.userId,
  })
  assert.equal(result.kind, 'not_found')
})

runDatabaseTest('restart: a failed run enqueues a fresh linked run replaying the same input', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createRun(prisma, seed, 'failed', { withTriggerMessage: true })
  const result = await restartRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.equal(result.kind, 'restarted')
  if (result.kind !== 'restarted') return

  const newRun = await prisma.run.findUnique({ where: { id: result.runId } })
  assert.equal(newRun?.status, 'pending')
  assert.equal(newRun?.restartOfRunId, run.id)
  assert.equal(newRun?.triggerMessageId, run.triggerMessageId)
  assert.equal(newRun?.threadId, seed.threadId)

  const job = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM queue_jobs
    WHERE idempotency_key = ${`run:restart:${result.runId}`}
  `
  assert.equal(Number(job[0]?.count ?? 0), 1)
})

runDatabaseTest('restart: a running run is rejected as not-terminal', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createRun(prisma, seed, 'running', { withTriggerMessage: true })
  const result = await restartRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.deepEqual(result, { kind: 'not_terminal', status: 'running' })
})

runDatabaseTest('restart: a completed run is rejected as not-restartable', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createRun(prisma, seed, 'completed', { withTriggerMessage: true })
  const result = await restartRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.deepEqual(result, { kind: 'not_restartable', status: 'completed' })
})

runDatabaseTest('restart: a DeepWater handoff run is rejected', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createRun(prisma, seed, 'failed', {
    metadata: { integrationLaunch: { productSlug: 'deep-water', runId: randomUUID() } },
  })
  const result = await restartRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.deepEqual(result, { kind: 'handoff_managed', productSlug: 'deep-water' })
})

runDatabaseTest('listActiveRuns returns live runs for the org with cheap telemetry', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createRun(prisma, seed, 'running')
  const active = await listActiveRuns(prisma, seed.organizationId)
  const found = active.find((entry) => entry.id === run.id)
  assert.ok(found)
  assert.equal(found?.status, 'running')
  assert.equal(found?.agentName, 'A')
  assert.equal(found?.cancelRequested, false)
})
