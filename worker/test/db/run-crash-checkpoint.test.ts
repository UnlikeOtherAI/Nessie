import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import {
  clearCrashCheckpoint,
  loadCrashCheckpoint,
  persistCrashCheckpoint,
  type CrashCheckpointTarget,
} from '../../src/run/execute/crash-checkpoint.js'
import {
  claimRunForExecution,
  releaseRunForDrain,
  updateRunStatus,
  withRunExecutorFence,
} from '../../src/run/execute/lifecycle.js'
import type { LoopResumeState } from '../../src/run/loop-resume.js'
import { runDatabaseTest } from './support.js'

// Crash checkpoints (horizontal scaling, phase 3.1).
//
// Everything asserted here is a property of a conditional statement racing
// against another executor, so it only exists in Postgres: whether a write
// matches a row depends on what `runs.executor_token` says at that instant, and
// no Prisma fake can decide that. The resume path itself is exercised
// end-to-end in `run-crash-resume.test.ts`.
//
// This suite drives no global poller — it seeds and asserts one run — but it
// needs the database, which is what puts it in this directory.

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  projectId: string
  runId: string
  taskId: string
  teamId: string
  threadId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({
    data: { name: `crash-checkpoint ${randomUUID()}` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      organizationId: org.id,
      projectId: project.id,
      slug: `c-${randomUUID()}`,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({ data: { name: 'A', organizationId: org.id } })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'pending', threadId: thread.id },
  })
  const task = await prisma.task.create({
    data: { agentId: agent.id, organizationId: org.id, runId: run.id },
  })
  return {
    agentId: agent.id,
    channelId: channel.id,
    organizationId: org.id,
    projectId: project.id,
    runId: run.id,
    taskId: task.id,
    teamId: team.id,
    threadId: thread.id,
  }
}

const cleanup = async (prisma: PrismaClient, fixture: Seed): Promise<void> => {
  await prisma.runCheckpoint.deleteMany({ where: { runId: fixture.runId } })
  await prisma.task.deleteMany({ where: { runId: fixture.runId } })
  await prisma.run.deleteMany({ where: { threadId: fixture.threadId } })
  await prisma.thread.deleteMany({ where: { channelId: fixture.channelId } })
  await prisma.channel.deleteMany({ where: { id: fixture.channelId } })
  await prisma.agent.deleteMany({ where: { id: fixture.agentId } })
  await prisma.team.deleteMany({ where: { id: fixture.teamId } })
  await prisma.project.deleteMany({ where: { id: fixture.projectId } })
  await prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
}

const targetOf = (fixture: Seed): CrashCheckpointTarget => ({
  agentId: fixture.agentId,
  organizationId: fixture.organizationId,
  rootMessageId: null,
  runId: fixture.runId,
  taskId: fixture.taskId,
  threadId: fixture.threadId,
})

const stateAt = (iteration: number): LoopResumeState => ({
  compactionAttempts: 0,
  compactionLastIteration: null,
  elapsedMs: 1_000 * iteration,
  invocations: [],
  iterations: iteration,
  lastAssistantText: `turn ${iteration}`,
  messages: [{ content: 'go', role: 'user' }],
  pendingToolCalls: null,
  signatureCounts: {},
  toolCallsUsed: iteration,
  toolMs: 5,
  toolResults: {},
  woundDown: false,
})

