import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import {
  DOCUMENT_SESSION_EXECUTOR_SILENCE_MS,
  reapAbandonedDocumentSessions,
  type DocumentSessionReaperStore,
} from '../../src/control/document-session-reaper.js'
import { runDatabaseTest } from './support.js'

// The document-session reaper (horizontal scaling, phase 3.3; audit 2.5).
//
// Everything under test is a decision the database makes: whether a run's
// executor heartbeat is stale enough to call its worker dead, and whether the
// conditional write that terminalizes the session still matches. A Prisma fake
// decides neither, so these run against real Postgres.
//
// This suite drives no global poller in the `support.ts` sense, but the reaper
// itself IS global — it reads every abandoned session in the database, exactly
// as it does in production — so every assertion below is scoped to the rows
// this suite seeded.

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  projectId: string
  teamId: string
  threadId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `doc-reaper ${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId: org.id } })
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
  // Sessions cascade from their run.
  await prisma.run.deleteMany({ where: { threadId: fixture.threadId } })
  await prisma.thread.deleteMany({ where: { channelId: fixture.channelId } })
  await prisma.channel.deleteMany({ where: { id: fixture.channelId } })
  await prisma.agent.deleteMany({ where: { id: fixture.agentId } })
  await prisma.team.deleteMany({ where: { id: fixture.teamId } })
  await prisma.project.deleteMany({ where: { id: fixture.projectId } })
  await prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
}

/** A `running` run holding a fencing token, heartbeating `heartbeatAgo` ago. */
const createRunningRun = async (
  prisma: PrismaClient,
  fixture: Seed,
  heartbeatAgo: string,
): Promise<string> => {
  const run = await prisma.run.create({
    data: { agentId: fixture.agentId, status: 'running', threadId: fixture.threadId },
    select: { id: true },
  })
  await prisma.$executeRawUnsafe(
    `UPDATE runs
     SET executor_token = gen_random_uuid(), executor_heartbeat_at = now() - $2::interval
     WHERE id = $1::uuid`,
    run.id,
    heartbeatAgo,
  )
  return run.id
}

const createStreamingSession = async (
  prisma: PrismaClient,
  fixture: Seed,
  runId: string,
  updatedAgo: string,
): Promise<string> => {
  const session = await prisma.runDocumentSession.create({
    data: {
      agentId: fixture.agentId,
      invocationId: randomUUID(),
      organizationId: fixture.organizationId,
      runId,
      threadId: fixture.threadId,
      toolCallId: randomUUID(),
    },
    select: { id: true },
  })
  // `updated_at` is Prisma's `@updatedAt`, so only raw SQL can backdate it.
  await prisma.$executeRawUnsafe(
    `UPDATE run_document_sessions SET updated_at = now() - $2::interval WHERE id = $1::uuid`,
    session.id,
    updatedAgo,
  )
  return session.id
}

const readSession = async (
  prisma: PrismaClient,
  sessionId: string,
): Promise<{ errorReason: string | null; finishedAt: Date | null; status: string }> =>
  prisma.runDocumentSession.findUniqueOrThrow({
    select: { errorReason: true, finishedAt: true, status: true },
    where: { id: sessionId },
  })

runDatabaseTest('a session whose run still has a live executor is left alone', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    // A long generation: the row itself has not been written for an hour
    // (the durable lane writes chunks, not the session), but the executor
    // heartbeated seconds ago. Reaping on age alone would kill this document.
    const runId = await createRunningRun(prisma, fixture, '5 seconds')
    const sessionId = await createStreamingSession(prisma, fixture, runId, '1 hour')

    await reapAbandonedDocumentSessions(prisma)

    const row = await readSession(prisma, sessionId)
    assert.equal(row.status, 'streaming', 'a live executor still owns this document')
    assert.equal(row.errorReason, null)
    assert.equal(row.finishedAt, null)
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a session whose executor is gone is reaped, with a reason', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  const published: { data: unknown; event: string; threadId: string }[] = []
  try {
    // The worker was killed mid-stream: the run is still `running` and still
    // carries its token, but nothing has refreshed the heartbeat since. Past
    // the silence window, `claimRunForExecution` would already have handed this
    // run to another executor.
    const silenceMinutes = Math.ceil(DOCUMENT_SESSION_EXECUTOR_SILENCE_MS / 60_000) + 1
    const runId = await createRunningRun(prisma, fixture, `${silenceMinutes} minutes`)
    const sessionId = await createStreamingSession(
      prisma,
      fixture,
      runId,
      `${silenceMinutes} minutes`,
    )

    await reapAbandonedDocumentSessions(prisma, {
      publishSse: async (threadId, event, data) => {
        published.push({ data, event, threadId })
      },
    })

    const row = await readSession(prisma, sessionId)
    // `api/src/services/document-streams.ts` counts exactly ['streaming',
    // 'saving'] as active. Landing outside that pair is the whole point: the
    // admin stops showing a document that never finishes.
    assert.ok(
      row.status !== 'streaming' && row.status !== 'saving',
      `expected a terminal status, got ${row.status}`,
    )
    assert.equal(row.status, 'failed')
    // Diagnosable, not blank: an operator reading this row later is told the
    // producer died rather than left guessing.
    assert.equal(row.errorReason, 'executor_lost')
    assert.notEqual(row.finishedAt, null)

    assert.equal(published.length, 1, 'an open popup is told the document ended')
    assert.equal(published[0]?.threadId, fixture.threadId)
    assert.equal(published[0]?.event, 'stream.document.error')
    assert.deepEqual(published[0]?.data, {
      reason: 'executor_lost',
      runId,
      sessionId,
    })
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a row that throws does not stop the rest of the batch', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    const silenceMinutes = Math.ceil(DOCUMENT_SESSION_EXECUTOR_SILENCE_MS / 60_000) + 1
    const runId = await createRunningRun(prisma, fixture, `${silenceMinutes} minutes`)
    // The batch is ordered by `updated_at` ascending, so the poison row is
    // first on this pass and on every pass after it — which is exactly the
    // shape that wedges a sweep for ever without per-row isolation.
    const poisonId = await createStreamingSession(prisma, fixture, runId, '40 days')
    const healthyId = await createStreamingSession(prisma, fixture, runId, '39 days')

    let attempts = 0
    const store: DocumentSessionReaperStore = {
      $queryRaw: prisma.$queryRaw.bind(prisma) as PrismaClient['$queryRaw'],
      runDocumentSession: {
        updateMany: (async (args: { where?: { id?: string } }) => {
          attempts += 1
          if (args.where?.id === poisonId) {
            throw new Error('poison row')
          }
          return prisma.runDocumentSession.updateMany(
            args as Parameters<PrismaClient['runDocumentSession']['updateMany']>[0],
          )
        }) as PrismaClient['runDocumentSession']['updateMany'],
      },
    }

    const result = await reapAbandonedDocumentSessions(store)

    assert.equal(attempts >= 2, true, 'the pass reached the row behind the poison one')
    assert.equal(await readSession(prisma, poisonId).then((row) => row.status), 'streaming')
    assert.equal(await readSession(prisma, healthyId).then((row) => row.status), 'failed')
    assert.equal(result.reaped >= 1, true)
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})
