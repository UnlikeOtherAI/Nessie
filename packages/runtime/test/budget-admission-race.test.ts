import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { admitRunToBudget } from '../src/budget.js'
import { deleteSettledBudgetReservations } from '../src/budget-reservations.js'
import { recordInferenceUsage } from '../src/ledger.js'

/**
 * The spend gate as an admission control.
 *
 * Before this, `evaluateBudget` read `token_ledger_events` — which a run only
 * writes once it has already spent — and decided. Every replica admitting in the
 * same instant read the same pre-run total, so the number of runs let past a
 * full budget grew with the number of replicas. `admitRunToBudget` reads and
 * reserves inside one locked transaction, so the second admitter sees the first.
 *
 * DB-backed on purpose: the whole mechanism is a Postgres advisory lock across
 * two connections, which no in-memory client can express.
 */

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

type Fixture = {
  organizationId: string
  runIds: string[]
  agentId: string
  threadId: string
  channelId: string
  teamId: string
  projectId: string
}

const seed = async (prisma: PrismaClient, runCount: number): Promise<Fixture> => {
  const organizationId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  const channelId = randomUUID()
  const threadId = randomUUID()
  const agentId = randomUUID()
  const runIds = Array.from({ length: runCount }, () => randomUUID())

  await prisma.organization.create({ data: { id: organizationId, name: 'Budget admission' } })
  await prisma.project.create({ data: { id: projectId, name: 'Budget admission', organizationId } })
  await prisma.team.create({ data: { id: teamId, name: 'Budget admission', projectId } })
  await prisma.channel.create({
    data: {
      id: channelId,
      label: 'Budget admission',
      organizationId,
      projectId,
      slug: `budget-admission-${channelId}`,
      teamId,
    },
  })
  await prisma.thread.create({ data: { channelId, id: threadId } })
  await prisma.agent.create({ data: { id: agentId, name: 'Budget admission' } })
  for (const id of runIds) {
    await prisma.run.create({ data: { agentId, id, threadId } })
  }
  return { agentId, channelId, organizationId, projectId, runIds, teamId, threadId }
}

const cleanup = async (prisma: PrismaClient, fixture: Fixture): Promise<void> => {
  await prisma.budgetReservation.deleteMany({ where: { organizationId: fixture.organizationId } })
  await prisma.tokenLedgerEvent.deleteMany({ where: { organizationId: fixture.organizationId } })
  await prisma.budget.deleteMany({ where: { organizationId: fixture.organizationId } })
  await prisma.run.deleteMany({ where: { id: { in: fixture.runIds } } })
  await prisma.thread.deleteMany({ where: { id: fixture.threadId } })
  await prisma.channel.deleteMany({ where: { id: fixture.channelId } })
  await prisma.agent.deleteMany({ where: { id: fixture.agentId } })
  await prisma.team.deleteMany({ where: { id: fixture.teamId } })
  await prisma.project.deleteMany({ where: { id: fixture.projectId } })
  await prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
}

// How many admitters race here.
//
// Read the honest limit of this particular test before trusting it: wall-clock
// concurrency does NOT reliably reproduce the bug. Removing the advisory lock
// and running this at two contenders still passed four times in five, and at
// eight it passed five times out of five — the admissions are each only a few
// fast statements, and they tend to queue rather than interleave at the moment
// that matters. So this test demonstrates the ADMITTED-PATH ARITHMETIC (one
// reservation, N-1 refusals, alerts on recorded spend); it is not evidence that
// the lock is present.
//
// The mutual exclusion is proved deterministically instead, by
// 'admission waits for the governing scope's advisory lock' below, which holds
// the exact lock from another connection and shows admission cannot proceed.
// The pair of them together is what covers the guarantee.
const CONTENDERS = 8

