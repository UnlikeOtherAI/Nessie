import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { withSweepLock } from '../src/sweep-lock.js'

/**
 * An advisory lock has no honest stub: the whole point is that a *second*
 * database session cannot take it, and a fake would be asserting against the
 * fake. So these run against real Postgres, with two `PrismaClient`s standing
 * in for two replicas — one client's own pool would happily hand both
 * transactions the same session under some settings, which is exactly the
 * thing that must not decide the outcome.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

/** A promise plus the function that settles it, for gating a held lock. */
const gate = (): { wait: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait }
}

runDatabaseTest('the second instance skips its tick while the first holds the lock', async () => {
  const first = new PrismaClient()
  const second = new PrismaClient()
  // Unique per run, so a suite running beside this one cannot collide.
  const name = `sweep-lock-test:${randomUUID()}`
  const held = gate()
  const running = gate()
  let bodies = 0

  try {
    const holder = withSweepLock(first, name, async () => {
      bodies += 1
      running.open()
      await held.wait
      return 'first'
    })
    await running.wait

    const contender = await withSweepLock(second, name, async () => {
      bodies += 1
      return 'second'
    })
    // Skipped, not queued and not thrown: `pg_try_advisory_xact_lock` returns
    // false rather than waiting, and the body never runs.
    assert.equal(contender.ran, false)
    assert.equal(bodies, 1)

    held.open()
    const outcome = await holder
    assert.equal(outcome.ran, true)
    assert.equal(outcome.ran === true && outcome.result, 'first')

    // Transaction-scoped, so the lock is gone the moment the holder's
    // transaction ends — the next tick runs rather than being wedged out by a
    // session lock nobody remembered to release.
    const afterRelease = await withSweepLock(second, name, async () => 'third')
    assert.equal(afterRelease.ran, true)
    assert.equal(afterRelease.ran === true && afterRelease.result, 'third')
  } finally {
    held.open()
    await first.$disconnect()
    await second.$disconnect()
  }
})

runDatabaseTest('different names do not contend, and a throwing body releases', async () => {
  const first = new PrismaClient()
  const second = new PrismaClient()
  const suffix = randomUUID()
  const held = gate()
  const running = gate()

  try {
    const holder = withSweepLock(first, `sweep-lock-a:${suffix}`, async () => {
      running.open()
      await held.wait
      return 'a'
    })
    await running.wait

    // Hashed per name, so one slow sweep cannot starve an unrelated one.
    const other = await withSweepLock(second, `sweep-lock-b:${suffix}`, async () => 'b')
    assert.equal(other.ran, true)

    held.open()
    await holder

    const boom = new Error('sweep body failed')
    await assert.rejects(
      withSweepLock(first, `sweep-lock-a:${suffix}`, async () => {
        throw boom
      }),
      /sweep body failed/,
    )
    // The lock has to be released by the failure too, or one bad tick locks the
    // sweep out of the cluster until the process restarts.
    const afterThrow = await withSweepLock(second, `sweep-lock-a:${suffix}`, async () => 'ok')
    assert.equal(afterThrow.ran, true)
  } finally {
    held.open()
    await first.$disconnect()
    await second.$disconnect()
  }
})
