import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { loadAgentRunFailures } from '../src/services/agent-read-model.js'

const agentId = '00000000-0000-4000-8000-000000000001'
const runId1 = '00000000-0000-4000-8000-000000000002'
const runId2 = '00000000-0000-4000-8000-000000000003'
const runId3 = '00000000-0000-4000-8000-000000000004'

const makeRun = (id: string, finishedAt: string) => ({ finishedAt: new Date(finishedAt), id })

const makeEvent = (
  runId: string,
  message: string,
  createdAt: string,
  payloadOverride?: unknown,
) => ({
  createdAt: new Date(createdAt),
  eventType: 'run.failed',
  id: `${runId}-event`,
  payload: payloadOverride ?? { message },
  task: { runId },
  taskId: `${runId}-task`,
})

const makePrisma = (
  runs: ReturnType<typeof makeRun>[],
  events: ReturnType<typeof makeEvent>[],
) =>
  ({
    run: {
      findMany: async (args: {
        orderBy?: unknown
        select?: unknown
        take?: number
        where?: unknown
      }) => {
        const take = args.take ?? runs.length
        return runs.slice().sort(
          (left, right) => right.finishedAt.getTime() - left.finishedAt.getTime(),
        ).slice(0, take)
      },
    },
    taskEvent: {
      findMany: async () =>
        events.slice().sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        ),
    },
  }) as unknown as PrismaClient

test('returns the latest run.failed event for each unattended failed run', async () => {
  const prisma = makePrisma(
    [
      makeRun(runId1, '2026-09-16T16:30:00.000Z'),
      makeRun(runId2, '2026-09-16T07:00:00.000Z'),
    ],
    [
      makeEvent(runId1, 'codex-subscription chat request failed with HTTP 400', '2026-09-16T16:30:00.000Z'),
      makeEvent(runId2, 'another failure', '2026-09-16T07:00:00.000Z'),
    ],
  )

  const failures = await loadAgentRunFailures(prisma, agentId)

  assert.equal(failures.length, 2)
  assert.equal(failures[0].runId, runId1)
  assert.equal(failures[0].message, 'codex-subscription chat request failed with HTTP 400')
  assert.equal(failures[0].failedAt, '2026-09-16T16:30:00.000Z')
  assert.equal(failures[1].runId, runId2)
  assert.equal(failures[1].message, 'another failure')
})

test('omits failed unattended runs that have no run.failed task event', async () => {
  const prisma = makePrisma(
    [makeRun(runId1, '2026-09-16T16:30:00.000Z'), makeRun(runId2, '2026-09-16T07:00:00.000Z')],
    [makeEvent(runId2, 'only this one logged', '2026-09-16T07:00:00.000Z')],
  )

  const failures = await loadAgentRunFailures(prisma, agentId)

  assert.equal(failures.length, 1)
  assert.equal(failures[0].runId, runId2)
})

test('uses only the latest run.failed event when multiple events exist for one run', async () => {
  const prisma = makePrisma(
    [makeRun(runId1, '2026-09-16T16:30:00.000Z')],
    [
      makeEvent(runId1, 'older', '2026-09-16T16:29:00.000Z'),
      makeEvent(runId1, 'newest', '2026-09-16T16:30:00.000Z'),
    ],
  )

  const failures = await loadAgentRunFailures(prisma, agentId)

  assert.equal(failures.length, 1)
  assert.equal(failures[0].message, 'newest')
})

test('respects the limit', async () => {
  const prisma = makePrisma(
    [
      makeRun(runId1, '2026-09-16T16:30:00.000Z'),
      makeRun(runId2, '2026-09-16T07:00:00.000Z'),
      makeRun(runId3, '2026-09-15T07:00:00.000Z'),
    ],
    [
      makeEvent(runId1, 'first', '2026-09-16T16:30:00.000Z'),
      makeEvent(runId2, 'second', '2026-09-16T07:00:00.000Z'),
      makeEvent(runId3, 'third', '2026-09-15T07:00:00.000Z'),
    ],
  )

  const failures = await loadAgentRunFailures(prisma, agentId, { limit: 2 })

  assert.equal(failures.length, 2)
  assert.equal(failures[0].runId, runId1)
  assert.equal(failures[1].runId, runId2)
})

test('falls back to a generic message when the event payload has no message', async () => {
  const prisma = makePrisma(
    [makeRun(runId1, '2026-09-16T16:30:00.000Z')],
    [makeEvent(runId1, 'ignored', '2026-09-16T16:30:00.000Z', { unrelated: true })],
  )

  const failures = await loadAgentRunFailures(prisma, agentId)

  assert.equal(failures.length, 1)
  assert.equal(failures[0].message, 'Run failed')
})
