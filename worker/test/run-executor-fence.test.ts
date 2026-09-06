import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  assertExecutorHoldsRun,
  registerExecutorFence,
  RunFencedError,
  updateRunStatus,
  withRunExecutorFence,
} from '../src/run/execute/lifecycle.js'
import { handleRunFailurePath } from '../src/run/execute/run-failure-path.js'

// The fencing half that needs no database: which statement `updateRunStatus`
// issues, what it carries, and what a zero-row result does to the rest of the
// run. The race itself is decided in Postgres and is covered by
// `test/db/run-executor-fencing.test.ts`.

type Call = { data: Record<string, unknown>; where: Record<string, unknown> }

const createPrismaFake = (
  updateManyCounts: number[],
): { prisma: PrismaClient; updateMany: Call[]; update: Call[] } => {
  const update: Call[] = []
  const updateMany: Call[] = []
  const prisma = {
    run: {
      update: async (args: Call) => {
        update.push(args)
        return {}
      },
      updateMany: async (args: Call) => {
        updateMany.push(args)
        return { count: updateManyCounts.shift() ?? 1 }
      },
    },
  } as unknown as PrismaClient
  return { prisma, update, updateMany }
}

test('a run this process does not hold is written unfenced', async () => {
  const runId = randomUUID()
  const fake = createPrismaFake([])

  await updateRunStatus(fake.prisma, runId, 'running')

  assert.equal(fake.updateMany.length, 0)
  assert.equal(fake.update.length, 1)
  assert.deepEqual(fake.update[0]?.where, { id: runId })
})

test('a claimed run carries its executor token into every status write', async () => {
  const runId = randomUUID()
  const token = randomUUID()
  const fake = createPrismaFake([1])

  await withRunExecutorFence(runId, async () => {
    registerExecutorFence(runId, token)
    await updateRunStatus(fake.prisma, runId, 'running')

    assert.equal(fake.update.length, 0, 'an unconditional update would race the other executor')
    assert.deepEqual(fake.updateMany[0]?.where, { id: runId, executorToken: token })
    assertExecutorHoldsRun(runId)
  })

  // The claim lives in the job's async context, so it is gone once the job is.
  await updateRunStatus(fake.prisma, runId, 'running')
  assert.equal(fake.update.length, 1)
})

test('a zero-row status write fences the executor out for the rest of the run', async () => {
  const runId = randomUUID()
  const fake = createPrismaFake([0])

  await withRunExecutorFence(runId, async () => {
    registerExecutorFence(runId, randomUUID())
    await assert.rejects(
      () => updateRunStatus(fake.prisma, runId, 'completed'),
      (error: unknown) => error instanceof RunFencedError && error.runId === runId,
    )

    // The loop's per-iteration probe reads the same fence, so the run is
    // abandoned at the next boundary instead of continuing to do work whose
    // outcome it can no longer record.
    assert.throws(() => assertExecutorHoldsRun(runId), RunFencedError)
    await assert.rejects(
      () => updateRunStatus(fake.prisma, runId, 'failed'),
      (error: unknown) => error instanceof RunFencedError,
    )
    assert.equal(fake.updateMany.length, 1, 'no second statement is sent once fenced')
  })
})

test('the failure path writes nothing for a fenced-out executor', async () => {
  const runId = randomUUID()
  // Every dependency is deliberately a landmine: reaching any of them would
  // mean this executor had started terminalizing a run it no longer owns.
  const caughtError = new RunFencedError(runId)
  const explode = (name: string): object => new Proxy({}, {
    get: (_target, property) => {
      if (property === 'caughtError') return caughtError
      throw new Error(
        `the fenced-out executor must not touch ${name}.${String(property)}`,
      )
    },
  })

  await assert.rejects(
    () => handleRunFailurePath(
      explode('deps') as never,
      explode('payload') as never,
      explode('context') as never,
      explode('input') as never,
    ),
    (error: unknown) => error === caughtError,
  )
})

test('suspending releases the token in the same statement that parks the run', async () => {
  const runId = randomUUID()
  const token = randomUUID()
  const fake = createPrismaFake([1])

  await withRunExecutorFence(runId, async () => {
    registerExecutorFence(runId, token)
    await updateRunStatus(fake.prisma, runId, 'waiting_approval')

    assert.deepEqual(fake.updateMany[0]?.where, { id: runId, executorToken: token })
    assert.equal(fake.updateMany[0]?.data['executorToken'], null)
    // The row no longer carries the token, so this execution stops fencing on
    // it: the resuming executor's claim is the authority from here.
    assert.doesNotThrow(() => assertExecutorHoldsRun(runId))
    await updateRunStatus(fake.prisma, runId, 'running')
    assert.equal(fake.update.length, 1, 'the fence was released with the token')
  })
})
