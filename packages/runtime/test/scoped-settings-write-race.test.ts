import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { writeScopedSetting } from '../src/scoped-settings.js'

/**
 * Two people (or one person and a retry that landed on a second replica) saving
 * the same setting at the same moment.
 *
 * `writeScopedSetting` is find-then-create inside a transaction. The table's
 * partial unique indexes mean the loser of that race cannot create a duplicate
 * row — it gets a unique violation instead, and an ordinary Save fails with an
 * opaque error. The per-target `pg_advisory_xact_lock` is what turns the loser
 * into an update of the winner's row.
 *
 * DB-backed on purpose: two Prisma interactive transactions on two pooled
 * connections is the only way to observe the interleaving. A fake client runs
 * them sequentially and can never fail.
 */

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

runIfDatabase(
  'concurrent saves of one setting both succeed and leave a single row',
  async () => {
    const prisma = new PrismaClient()
    const organizationId = randomUUID()
    const actorId = randomUUID()
    const key = 'calls.provider'

    try {
      await prisma.organization.create({
        data: { id: organizationId, name: 'Scoped setting write race' },
      })

      const save = (value: string, locked: boolean) =>
        writeScopedSetting(prisma, {
          key,
          locked,
          organizationId,
          scope: 'organization',
          updatedByUserId: actorId,
          value,
        })

      // Both writers target a key that does not exist yet, so both find nothing
      // and both try to create. Without the lock exactly one of these rejects
      // with P2002 (unique constraint `scoped_settings_org_scope_key`).
      const outcomes = await Promise.allSettled([save('daily', true), save('livekit', false)])
      const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
      assert.deepEqual(
        failures.map((failure) => String((failure as PromiseRejectedResult).reason)),
        [],
        'a concurrent save must not fail; the second writer should update the first row',
      )

      const rows = await prisma.scopedSetting.findMany({ where: { organizationId, key } })
      assert.equal(rows.length, 1, 'one row per (organisation, key) at organisation scope')

      // The survivor is a whole write, not a mix: the value and the lock flag
      // come from the same caller, because the second writer read the first's
      // committed row before overwriting it.
      const row = rows[0]
      assert.ok(row)
      const pairs = [
        { locked: true, value: 'daily' },
        { locked: false, value: 'livekit' },
      ]
      assert.ok(
        pairs.some((pair) => pair.value === row.value && pair.locked === row.locked),
        `expected one writer's value+lock pair, got ${JSON.stringify(row.value)}/${row.locked}`,
      )
    } finally {
      await prisma.scopedSetting.deleteMany({ where: { organizationId } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.$disconnect()
    }
  },
)

runIfDatabase(
  'a save racing an existing row updates it rather than colliding with it',
  async () => {
    const prisma = new PrismaClient()
    const organizationId = randomUUID()
    const actorId = randomUUID()
    const key = 'browser.connection'

    try {
      await prisma.organization.create({
        data: { id: organizationId, name: 'Scoped setting update race' },
      })
      await writeScopedSetting(prisma, {
        key,
        locked: false,
        organizationId,
        scope: 'organization',
        updatedByUserId: actorId,
        value: 'first',
      })

      // Four writers against a row that already exists. Every one of them is an
      // update, so this passes with or without the lock — it is here to prove
      // the lock did not turn a working path into a deadlock or a lost write.
      const results = await Promise.all(
        ['a', 'b', 'c', 'd'].map((value) =>
          writeScopedSetting(prisma, {
            key,
            locked: true,
            organizationId,
            scope: 'organization',
            updatedByUserId: actorId,
            value,
          }),
        ),
      )
      assert.equal(results.length, 4)

      const rows = await prisma.scopedSetting.findMany({ where: { organizationId, key } })
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.locked, true)
    } finally {
      await prisma.scopedSetting.deleteMany({ where: { organizationId } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.$disconnect()
    }
  },
)

/**
 * The mutual exclusion itself, proved rather than raced.
 *
 * The race above reproduces the P2002 only when the two writers genuinely
 * interleave, which depends on machine load: with the lock removed it failed
 * inside the full suite but passed five times out of five on its own. So it
 * covers the OUTCOME (both callers succeed, one row survives, value and lock
 * flag come from one writer) while this test covers the MECHANISM — it holds
 * the exact per-target lock `writeScopedSetting` takes, on another connection,
 * and shows the write cannot get past it. With the lock removed the write
 * completes immediately and the first assertion fails.
 *
 * `pg_advisory_xact_lock` inside an interactive transaction, not a session-level
 * `pg_advisory_lock`: Prisma pools connections, so a session lock and its unlock
 * could land on different backends.
 */
runIfDatabase('a write waits for its own target\'s advisory lock', async () => {
  const prisma = new PrismaClient()
  const holder = new PrismaClient()
  const organizationId = randomUUID()
  const actorId = randomUUID()
  const key = 'calls.locked-target'

  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  // Resolved by the holder once the lock is actually its own. Waiting on a
  // fixed sleep instead raced the very thing under test: on a loaded runner
  // the holder could still be acquiring when the assertion started, the
  // contender sailed through, and the failure read as "the gate is not taking
  // the lock" when the gate was fine. It failed CI twice on an admin-only
  // branch in September 2026.
  let acquired!: () => void
  const holdsLock = new Promise<void>((resolve) => {
    acquired = resolve
  })

  try {
    await prisma.organization.create({
      data: { id: organizationId, name: 'Scoped setting lock' },
    })

    // Exactly the name `settingLockName` builds for an organisation-scope write:
    // no team, no user, so both trailing segments are empty.
    const lockName = `scoped-setting:${organizationId}:${key}:organization::`
    const holding = holder.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockName}::text, 0))`
        acquired()
        await held
      },
      { timeout: 30_000 },
    )
    // Bounded by the holder's own transaction timeout rather than by a guess:
    // if it ends or fails without ever taking the lock, this says so instead
    // of hanging. `holderEnded` handles both settlements, so the loser of the
    // race never becomes an unhandled rejection.
    const holderEnded = holding.then(() => 'ended' as const, () => 'failed' as const)
    assert.equal(
      await Promise.race([holdsLock.then(() => 'acquired' as const), holderEnded]),
      'acquired',
      'the holder must own the lock before the contender starts',
    )

    const write = writeScopedSetting(prisma, {
      key,
      locked: false,
      organizationId,
      scope: 'organization',
      updatedByUserId: actorId,
      value: 'blocked',
    })
    const pending = Symbol('pending')
    const raced = await Promise.race([
      write.then(() => 'settled' as const),
      new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 1_000)),
    ])
    assert.equal(
      raced,
      pending,
      'the write must block while another session holds this target\'s lock; it did not, so the write is not taking it',
    )

    release()
    await holding
    await write
    const rows = await prisma.scopedSetting.findMany({ where: { organizationId, key } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.value, 'blocked')
  } finally {
    release()
    await prisma.scopedSetting.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
    await holder.$disconnect()
  }
})
