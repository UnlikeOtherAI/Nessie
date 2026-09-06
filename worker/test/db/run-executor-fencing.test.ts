import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import {
  claimRunForExecution,
  RunFencedError,
  updateRunStatus,
  withRunExecutorFence,
} from '../../src/run/execute/lifecycle.js'
import { runDatabaseTest } from './support.js'

// Run-level executor fencing (horizontal scaling, phase 1.3).
//
// The invariant under test only exists in the database: two executors race one
// conditional UPDATE, and the loser must be told so rather than allowed to
// write the run's outcome on top of the winner's. A Prisma fake cannot decide
// that race, so these run against real Postgres.
//
// This suite drives no global poller — it seeds its own run and asserts only
// that run — but it lives here because it needs the database at all.

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  projectId: string
  teamId: string
  threadId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `fencing ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
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
    agentId: agent.id,
    channelId: channel.id,
    organizationId: org.id,
    projectId: project.id,
    teamId: team.id,
    threadId: thread.id,
  }
}

const cleanup = async (prisma: PrismaClient, fixture: Seed): Promise<void> => {
  await prisma.run.deleteMany({ where: { threadId: fixture.threadId } })
  await prisma.thread.deleteMany({ where: { channelId: fixture.channelId } })
  await prisma.channel.deleteMany({ where: { id: fixture.channelId } })
  await prisma.agent.deleteMany({ where: { id: fixture.agentId } })
  await prisma.team.deleteMany({ where: { id: fixture.teamId } })
  await prisma.project.deleteMany({ where: { id: fixture.projectId } })
  await prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
}

const createRun = async (
  prisma: PrismaClient,
  fixture: Seed,
  status: 'pending' | 'running',
): Promise<string> => {
  const run = await prisma.run.create({
    data: { agentId: fixture.agentId, status, threadId: fixture.threadId },
    select: { id: true },
  })
  return run.id
}

const readFence = async (
  prisma: PrismaClient,
  runId: string,
): Promise<{ executorHeartbeatAt: Date | null; executorToken: string | null; status: string }> => {
  const run = await prisma.run.findUniqueOrThrow({
    select: { executorHeartbeatAt: true, executorToken: true, status: true },
    where: { id: runId },
  })
  return run
}

const ageHeartbeat = async (
  prisma: PrismaClient,
  runId: string,
  interval: string,
): Promise<void> => {
  await prisma.$executeRawUnsafe(
    `UPDATE runs SET executor_heartbeat_at = now() - $2::interval WHERE id = $1::uuid`,
    runId,
    interval,
  )
}

runDatabaseTest('two executors claim one pending run; exactly one wins', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    const runId = await createRun(prisma, fixture, 'pending')

    const first = await claimRunForExecution(prisma, runId)
    const second = await claimRunForExecution(prisma, runId)

    assert.equal(first.claimed, true)
    assert.equal(second.claimed, false, 'a live executor already holds this run')

    const row = await readFence(prisma, runId)
    assert.equal(row.status, 'running')
    assert.equal(row.executorToken, first.token, 'the winner\'s token is the one on the row')
    assert.notEqual(row.executorToken, null)
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a running run with a fresh heartbeat is not claimable', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    const runId = await createRun(prisma, fixture, 'running')
    const holder = await claimRunForExecution(prisma, runId)
    assert.equal(holder.claimed, true)
    await ageHeartbeat(prisma, runId, '20 seconds')

    const takeover = await claimRunForExecution(prisma, runId)

    assert.equal(takeover.claimed, false, 'the holder answered 20s ago; it has not crashed')
    assert.equal((await readFence(prisma, runId)).executorToken, holder.token)
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a running run whose executor went silent is claimable again', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    const runId = await createRun(prisma, fixture, 'running')
    const crashed = await claimRunForExecution(prisma, runId)
    assert.equal(crashed.claimed, true)
    await ageHeartbeat(prisma, runId, '3 minutes')

    const takeover = await claimRunForExecution(prisma, runId)

    assert.equal(takeover.claimed, true, 'a silent executor must not strand its run forever')
    const row = await readFence(prisma, runId)
    assert.equal(row.executorToken, takeover.token)
    assert.notEqual(row.executorToken, crashed.token)
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a fenced-out executor cannot write the run terminal', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    const runId = await createRun(prisma, fixture, 'pending')
    // `withRunExecutorFence` is what `executeRunJob` wraps a job in: the claim
    // stamps its token into this context, and the status writes underneath
    // carry it. Outside such a context there is no claim to fence on.
    await withRunExecutorFence(runId, async () => {
      const loser = await claimRunForExecution(prisma, runId)
      assert.equal(loser.claimed, true)
      // The other worker takes the run over: it stamps its own token, exactly as
      // `claimRunForExecution` would after this executor's heartbeat went stale.
      const winnerToken = randomUUID()
      await prisma.$executeRawUnsafe(
        `UPDATE runs SET executor_token = $2::uuid, executor_heartbeat_at = now() WHERE id = $1::uuid`,
        runId,
        winnerToken,
      )

      await assert.rejects(
        () => updateRunStatus(prisma, runId, 'completed'),
        (error: unknown) => error instanceof RunFencedError && error.runId === runId,
      )

      const row = await readFence(prisma, runId)
      assert.equal(row.status, 'running', 'the loser must not have terminalized the winner\'s run')
      assert.equal(row.executorToken, winnerToken)

      // Sticky: once fenced, this executor stops writing without another round
      // trip, which is what aborts its loop at the next iteration boundary.
      await assert.rejects(
        () => updateRunStatus(prisma, runId, 'failed'),
        (error: unknown) => error instanceof RunFencedError,
      )
    })
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('suspending a run releases its executor token', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    const runId = await createRun(prisma, fixture, 'pending')
    const holder = await withRunExecutorFence(runId, async () => {
      const claim = await claimRunForExecution(prisma, runId)
      assert.equal(claim.claimed, true)
      await updateRunStatus(prisma, runId, 'waiting_approval')
      return claim
    })

    const suspended = await readFence(prisma, runId)
    assert.equal(suspended.status, 'waiting_approval')
    assert.equal(suspended.executorToken, null, 'a parked run has no executor')

    // Which is what lets the resuming executor claim it without waiting out the
    // takeover window. (Resume re-enqueues through `pending`; claiming the
    // suspended row directly is the stricter check.)
    await prisma.run.update({ data: { status: 'pending' }, where: { id: runId } })
    const resumer = await withRunExecutorFence(
      runId,
      () => claimRunForExecution(prisma, runId),
    )
    assert.equal(resumer.claimed, true)
    assert.notEqual(resumer.token, holder.token)
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})
