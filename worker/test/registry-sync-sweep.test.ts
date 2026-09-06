import assert from 'node:assert/strict'
import test from 'node:test'

import { REGISTRY_MAX_PAGES, REGISTRY_MAX_RECORDS } from '@nessie/mcp-manage'
import type { PrismaClient } from '@prisma/client'

import { maybeSyncRegistry } from '../src/control/registry-sync-sweep.js'

const NOW = Date.parse('2026-08-30T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

// A minimal SyncRegistryResult; the sweep only forwards it, never reads it.
const FAKE_RESULT = {
  runId: 'run-1',
  serversFetched: 10,
  serversCreated: 3,
  serversUpdated: 2,
  serversSkipped: 5,
  serversFailed: 0,
  error: null,
}

/**
 * A fake prisma with the two surfaces the sweep touches:
 * `mcpRegistrySyncRun.findFirst`, and the interactive transaction
 * `withSweepLock` takes the advisory lock in. The lock is always granted here,
 * so these cases exercise the *decision* — the freshness and liveness windows.
 * The lock's own behaviour needs a second database session and is proved in
 * `test/db/registry-sync-lock.test.ts`.
 */
const prismaWithLatest = (
  latest: { startedAt: Date; completedAt: Date | null } | null,
): PrismaClient =>
  ({
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $queryRaw: async () => [{ locked: true }] }),
    mcpRegistrySyncRun: {
      findFirst: async () => latest,
    },
  }) as unknown as PrismaClient

test('runs when no prior sync run exists', async () => {
  let calls = 0
  let received: unknown = null
  const outcome = await maybeSyncRegistry(prismaWithLatest(null), {
    now: () => NOW,
    intervalMs: 6 * HOUR,
    runSync: (async (_prisma, options) => {
      calls += 1
      received = options
      return FAKE_RESULT
    }) as never,
  })

  assert.equal(outcome.ran, true)
  assert.equal(calls, 1)
  // The scheduled walk is bounded exactly as the CLI's full walk is bounded.
  assert.deepEqual(received, {
    maxPages: REGISTRY_MAX_PAGES,
    maxRecords: REGISTRY_MAX_RECORDS,
    source: 'worker-scheduler',
  })
})

test('runs when the last completed run is older than the window', async () => {
  let calls = 0
  const latest = {
    startedAt: new Date(NOW - 7 * HOUR),
    completedAt: new Date(NOW - 7 * HOUR),
  }
  const outcome = await maybeSyncRegistry(prismaWithLatest(latest), {
    now: () => NOW,
    intervalMs: 6 * HOUR,
    runSync: (async () => {
      calls += 1
      return FAKE_RESULT
    }) as never,
  })

  assert.equal(outcome.ran, true)
  assert.equal(calls, 1)
})

test('skips when a run completed inside the window', async () => {
  let calls = 0
  const latest = {
    startedAt: new Date(NOW - 2 * HOUR),
    completedAt: new Date(NOW - 1 * HOUR),
  }
  const outcome = await maybeSyncRegistry(prismaWithLatest(latest), {
    now: () => NOW,
    intervalMs: 6 * HOUR,
    runSync: (async () => {
      calls += 1
      return FAKE_RESULT
    }) as never,
  })

  assert.equal(outcome.ran, false)
  assert.equal(outcome.ran === false && outcome.reason, 'recently_completed')
  assert.equal(calls, 0)
})

test('skips when a peer run is in progress inside the liveness window', async () => {
  let calls = 0
  const latest = { startedAt: new Date(NOW - 5 * 60 * 1000), completedAt: null }
  const outcome = await maybeSyncRegistry(prismaWithLatest(latest), {
    now: () => NOW,
    intervalMs: 6 * HOUR,
    staleMs: 30 * 60 * 1000,
    runSync: (async () => {
      calls += 1
      return FAKE_RESULT
    }) as never,
  })

  assert.equal(outcome.ran, false)
  assert.equal(outcome.ran === false && outcome.reason, 'peer_in_progress')
  assert.equal(calls, 0)
})

test('supersedes a zombie run that never completed past the liveness window', async () => {
  // The exact production failure this closes: a walk started, wrote its row,
  // then its process died (a deploy, or a killed API-process background sync),
  // leaving `completedAt: null` forever. Past the liveness window the sweep
  // must run a fresh walk rather than treat the corpse as a live peer for 6h.
  let calls = 0
  const latest = { startedAt: new Date(NOW - 45 * 60 * 1000), completedAt: null }
  const outcome = await maybeSyncRegistry(prismaWithLatest(latest), {
    now: () => NOW,
    intervalMs: 6 * HOUR,
    staleMs: 30 * 60 * 1000,
    runSync: (async () => {
      calls += 1
      return FAKE_RESULT
    }) as never,
  })

  assert.equal(outcome.ran, true)
  assert.equal(calls, 1)
})

test('a tick that does not get the lock is skipped, not queued behind the holder', async () => {
  let calls = 0
  const prisma = {
    // `pg_try_advisory_xact_lock` returning false is the whole of "another
    // instance is walking": the body must not run, and nothing waits.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $queryRaw: async () => [{ locked: false }] }),
    mcpRegistrySyncRun: {
      findFirst: async () => {
        throw new Error('the decision must not be read without the lock')
      },
    },
  } as unknown as PrismaClient

  const outcome = await maybeSyncRegistry(prisma, {
    now: () => NOW,
    intervalMs: 6 * HOUR,
    runSync: (async () => {
      calls += 1
      return FAKE_RESULT
    }) as never,
  })

  assert.equal(outcome.ran, false)
  assert.equal(outcome.ran === false && outcome.reason, 'locked_elsewhere')
  assert.equal(calls, 0)
})
