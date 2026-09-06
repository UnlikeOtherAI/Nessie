import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient, type RunStatus } from '@prisma/client'

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

/**
 * A run in `status`, carrying the executor claim the real code would have left
 * on it: a token and a heartbeat `heartbeatAgo` ago, or — when `heartbeatAgo`
 * is null — the cleared pair `releaseRunForDrain` writes on an orderly
 * hand-back.
 */
const createRun = async (
  prisma: PrismaClient,
  fixture: Seed,
  input: { heartbeatAgo: string | null; status: RunStatus },
): Promise<string> => {
  const run = await prisma.run.create({
    data: { agentId: fixture.agentId, status: input.status, threadId: fixture.threadId },
    select: { id: true },
  })
  await prisma.$executeRawUnsafe(
    `UPDATE runs
     SET executor_token = CASE WHEN $2::text IS NULL THEN NULL ELSE gen_random_uuid() END,
         executor_heartbeat_at =
           CASE WHEN $2::text IS NULL THEN NULL ELSE now() - $2::interval END
     WHERE id = $1::uuid`,
    run.id,
    input.heartbeatAgo,
  )
  return run.id
}

/** A `running` run holding a fencing token, heartbeating `heartbeatAgo` ago. */
const createRunningRun = async (
  prisma: PrismaClient,
  fixture: Seed,
  heartbeatAgo: string,
): Promise<string> => createRun(prisma, fixture, { heartbeatAgo, status: 'running' })

/** Comfortably past `DOCUMENT_SESSION_EXECUTOR_SILENCE_MS`, as an SQL interval. */
const PAST_THE_WINDOW =
  `${Math.ceil(DOCUMENT_SESSION_EXECUTOR_SILENCE_MS / 60_000) + 1} minutes`

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

runDatabaseTest('a session on a run parked for a person is never reaped', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  const published: string[] = []
  try {
    // The exact row a suspension leaves behind. `updateRunStatus` nulls
    // `executor_token` in the statement that writes `waiting_approval`, and
    // `startExecutorHeartbeat`'s interval body returns early once the token is
    // null — so the heartbeat simply ages from the moment the run parks. Six
    // minutes is an ordinary length of time for a person to spend on an
    // approval, and at the end of it the run is parked, not dead.
    const runId = await createRun(prisma, fixture, {
      heartbeatAgo: PAST_THE_WINDOW,
      status: 'waiting_approval',
    })
    await prisma.$executeRawUnsafe(
      `UPDATE runs SET executor_token = NULL WHERE id = $1::uuid`,
      runId,
    )
    const sessionId = await createStreamingSession(prisma, fixture, runId, PAST_THE_WINDOW)

    await reapAbandonedDocumentSessions(prisma, {
      publishSse: async (threadId) => {
        published.push(threadId)
      },
    })

    const parked = await readSession(prisma, sessionId)
    assert.equal(parked.status, 'streaming', 'a parked run has not lost its executor')
    assert.equal(parked.errorReason, null)
    assert.deepEqual(published, [], 'nothing is published into the reader\'s open dialog')

    // And it is deferred, not stranded: every parked run leaves that status
    // eventually — `resumeSuspendedRun` terminalises it as `completed` when the
    // person approves, `sweepExpiredApprovals` as `failed` when nobody does —
    // and the terminal arm collects the session then.
    await prisma.run.update({ data: { status: 'completed' }, where: { id: runId } })
    await reapAbandonedDocumentSessions(prisma)

    assert.equal((await readSession(prisma, sessionId)).status, 'failed')
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a session on a drained run waiting for its successor survives', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    // What `releaseRunForDrain` leaves: `running`, no token, no heartbeat —
    // cleared on purpose so the next worker claims the run on its very next
    // poll instead of waiting out the takeover window. The job is back on the
    // queue; a scale-in with every other worker busy is exactly the shape that
    // leaves it there for longer than this reaper's window.
    const runId = await createRun(prisma, fixture, { heartbeatAgo: null, status: 'running' })
    const sessionId = await createStreamingSession(prisma, fixture, runId, PAST_THE_WINDOW)

    await reapAbandonedDocumentSessions(prisma)

    assert.equal(
      (await readSession(prisma, sessionId)).status,
      'streaming',
      'a null heartbeat is a hand-back, not a corpse',
    )

    // The successor claims the run, finishes it, and the session its
    // predecessor stranded is collected on the next pass.
    await prisma.run.update({ data: { status: 'completed' }, where: { id: runId } })
    await reapAbandonedDocumentSessions(prisma)

    assert.equal((await readSession(prisma, sessionId)).status, 'failed')
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a session left open on a finished run is reaped', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  try {
    // The leak this sweep exists for, in its other shape: the run reached a
    // terminal status but a session never followed it there. `claimRunForExecution`
    // admits only `pending` and stale `running` runs, so nothing will ever hold
    // this run again — which is why the terminal arm needs no heartbeat
    // evidence, and must not, or a run drained and then cancelled would keep
    // its session for ever.
    const runId = await createRun(prisma, fixture, { heartbeatAgo: null, status: 'cancelled' })
    const sessionId = await createStreamingSession(prisma, fixture, runId, PAST_THE_WINDOW)

    const result = await reapAbandonedDocumentSessions(prisma)

    assert.equal((await readSession(prisma, sessionId)).status, 'failed')
    assert.equal(result.reaped >= 1, true)
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
