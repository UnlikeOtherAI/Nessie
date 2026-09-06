import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import { sweepStrandedReconciliations } from '../../src/control/automatic-membership/revalidate.js'
import { runDatabaseTest } from './support.js'

/**
 * The stranded-reconciliation sweep's claim (horizontal-scaling audit 5.5).
 *
 * `step` is the sole source of a reconciliation's queue idempotency keys, and
 * the sweep used to advance it with an unconditional `update`. Every replica
 * sweeping the same snapshot therefore advanced it to a *different* value and
 * enqueued a *different* key, so the queue's unique index — the thing that
 * exists to collapse duplicate enqueues — never saw a conflict and one
 * stranded run became N reconcile jobs. Real Postgres, because the fix is a
 * conditional `UPDATE` and a stub cannot lose a race it is not in.
 */
const STRANDED_MS = 10 * 60 * 1000

type Seed = {
  organizationId: string
  reconciliationId: string
  cleanup: () => Promise<void>
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `stranded reconcile ${suffix}` },
  })
  const domain = await prisma.automaticMembershipDomain.create({
    data: {
      challenge: `challenge-${suffix}`,
      challengeExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      challengeIssuedAt: new Date(),
      domain: `${suffix.slice(0, 8)}.example.com`,
      organizationId: organization.id,
      status: 'verified',
    },
  })
  const reconciliation = await prisma.automaticMembershipReconciliation.create({
    data: {
      authorizedByUoaSub: `uoa-sub-${suffix}`,
      authorizedTeamId: `uoa-team-${suffix}`,
      authorizedTokenVersion: 1,
      domainId: domain.id,
      ruleIds: [],
      status: 'running',
      step: 0,
    },
  })
  return {
    cleanup: async () => {
      await prisma.$executeRaw(Prisma.sql`
        DELETE FROM queue_jobs
        WHERE idempotency_key LIKE ${`auto-membership:reconcile:${reconciliation.id}:%`}
      `)
      await prisma.organization.delete({ where: { id: organization.id } }).catch(() => undefined)
    },
    organizationId: organization.id,
    reconciliationId: reconciliation.id,
  }
}

/**
 * Make the run look stranded. `updatedAt` is `@updatedAt`, so Prisma stamps it
 * on every write and the only way to age a row is raw SQL.
 */
const strand = async (prisma: PrismaClient, id: string, ageMs: number): Promise<void> => {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE automatic_membership_reconciliations
    SET updated_at = now() - (${ageMs} * interval '1 millisecond')
    WHERE id = ${id}::uuid
  `)
}

const enqueuedSteps = async (prisma: PrismaClient, id: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<{ idempotency_key: string }[]>(Prisma.sql`
    SELECT idempotency_key FROM queue_jobs
    WHERE idempotency_key LIKE ${`auto-membership:reconcile:${id}:%`}
    ORDER BY idempotency_key
  `)
  return rows.map((row) => row.idempotency_key)
}

runDatabaseTest('the sweep that wins the claim enqueues exactly one job', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    await strand(prisma, s.reconciliationId, 2 * STRANDED_MS)

    // The sweep is global, so its return count belongs to the whole database;
    // every assertion below is scoped to this run's own keys.
    assert.ok((await sweepStrandedReconciliations(prisma, true)) >= 1)
    assert.deepEqual(await enqueuedSteps(prisma, s.reconciliationId), [
      `auto-membership:reconcile:${s.reconciliationId}:1`,
    ])

    // The claim also moved the row on, so an immediate second tick finds
    // nothing here: `updatedAt` is fresh again.
    await sweepStrandedReconciliations(prisma, true)
    assert.deepEqual(await enqueuedSteps(prisma, s.reconciliationId), [
      `auto-membership:reconcile:${s.reconciliationId}:1`,
    ])
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a sweep that loses the claim advances nothing and enqueues nothing', async () => {
  const prisma = new PrismaClient()
  const peer = new PrismaClient()
  const s = await seed(prisma)
  try {
    await strand(prisma, s.reconciliationId, 2 * STRANDED_MS)

    // A peer replica claims the step between this sweep's read and its write —
    // the interleaving the unconditional `update` could not survive. The peer
    // re-ages the row afterwards so `step` is the *only* predicate that fails,
    // which is precisely the compare-and-set under test.
    let races = 0
    const raced = prisma.$extends({
      query: {
        automaticMembershipReconciliation: {
          findMany: async ({ args, query }) => {
            const rows = await query(args)
            if (races === 0) {
              races += 1
              await peer.automaticMembershipReconciliation.update({
                data: { step: 1 },
                where: { id: s.reconciliationId },
              })
              await strand(peer, s.reconciliationId, 2 * STRANDED_MS)
            }
            return rows
          },
        },
      },
    }) as unknown as PrismaClient

    await sweepStrandedReconciliations(raced, true)
    assert.equal(races, 1)
    // Without the conditional claim this sweep would have incremented to 2 and
    // minted a second idempotency key for one stranded run.
    assert.deepEqual(await enqueuedSteps(prisma, s.reconciliationId), [])
    const after = await prisma.automaticMembershipReconciliation.findUniqueOrThrow({
      select: { step: true },
      where: { id: s.reconciliationId },
    })
    assert.equal(after.step, 1)
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
    await peer.$disconnect()
  }
})