runIfDatabase(
  'runs whose ceilings each fit alone but not together: exactly one is admitted',
  async () => {
    const prisma = new PrismaClient()
    const fixture = await seed(prisma, CONTENDERS)
    const { organizationId } = fixture

    try {
      // A $6 cap and N runs that may each spend up to $6. One fits; two do not.
      // Nothing has been recorded yet, so an unlocked read admits every one of
      // them — they all see the same $0.
      await prisma.budget.create({
        data: {
          costLimitUsd: 6,
          mode: 'enforce',
          organizationId,
          period: 'monthly',
          scopeId: organizationId,
          scopeType: 'organization',
        },
      })

      const admit = (runId: string) =>
        admitRunToBudget(
          prisma,
          { organizationId },
          { estimate: { costUsd: 6, tokens: 0 }, isHuman: false, runId },
        )

      const results = await Promise.all(fixture.runIds.map((runId) => admit(runId)))
      const allowed = results.filter((result) => result.decision.action === 'allow')
      assert.equal(
        allowed.length,
        1,
        `exactly one of ${CONTENDERS} concurrent admissions may be allowed, got ${allowed.length}`,
      )
      assert.equal(
        results.filter((result) => result.decision.action === 'block').length,
        CONTENDERS - 1,
      )

      // The admitted one holds the reservation all the others read.
      const reservations = await prisma.budgetReservation.findMany({ where: { organizationId } })
      assert.equal(reservations.length, 1)
      assert.equal(reservations[0]?.reservedCostUsd.toNumber(), 6)

      // And the refusal is sticky while the reservation stands: a later look
      // sees the same $6 in flight, not the $0 the ledger still reports.
      const loser = fixture.runIds.find((id) => id !== reservations[0]?.runId) as string
      assert.equal((await admit(loser)).decision.action, 'block')

      // The alert snapshot reports RECORDED spend, never the reservation — its
      // numbers become the sentence an owner reads.
      for (const result of results) {
        assert.equal(result.alert?.spentUsd, 0)
      }
    } finally {
      await cleanup(prisma, fixture)
      await prisma.$disconnect()
    }
  },
)