runDatabaseTest('a crash checkpoint is one row per run, overwritten in place', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    await withRunExecutorFence(fixture.runId, async () => {
      const claim = await claimRunForExecution(prisma, fixture.runId)
      assert.equal(claim.claimed, true)
      assert.equal(claim.claimed && claim.priorStatus, 'pending', 'a fresh run is not a takeover')

      assert.equal(
        await persistCrashCheckpoint(prisma, targetOf(fixture), claim.token!, stateAt(1)),
        1,
        'the first boundary inserts the row',
      )
      assert.equal(
        await persistCrashCheckpoint(prisma, targetOf(fixture), claim.token!, stateAt(2)),
        1,
        'the next boundary overwrites it rather than adding a second',
      )

      assert.equal(
        await prisma.runCheckpoint.count({ where: { runId: fixture.runId } }),
        1,
      )
      assert.equal((await loadCrashCheckpoint(prisma, fixture.runId))?.iterations, 2)
    })
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a fenced-out executor\'s checkpoint write affects no rows', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    await withRunExecutorFence(fixture.runId, async () => {
      const loser = await claimRunForExecution(prisma, fixture.runId)
      assert.equal(loser.claimed, true)
      await persistCrashCheckpoint(prisma, targetOf(fixture), loser.token!, stateAt(1))

      // Another worker takes the run over, exactly as `claimRunForExecution`
      // would once this executor's heartbeat went stale.
      await prisma.$executeRawUnsafe(
        'UPDATE runs SET executor_token = $2::uuid, executor_heartbeat_at = now() WHERE id = $1::uuid',
        fixture.runId,
        randomUUID(),
      )

      assert.equal(
        await persistCrashCheckpoint(prisma, targetOf(fixture), loser.token!, stateAt(9)),
        0,
        'the loser must not overwrite the winner\'s state',
      )
      assert.equal(
        (await loadCrashCheckpoint(prisma, fixture.runId))?.iterations,
        1,
        'the row still holds what the run had when it was still this executor\'s',
      )
    })
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a terminal transition deletes the crash checkpoint', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    await withRunExecutorFence(fixture.runId, async () => {
      const claim = await claimRunForExecution(prisma, fixture.runId)
      await persistCrashCheckpoint(prisma, targetOf(fixture), claim.token!, stateAt(3))
      assert.notEqual(await loadCrashCheckpoint(prisma, fixture.runId), null)

      await updateRunStatus(prisma, fixture.runId, 'completed')

      assert.equal(
        await prisma.runCheckpoint.count({ where: { runId: fixture.runId } }),
        0,
        'a finished run has nothing to resume, so its crash row goes entirely',
      )
    })
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a resume checkpoint survives the terminal transition that sheds crash state', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    await withRunExecutorFence(fixture.runId, async () => {
      const claim = await claimRunForExecution(prisma, fixture.runId)
      await persistCrashCheckpoint(prisma, targetOf(fixture), claim.token!, stateAt(4))
      // What a budget stop writes into the same row: from here it is somebody's
      // Continue button, not machine state.
      await prisma.runCheckpoint.update({
        data: { note: 'what I found so far', reason: 'token_limit' },
        where: { runId: fixture.runId },
      })

      await updateRunStatus(prisma, fixture.runId, 'completed')

      const row = await prisma.runCheckpoint.findUnique({ where: { runId: fixture.runId } })
      assert.equal(row?.note, 'what I found so far', 'the resume affordance is not collateral')
      assert.equal(row?.crashState, null)
      assert.equal(row?.crashExecutorToken, null)
    })
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a drained run is immediately claimable by the next worker', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    await withRunExecutorFence(fixture.runId, async () => {
      const claim = await claimRunForExecution(prisma, fixture.runId)
      await persistCrashCheckpoint(prisma, targetOf(fixture), claim.token!, stateAt(2))
      await releaseRunForDrain(prisma, fixture.runId)
    })

    const row = await prisma.run.findUniqueOrThrow({
      select: { executorHeartbeatAt: true, executorToken: true, status: true },
      where: { id: fixture.runId },
    })
    assert.equal(row.status, 'running', 'a drain is not a terminal outcome')
    assert.equal(row.executorToken, null)
    assert.equal(row.executorHeartbeatAt, null, 'a null heartbeat is what skips the takeover wait')

    const next = await withRunExecutorFence(
      fixture.runId,
      () => claimRunForExecution(prisma, fixture.runId),
    )
    assert.equal(next.claimed, true, 'the successor claims on its very next poll')
    assert.equal(
      next.claimed && next.priorStatus,
      'running',
      'and knows to look for a checkpoint rather than start from the prompt',
    )
    assert.equal((await loadCrashCheckpoint(prisma, fixture.runId))?.iterations, 2)
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('clearing is idempotent and leaves nothing behind', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    await clearCrashCheckpoint(prisma, fixture.runId)
    assert.equal(await loadCrashCheckpoint(prisma, fixture.runId), null)
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})
