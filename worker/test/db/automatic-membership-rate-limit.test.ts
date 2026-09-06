import assert from 'node:assert/strict'

import { PrismaClient } from '@prisma/client'

import {
  awaitUpstreamSlot,
  resetUpstreamRateLimit,
  tryUpstreamSlot,
  UPSTREAM_RATE_LIMITS,
} from '../../src/control/automatic-membership/rate-limit.js'
import { runDatabaseTest } from './support.js'

/**
 * The automatic-membership pacer, driven by TWO clients against ONE database —
 * the two-worker shape (audit 5.6, plan row 5.3).
 *
 * A stub cannot prove any of this. The defect being fixed was that both caps
 * lived in a module-scope `Map`, so every extra worker multiplied them: the
 * "whole instance" cap became `20 × N` calls per second against UOA, and one
 * organisation reconciled by two workers got `5 × N`. Two clients sharing one
 * Postgres is the smallest arrangement in which that difference is visible at
 * all, which is why these cases live here rather than beside the unit suites.
 *
 * The rate assertion is exact rather than timed: `tryUpstreamSlot` reports the
 * one-second window each cap was charged in, so admissions are grouped by the
 * limiter's own window rather than by a wall clock that could attribute a call
 * to the wrong side of a boundary. A slow machine changes how many windows a
 * run spans; it cannot change how many slots a window handed out.
 *
 * These cases own their database in one respect beyond the note in
 * `support.ts`: the deployment-wide bucket is a single row shared by every
 * organisation, so `resetUpstreamRateLimit` discards allowance any other actor
 * on the same database would be relying on.
 */

type ChargedWindows = { deployment: number; org: number }

/** Drive one client until it has been admitted `count` times, recording windows. */
const takeSlots = async (
  store: PrismaClient,
  organizationId: string,
  count: number,
  admissions: ChargedWindows[],
): Promise<void> => {
  let taken = 0
  while (taken < count) {
    const slot = await tryUpstreamSlot(store, organizationId)
    if (slot.admitted) {
      // Never null unless the limiter failed open on a store error, which would
      // otherwise let this suite pass while measuring nothing.
      assert.notEqual(slot.windows, null, 'an admitted slot names the windows it charged')
      admissions.push(slot.windows as ChargedWindows)
      taken += 1
      continue
    }
    await new Promise((resolve) => { setTimeout(resolve, slot.retryInMs) })
  }
}

const busiestWindow = (windows: number[]): number => {
  const perWindow = new Map<number, number>()
  for (const window of windows) perWindow.set(window, (perWindow.get(window) ?? 0) + 1)
  return Math.max(...perWindow.values())
}

runDatabaseTest(
  'the deployment-wide UOA cap is one cap, not one per worker',
  async (t) => {
    // Two clients, two connection pools: as close to two worker processes as a
    // single test process gets, and the only thing the old module-scope buckets
    // could not tell apart.
    const workerA = new PrismaClient()
    const workerB = new PrismaClient()
    t.after(async () => {
      await resetUpstreamRateLimit(workerA).catch(() => undefined)
      await Promise.all([workerA.$disconnect(), workerB.$disconnect()])
    })
    await resetUpstreamRateLimit(workerA)

    // Eight distinct organisations, so the per-organisation cap (5/s) is never
    // the binding constraint and what is measured is purely the wider one.
    const organizations = Array.from({ length: 8 }, (_, index) => `rl-org-${index}`)
    const perOrganization = 6
    const admissions: ChargedWindows[] = []
    await Promise.all(
      organizations.map((organizationId, index) =>
        takeSlots(
          index % 2 === 0 ? workerA : workerB,
          organizationId,
          perOrganization,
          admissions,
        )),
    )

    assert.equal(admissions.length, organizations.length * perOrganization)
    const busiest = busiestWindow(admissions.map((charged) => charged.deployment))
    assert.ok(
      busiest <= UPSTREAM_RATE_LIMITS.deployment.max,
      `two workers admitted ${busiest} calls in one window; the deployment-wide cap is `
      + `${UPSTREAM_RATE_LIMITS.deployment.max} and must not become that many per worker`,
    )
  },
)

runDatabaseTest(
  'the per-organisation UOA cap is one cap, not one per worker',
  async (t) => {
    const workerA = new PrismaClient()
    const workerB = new PrismaClient()
    t.after(async () => {
      await resetUpstreamRateLimit(workerA).catch(() => undefined)
      await Promise.all([workerA.$disconnect(), workerB.$disconnect()])
    })
    await resetUpstreamRateLimit(workerA)

    // Both workers reconciling the SAME organisation, which is what a re-claimed
    // or duplicated reconciliation job produces.
    const organizationId = 'rl-shared-org'
    const admissions: ChargedWindows[] = []
    await Promise.all([
      takeSlots(workerA, organizationId, 9, admissions),
      takeSlots(workerB, organizationId, 9, admissions),
    ])

    assert.equal(admissions.length, 18)
    const busiest = busiestWindow(admissions.map((charged) => charged.org))
    assert.ok(
      busiest <= UPSTREAM_RATE_LIMITS.org.max,
      `two workers admitted ${busiest} calls for one organisation in one window; the cap `
      + `is ${UPSTREAM_RATE_LIMITS.org.max} however many workers are reconciling it`,
    )
  },
)

runDatabaseTest(
  'awaitUpstreamSlot waits without holding a pooled connection',
  async (t) => {
    // One connection. If a waiter held its connection (or a transaction) across
    // the sleep, no other waiter could ever reach the store and this would hang
    // rather than fail — which is how N instances exhaust a pool.
    const url = new URL(process.env.DATABASE_URL as string)
    url.searchParams.set('connection_limit', '1')
    const worker = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    t.after(async () => {
      await resetUpstreamRateLimit(worker).catch(() => undefined)
      await worker.$disconnect()
    })
    await resetUpstreamRateLimit(worker)

    // Three times the per-organisation allowance, so the run needs three windows
    // and therefore crosses two boundaries: whatever the machine's load, the
    // elapsed time cannot be under one whole window. `awaitUpstreamSlot` blocks
    // rather than throwing, because its callers pace a walk over a roster and
    // have nowhere to put a refusal.
    const organizationId = 'rl-pool-org'
    const waiters = UPSTREAM_RATE_LIMITS.org.max * 3
    const startedAt = Date.now()
    await Promise.all(
      Array.from({ length: waiters }, () => awaitUpstreamSlot(worker, organizationId)),
    )
    const elapsed = Date.now() - startedAt

    assert.ok(
      elapsed > UPSTREAM_RATE_LIMITS.org.windowMs,
      `${waiters} calls at ${UPSTREAM_RATE_LIMITS.org.max} per window must span more `
      + `than one window; the run took ${elapsed}ms`,
    )
    // And the waiting was decided in Postgres, not in this process. The live
    // window's row is still there: the pacer's own prune only removes windows
    // that have already passed, and nothing calls it after the last admission.
    const [row] = await worker.$queryRaw<Array<{ windows: bigint }>>`
      SELECT COUNT(*)::bigint AS windows
      FROM "rate_limit_buckets"
      WHERE "bucket" = 'uoa.automatic_membership.org'
    `
    assert.ok(
      Number(row?.windows ?? 0) >= 1,
      'the organisation cap left no row behind, so it was not the database that paced',
    )
  },
)