runIfDatabase('recording a run\'s usage releases its reservation', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma, 2)
  const { organizationId } = fixture
  const [runA, runB] = fixture.runIds as [string, string]

  try {
    await prisma.budget.create({
      data: {
        costLimitUsd: 6,
        mode: 'enforce',
        organizationId,
        period: 'monthly',
        scopeId: organizationId,
        scopeType: 'organization',
      },
    })

    const admitted = await admitRunToBudget(
      prisma,
      { organizationId },
      { estimate: { costUsd: 6, tokens: 0 }, isHuman: false, runId: runA },
    )
    assert.equal(admitted.decision.action, 'allow')
    assert.equal(await prisma.budgetReservation.count({ where: { runId: runA } }), 1)

    // The run reports what it actually spent. With no pricing profile the
    // estimated cost is null, so the ledger total stays $0 — which is the
    // point: the estimate must be dropped rather than left standing beside it.
    await recordInferenceUsage(prisma, {
      attribution: { actorId: randomUUID(), actorType: 'agent', organizationId, runId: runA },
      invocations: [
        {
          invocationId: randomUUID(),
          latencyMs: 12,
          model: 'test-model',
          operationType: 'chat',
          provider: 'test-provider',
          requestId: randomUUID(),
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      ],
    })

    assert.equal(
      await prisma.budgetReservation.count({ where: { runId: runA } }),
      0,
      'the estimate must go when the real number arrives',
    )

    // With the estimate released and nothing priced, the next run is admitted.
    const next = await admitRunToBudget(
      prisma,
      { organizationId },
      { estimate: { costUsd: 6, tokens: 0 }, isHuman: false, runId: runB },
    )
    assert.equal(next.decision.action, 'allow')
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runIfDatabase('a terminal run stops holding budget, and the sweep frees its row', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma, 2)
  const { organizationId } = fixture
  const [runA, runB] = fixture.runIds as [string, string]

  try {
    await prisma.budget.create({
      data: {
        costLimitUsd: 6,
        mode: 'enforce',
        organizationId,
        period: 'monthly',
        scopeId: organizationId,
        scopeType: 'organization',
      },
    })
    const first = await admitRunToBudget(
      prisma,
      { organizationId },
      { estimate: { costUsd: 6, tokens: 0 }, isHuman: false, runId: runA },
    )
    assert.equal(first.decision.action, 'allow')

    // A run that dies without ever recording usage must not hold the budget
    // hostage until the sweep gets to it: the aggregate ignores it as soon as
    // the run is terminal.
    await prisma.run.update({ data: { status: 'failed' }, where: { id: runA } })
    const second = await admitRunToBudget(
      prisma,
      { organizationId },
      { estimate: { costUsd: 6, tokens: 0 }, isHuman: false, runId: runB },
    )
    assert.equal(second.decision.action, 'allow')

    await prisma.run.update({ data: { status: 'completed' }, where: { id: runB } })
    assert.ok((await deleteSettledBudgetReservations(prisma)) >= 2)
    assert.equal(await prisma.budgetReservation.count({ where: { organizationId } }), 0)
    // Idempotent: a second replica running the same sweep finds nothing left.
    assert.equal(await prisma.budgetReservation.count({ where: { organizationId } }), 0)
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runIfDatabase('a warn budget admits without taking a lock or reserving anything', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma, 1)
  const { organizationId } = fixture
  const [runA] = fixture.runIds as [string]

  try {
    await prisma.budget.create({
      data: {
        costLimitUsd: 1,
        mode: 'warn',
        organizationId,
        period: 'monthly',
        scopeId: organizationId,
        scopeType: 'organization',
      },
    })
    const evaluation = await admitRunToBudget(
      prisma,
      { organizationId },
      { estimate: { costUsd: 6, tokens: 0 }, isHuman: false, runId: runA },
    )
    assert.equal(evaluation.decision.action, 'allow')
    assert.ok(evaluation.alert, 'a warn budget still reports its usage snapshot')
    assert.equal(
      await prisma.budgetReservation.count({ where: { organizationId } }),
      0,
      'an observation must not write rows or queue behind a writer',
    )
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

/**
 * The mutual exclusion itself, proved rather than raced.
 *
 * A wall-clock race cannot demonstrate this (see CONTENDERS above): the
 * admissions are short enough that they usually queue on their own. So this
 * test holds the EXACT advisory lock `admitRunToBudget` takes — same name, same
 * `hashtextextended` derivation — from a second connection, and shows that an
 * admission cannot get past it. If the lock is removed from the gate, the
 * admission sails through while the lock is held and the first assertion fails.
 *
 * The holder uses `pg_advisory_xact_lock` inside an interactive transaction
 * rather than a session-level `pg_advisory_lock`, because Prisma pools
 * connections: a session lock and its unlock could land on two different
 * backends, whereas an interactive transaction keeps one for its whole life.
 */
runIfDatabase("admission waits for the governing scope's advisory lock", async () => {
  const prisma = new PrismaClient()
  const holder = new PrismaClient()
  const fixture = await seed(prisma, 1)
  const { organizationId } = fixture
  const [runA] = fixture.runIds as [string]

  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })

  try {
    await prisma.budget.create({
      data: {
        costLimitUsd: 100,
        mode: 'enforce',
        organizationId,
        period: 'monthly',
        scopeId: organizationId,
        scopeType: 'organization',
      },
    })

    // Take the gate's lock and keep it.
    const lockName = `budget:organization:${organizationId}`
    const holding = holder.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockName}::text, 0))`
        await held
      },
      { timeout: 30_000 },
    )
    // Give the holder a moment to actually acquire it before racing.
    await new Promise((resolve) => setTimeout(resolve, 250))

    const admission = admitRunToBudget(
      prisma,
      { organizationId },
      { estimate: { costUsd: 1, tokens: 0 }, isHuman: false, runId: runA },
    )
    const pending = Symbol('pending')
    const raced = await Promise.race([
      admission.then(() => 'settled' as const),
      new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 1_000)),
    ])
    assert.equal(
      raced,
      pending,
      'admission must block while another session holds the scope lock; it did not, so the gate is not taking it',
    )

    // Released: the admission that was waiting now completes normally.
    release()
    await holding
    const evaluation = await admission
    assert.equal(evaluation.decision.action, 'allow')
    assert.equal(await prisma.budgetReservation.count({ where: { runId: runA } }), 1)
  } finally {
    release()
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
    await holder.$disconnect()
  }
})
