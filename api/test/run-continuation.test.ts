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

import { continueRun } from '../src/services/run-continuation.js'
import { listRestartableRuns } from '../src/services/runs.js'

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

const seedWorkspace = async (
  prisma: PrismaClient,
  visibility: 'private' | 'public' = 'public',
): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `run-cont ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const user = await prisma.user.create({
    data: { email: `run-cont-${randomUUID()}@example.com`, displayName: 'Owner' },
  })
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      slug: `c-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
      visibility,
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

// Scoped by the seed's thread (every `run.execute` payload carries a top-level
// `threadId`) rather than an `idempotency_key LIKE 'run:continue:%'` sweep,
// which would also delete concurrently-running suites' jobs — `pnpm -r test`
// runs the api and worker packages against one database at the same time.
const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  await prisma
    .$executeRaw`DELETE FROM queue_jobs WHERE payload->>'threadId' = ${seed.threadId}`
    .catch(() => undefined)
  await prisma.taskEvent.deleteMany({ where: { task: { organizationId: seed.organizationId } } })
  await prisma.task.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.message.deleteMany({ where: { threadId: seed.threadId } })
  // RunCheckpoint cascades from its run.
  await prisma.run.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.thread.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.channelMember.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.channel.deleteMany({ where: { id: seed.channelId } })
  await prisma.agent.deleteMany({ where: { id: seed.agentId } })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.user.deleteMany({ where: { id: seed.userId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

const createStoppedRun = async (
  prisma: PrismaClient,
  seed: Seed,
  opts: {
    checkpoint?: boolean
    consumed?: boolean
    metadata?: Prisma.InputJsonValue
    status?: 'cancelled' | 'completed' | 'failed' | 'running'
    withTriggerMessage?: boolean
  } = {},
) => {
  const status = opts.status ?? 'failed'
  let triggerMessageId: string | null = null
  if (opts.withTriggerMessage !== false) {
    const message = await prisma.message.create({
      data: {
        threadId: seed.threadId,
        role: 'user',
        content: 'research slack clones',
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
    data: {
      agentId: seed.agentId,
      organizationId: seed.organizationId,
      runId: run.id,
      status: 'inbox',
    },
  })
  if (opts.checkpoint !== false) {
    await prisma.runCheckpoint.create({
      data: {
        agentId: seed.agentId,
        consumedAt: opts.consumed ? new Date() : null,
        consumedByRunId: opts.consumed ? run.id : null,
        generation: 1,
        note: 'Working notes from the stopped run.',
        organizationId: seed.organizationId,
        reason: 'token_limit',
        runId: run.id,
        sources: [{ url: 'https://example.com/a', title: 'A' }],
        threadId: seed.threadId,
      },
    })
  }
  return run
}

runDatabaseTest('continue: a checkpointed run enqueues a linked continuation run', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createStoppedRun(prisma, seed)
  const result = await continueRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.equal(result.kind, 'continued')
  if (result.kind !== 'continued') return

  const newRun = await prisma.run.findUnique({ where: { id: result.runId } })
  assert.equal(newRun?.status, 'pending')
  assert.equal(newRun?.continuationOfRunId, run.id)
  assert.equal(newRun?.triggerMessageId, run.triggerMessageId)
  assert.equal(newRun?.threadId, seed.threadId)

  // The checkpoint is claimed by exactly the new run.
  const checkpoint = await prisma.runCheckpoint.findUnique({ where: { runId: run.id } })
  assert.equal(checkpoint?.consumedByRunId, result.runId)
  assert.ok(checkpoint?.consumedAt)

  // The continuation is queued as its own job, keyed by the new run id.
  const job = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM queue_jobs
    WHERE idempotency_key = ${`run:continue:${result.runId}`}
  `
  assert.equal(Number(job[0]?.count ?? 0), 1)

  // The lineage is recorded as a TaskEvent on the continuation's task.
  const events = await prisma.taskEvent.findMany({
    where: { taskId: result.taskId, eventType: 'run.continued' },
  })
  assert.equal(events.length, 1)
  assert.deepEqual(events[0]?.payload, {
    auto: false,
    continuationOfRunId: run.id,
    fromCheckpointId: checkpoint?.id,
    runId: result.runId,
  })
})

runDatabaseTest('continue: an already-consumed checkpoint is rejected', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createStoppedRun(prisma, seed, { consumed: true })
  const result = await continueRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.deepEqual(result, { kind: 'checkpoint_consumed' })

  const runs = await prisma.run.findMany({ where: { threadId: seed.threadId } })
  assert.equal(runs.length, 1)
})

runDatabaseTest('continue: concurrent continues produce exactly one winner', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createStoppedRun(prisma, seed)
  const [first, second] = await Promise.all([
    continueRun(prisma, actorFor(seed), {
      organizationId: seed.organizationId,
      runId: run.id,
    }),
    continueRun(prisma, actorFor(seed), {
      organizationId: seed.organizationId,
      runId: run.id,
    }),
  ])

  const winners = [first, second].filter((result) => result.kind === 'continued')
  assert.equal(winners.length, 1, 'exactly one continue may create a run')
  const loser = [first, second].find((result) => result.kind !== 'continued')
  // The loser is either beaten to the claim or blocked by the winner's run.
  assert.ok(loser && (loser.kind === 'checkpoint_consumed' || loser.kind === 'busy'))

  const continuations = await prisma.run.findMany({
    where: { continuationOfRunId: run.id },
  })
  assert.equal(continuations.length, 1)
  const checkpoint = await prisma.runCheckpoint.findUnique({ where: { runId: run.id } })
  assert.equal(checkpoint?.consumedByRunId, continuations[0]?.id)
})

runDatabaseTest('continue: another active run on the thread rejects with busy', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createStoppedRun(prisma, seed)
  await prisma.run.create({
    data: { agentId: seed.agentId, threadId: seed.threadId, status: 'running' },
  })

  const result = await continueRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.deepEqual(result, { kind: 'busy' })

  // Nothing was claimed and no continuation run exists.
  const checkpoint = await prisma.runCheckpoint.findUnique({ where: { runId: run.id } })
  assert.equal(checkpoint?.consumedByRunId, null)
  const continuations = await prisma.run.findMany({ where: { continuationOfRunId: run.id } })
  assert.equal(continuations.length, 0)
})

runDatabaseTest('continue: a terminal run without a checkpoint is not continuable', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createStoppedRun(prisma, seed, { checkpoint: false })
  const result = await continueRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.deepEqual(result, {
    kind: 'not_continuable',
    detail: 'no_checkpoint',
    status: 'failed',
  })
})

runDatabaseTest('continue: a still-running run is not continuable', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createStoppedRun(prisma, seed, { status: 'running' })
  const result = await continueRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.deepEqual(result, {
    kind: 'not_continuable',
    detail: 'not_terminal',
    status: 'running',
  })
})

runDatabaseTest('continue: a DeepWater handoff run is rejected before any claim', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createStoppedRun(prisma, seed, {
    metadata: { integrationLaunch: { productSlug: 'deep-water', runId: randomUUID() } },
  })
  const result = await continueRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.deepEqual(result, { kind: 'handoff_managed', productSlug: 'deep-water' })

  const checkpoint = await prisma.runCheckpoint.findUnique({ where: { runId: run.id } })
  assert.equal(checkpoint?.consumedByRunId, null)
})

runDatabaseTest('continue: a run in another org is not found', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createStoppedRun(prisma, seed)
  const result = await continueRun(prisma, actorFor(seed), {
    organizationId: randomUUID(),
    runId: run.id,
  })
  assert.deepEqual(result, { kind: 'not_found' })
})

runDatabaseTest('continue: a private channel the caller cannot reach is not found', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma, 'private')
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const run = await createStoppedRun(prisma, seed)
  const result = await continueRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.deepEqual(result, { kind: 'not_found' })

  // Membership restores exactly the access that could have triggered the run.
  await prisma.channelMember.create({
    data: { channelId: seed.channelId, userId: seed.userId },
  })
  const allowed = await continueRun(prisma, actorFor(seed), {
    organizationId: seed.organizationId,
    runId: run.id,
  })
  assert.equal(allowed.kind, 'continued')
})

runDatabaseTest('active runs: recently-ended runs project their unconsumed checkpoint id', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const withCheckpoint = await createStoppedRun(prisma, seed)
  const withoutCheckpoint = await createStoppedRun(prisma, seed, { checkpoint: false })
  const consumed = await createStoppedRun(prisma, seed, { consumed: true })

  const restartable = await listRestartableRuns(prisma, seed.organizationId)
  const byId = new Map(restartable.map((entry) => [entry.id, entry]))
  const checkpoint = await prisma.runCheckpoint.findUnique({
    where: { runId: withCheckpoint.id },
  })
  assert.equal(byId.get(withCheckpoint.id)?.checkpointId, checkpoint?.id)
  assert.equal(byId.get(withoutCheckpoint.id)?.checkpointId, null)
  assert.equal(byId.get(consumed.id)?.checkpointId, null)
})
