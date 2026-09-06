import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { withSweepLock } from '@nessie/db'
import { createPgPool } from '@nessie/runtime'
import { PrismaClient } from '@prisma/client'
import type { Pool } from 'pg'

import { maybeSyncRegistry, REGISTRY_SYNC_LOCK } from '../../src/control/registry-sync-sweep.js'
import { runDatabaseTest } from './support.js'

/**
 * The registry sweep's leader election. `maybeSyncRegistry` used to guard a
 * multi-minute walk with a module-scope `inFlight` flag, which is per process
 * by definition: two replicas each held their own, so a scale-out walked the
 * whole registry N times (horizontal-scaling audit 5.9). Only real Postgres
 * can show the replacement working, because the guard is now an advisory lock
 * that a *second database session* is refused.
 *
 * `now` is pushed far into the future in every case here so the run-row
 * freshness checks can never be the thing that skips a walk — which leaves the
 * lock as the only possible reason, and that is what is under test.
 */
const FAR_FUTURE = Date.now() + 3_650 * 24 * 60 * 60 * 1000

const lockPool = (): Pool => createPgPool(process.env.DATABASE_URL!, { max: 2 })

const gate = (): { wait: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait }
}

/**
 * Stands in for the real walk: it writes the run row `syncRegistry` writes, so
 * "how many walks happened" is countable, and the marker keeps that count to
 * this test's own rows on a database that may hold real sync history.
 */
const recordingSync = (marker: string, held?: Promise<void>, onStart?: () => void) =>
  (async (prisma: PrismaClient) => {
    onStart?.()
    await prisma.mcpRegistrySyncRun.create({ data: { source: marker, completedAt: new Date() } })
    if (held) await held
    return { runId: 'run-1', serversFetched: 0, error: null }
  }) as never

runDatabaseTest('a sweep skips while another instance holds the registry lock', async () => {
  const peer = lockPool()
  const pool = lockPool()
  const prisma = new PrismaClient()
  const marker = `test-registry-sync-${randomUUID()}`
  const held = gate()
  const running = gate()

  try {
    // A peer replica, mid-walk: it holds exactly the lock the sweep takes.
    const holder = withSweepLock(peer, REGISTRY_SYNC_LOCK, async () => {
      running.open()
      await held.wait
      return null
    })
    await running.wait

    // Without the lock this replica walks too: the flag it replaced lived in
    // the *peer's* process, so nothing here could see it.
    const outcome = await maybeSyncRegistry(prisma, pool, {
      now: () => FAR_FUTURE,
      runSync: recordingSync(marker),
    })
    assert.equal(outcome.ran, false)
    assert.equal(outcome.ran === false && outcome.reason, 'locked_elsewhere')
    assert.equal(await prisma.mcpRegistrySyncRun.count({ where: { source: marker } }), 0)

    held.open()
    await holder

    // Unlocked when the holder's body returned, so the next tick runs.
    const next = await maybeSyncRegistry(prisma, pool, {
      now: () => FAR_FUTURE,
      runSync: recordingSync(marker),
    })
    assert.equal(next.ran, true)
    assert.equal(await prisma.mcpRegistrySyncRun.count({ where: { source: marker } }), 1)
  } finally {
    held.open()
    await prisma.mcpRegistrySyncRun.deleteMany({ where: { source: marker } })
    await prisma.$disconnect()
    await peer.end()
    await pool.end()
  }
})

runDatabaseTest('a walk that outlives the old lock timeout keeps the lock', async () => {
  // The defect this closes. The lock used to be `pg_try_advisory_xact_lock`
  // inside a Prisma interactive transaction whose `timeout` was `staleMs`.
  // When the walk outlived it, Prisma aborted the transaction — releasing the
  // lock — while the walk itself, a plain promise nobody can cancel, carried
  // on against the caller's own client. A peer's next tick was then granted
  // the lock and started a second walk beside the first: exactly the duplicate
  // the lock exists to prevent, and the registry walk (minutes long, dozens of
  // requests) is the sweep that reaches it in production.
  //
  // `staleMs` is short and the body is long, so this is that window; `now` is
  // in the far future so the run-row checks can never be what skips.
  const prisma = new PrismaClient()
  const peerPrisma = new PrismaClient()
  const pool = lockPool()
  const peerPool = lockPool()
  const marker = `test-registry-sync-${randomUUID()}`
  const running = gate()

  try {
    const walk = maybeSyncRegistry(prisma, pool, {
      now: () => FAR_FUTURE,
      staleMs: 300,
      runSync: recordingSync(marker, delay(2_000), running.open),
    })
    await running.wait
    // Well past the 300 ms the transaction-scoped lock would have lived for.
    await delay(900)

    const peer = await maybeSyncRegistry(peerPrisma, peerPool, {
      now: () => FAR_FUTURE,
      staleMs: 300,
      runSync: recordingSync(marker),
    })
    assert.equal(peer.ran, false)
    assert.equal(peer.ran === false && peer.reason, 'locked_elsewhere')

    const outcome = await walk
    assert.equal(outcome.ran, true)
    // One walk, one run row — the peer never started a second one.
    assert.equal(await prisma.mcpRegistrySyncRun.count({ where: { source: marker } }), 1)
  } finally {
    await prisma.mcpRegistrySyncRun.deleteMany({ where: { source: marker } })
    await prisma.$disconnect()
    await peerPrisma.$disconnect()
    await pool.end()
    await peerPool.end()
  }
})

runDatabaseTest('two concurrent sweeps write one registry run row', async () => {
  const first = new PrismaClient()
  const second = new PrismaClient()
  const firstPool = lockPool()
  const secondPool = lockPool()
  const marker = `test-registry-sync-${randomUUID()}`
  const held = gate()
  const running = gate()

  try {
    const walkA = maybeSyncRegistry(first, firstPool, {
      now: () => FAR_FUTURE,
      runSync: recordingSync(marker, held.wait, running.open),
    })
    await running.wait

    const walkB = await maybeSyncRegistry(second, secondPool, {
      now: () => FAR_FUTURE,
      runSync: recordingSync(marker),
    })
    assert.equal(walkB.ran, false)

    held.open()
    assert.equal((await walkA).ran, true)

    // One walk, one run row — the outcome the 6h cadence exists to produce.
    assert.equal(await first.mcpRegistrySyncRun.count({ where: { source: marker } }), 1)
  } finally {
    held.open()
    await first.mcpRegistrySyncRun.deleteMany({ where: { source: marker } })
    await first.$disconnect()
    await second.$disconnect()
    await firstPool.end()
    await secondPool.end()
  }
})
