import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma, PrismaClient } from '@prisma/client'

import {
  runDeepWaterEnablementTransition,
  runWithDeepWaterTransitionLock,
} from '../src/services/deepwater-activation.js'

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

const deferred = (): Deferred => {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * Model PostgreSQL's transaction-scoped advisory lock: each transaction blocks
 * at its first raw query until the preceding transaction has completed.
 */
const serializedPrisma = (): {
  prisma: PrismaClient
  queries: Prisma.Sql[]
} => {
  let predecessor = Promise.resolve()
  const queries: Prisma.Sql[] = []
  const prisma = {
    $transaction: async <T>(
      action: (tx: { $executeRaw: (query: Prisma.Sql) => Promise<number> }) => Promise<T>,
    ): Promise<T> => {
      const waitForLock = predecessor
      const release = deferred()
      predecessor = release.promise
      const tx = {
        $executeRaw: async (query: Prisma.Sql): Promise<number> => {
          queries.push(query)
          await waitForLock
          return 0
        },
      }
      try {
        return await action(tx)
      } finally {
        release.resolve()
      }
    },
  } as unknown as PrismaClient
  return { prisma, queries }
}

test('opposite DeepWater transitions serialize and preserve the toggle/tool invariant', async () => {
  const { prisma, queries } = serializedPrisma()
  const scope = { organizationId: 'org-a', teamId: 'team-a' }
  const disablePaused = deferred()
  const resumeDisable = deferred()
  const events: string[] = []
  let enabled = true
  let toolsCallable = true
  let enableEntered = false

  const disable = runWithDeepWaterTransitionLock(prisma, scope, () =>
    runDeepWaterEnablementTransition(false, {
      provision: async () => {},
      teardown: async () => {
        events.push('disable:teardown')
        toolsCallable = false
        disablePaused.resolve()
        await resumeDisable.promise
      },
      persist: async () => {
        events.push('disable:persist')
        enabled = false
        return { enabled }
      },
    }))

  await disablePaused.promise
  const enable = runWithDeepWaterTransitionLock(prisma, scope, () => {
    enableEntered = true
    return runDeepWaterEnablementTransition(true, {
      provision: async () => {
        events.push('enable:provision')
        toolsCallable = true
      },
      teardown: async () => {},
      persist: async () => {
        events.push('enable:persist')
        enabled = true
        return { enabled }
      },
    })
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(enableEntered, false, 'opposite transition must wait for the DB lock')
  resumeDisable.resolve()
  await Promise.all([disable, enable])

  assert.deepEqual(events, [
    'disable:teardown',
    'disable:persist',
    'enable:provision',
    'enable:persist',
  ])
  assert.equal(enabled, true)
  assert.equal(toolsCallable, true)
  assert.equal(enabled, toolsCallable)

  const lockSql = queries[0]
  assert.match(lockSql?.strings.join('?') ?? '', /pg_advisory_xact_lock/)
  assert.match(lockSql?.strings.join('?') ?? '', /hashtextextended/)
  assert.equal(lockSql?.values[0], 'org-a:team-a:deep-water')
})
