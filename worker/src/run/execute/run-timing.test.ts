import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { InvocationRecord } from '@nessie/runtime'
import { recordRunTimingEvent, summarizeRunTiming } from './run-timing.js'

const invocation = (latencyMs: number): InvocationRecord =>
  ({ latencyMs } as unknown as InvocationRecord)

test('summarizeRunTiming derives every stage from the supplied timestamps', () => {
  const enqueuedAt = new Date('2026-07-23T10:00:00.000Z')
  const claimedAt = new Date('2026-07-23T10:00:02.500Z')
  const finishedAt = new Date('2026-07-23T10:00:15.000Z')

  const summary = summarizeRunTiming({
    enqueuedAt,
    claimedAt,
    finishedAt,
    invocations: [invocation(1200), invocation(800), invocation(4000)],
    toolMs: 3300,
    toolCount: 4,
  })

  assert.equal(summary.queueWaitMs, 2500)
  assert.equal(summary.totalMs, 12_500)
  assert.equal(summary.inferenceMs, 6000)
  assert.equal(summary.inferenceCount, 3)
  assert.equal(summary.toolMs, 3300)
  assert.equal(summary.toolCount, 4)
})

test('summarizeRunTiming is sane with no work and never emits negatives', () => {
  const now = new Date('2026-07-23T10:00:00.000Z')
  // finishedAt < claimedAt (clock skew) and claimedAt < enqueuedAt must clamp.
  const summary = summarizeRunTiming({
    enqueuedAt: new Date(now.getTime() + 50),
    claimedAt: now,
    finishedAt: new Date(now.getTime() - 10),
    invocations: [],
    toolMs: 0,
    toolCount: 0,
  })

  assert.equal(summary.queueWaitMs, 0)
  assert.equal(summary.totalMs, 0)
  assert.equal(summary.inferenceMs, 0)
  assert.equal(summary.inferenceCount, 0)
  assert.equal(summary.toolMs, 0)
  assert.equal(summary.toolCount, 0)
})

const captureTaskEvents = (): { created: unknown[]; prisma: PrismaClient } => {
  const created: unknown[] = []
  const prisma = {
    taskEvent: {
      create: async (arg: unknown) => {
        created.push(arg)
        return arg
      },
    },
  } as unknown as PrismaClient
  return { created, prisma }
}

test('recordRunTimingEvent writes a run.timing task event on completion', async () => {
  const { created, prisma } = captureTaskEvents()

  await recordRunTimingEvent(prisma, {
    taskId: 'task-1',
    runId: 'run-1',
    outcome: 'completed',
    summary: {
      queueWaitMs: 2500,
      totalMs: 12_500,
      inferenceMs: 6000,
      inferenceCount: 3,
      toolMs: 3300,
      toolCount: 4,
    },
  })

  assert.equal(created.length, 1)
  const data = (created[0] as { data: Record<string, unknown> }).data
  assert.equal(data.eventType, 'run.timing')
  assert.equal(data.taskId, 'task-1')
  const payload = data.payload as Record<string, unknown>
  assert.equal(payload.outcome, 'completed')
  assert.equal(payload.runId, 'run-1')
  assert.equal(payload.queueWaitMs, 2500)
  assert.equal(payload.totalMs, 12_500)
  assert.equal(payload.inferenceMs, 6000)
  assert.equal(payload.inferenceCount, 3)
  assert.equal(payload.toolMs, 3300)
  assert.equal(payload.toolCount, 4)
})

test('recordRunTimingEvent also fires on the failure path', async () => {
  const { created, prisma } = captureTaskEvents()

  await recordRunTimingEvent(prisma, {
    taskId: 'task-2',
    runId: 'run-2',
    outcome: 'failed',
    summary: {
      queueWaitMs: 40,
      totalMs: 900,
      inferenceMs: 850,
      inferenceCount: 1,
      toolMs: 0,
      toolCount: 0,
    },
  })

  assert.equal(created.length, 1)
  const payload = (created[0] as { data: { payload: Record<string, unknown> } }).data.payload
  assert.equal(payload.outcome, 'failed')
  assert.equal(payload.runId, 'run-2')
  assert.equal(payload.totalMs, 900)
})
