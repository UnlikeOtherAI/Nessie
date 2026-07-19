import assert from 'node:assert/strict'
import test from 'node:test'

import { RunMemoryConsolidateJobPayloadSchema } from '../memory.js'

const RUN_ID = '00000000-0000-4000-8000-000000000007'
const TASK_ID = '00000000-0000-4000-8000-000000000006'
const requestId = `memory-consolidation:${RUN_ID}`

const payload = {
  runId: RUN_ID,
  taskId: TASK_ID,
  origin: {
    actorId: '09a86284-7325-5194-8163-0b5d813407f6',
    actorType: 'system',
    agentId: '09a86284-7325-5194-8163-0b5d813407f6',
    agentKind: 'system',
    organizationId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000009',
    teamId: '00000000-0000-4000-8000-000000000003',
    projectId: '00000000-0000-4000-8000-000000000002',
    channelId: '00000000-0000-4000-8000-000000000004',
    threadId: '00000000-0000-4000-8000-000000000005',
    taskId: TASK_ID,
    runId: 'e59b3d88-7a3e-512a-a1a3-cc1680abe674',
    requestId,
    correlationId: 'launch-correlation',
    systemComponent: 'memory-consolidation',
    toolCallId: `${requestId}:capture`,
  },
  source: {
    agentId: '00000000-0000-4000-8000-000000000008',
    organizationId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000009',
    teamId: '00000000-0000-4000-8000-000000000003',
    projectId: '00000000-0000-4000-8000-000000000002',
    channelId: '00000000-0000-4000-8000-000000000004',
    threadId: '00000000-0000-4000-8000-000000000005',
    taskId: TASK_ID,
  },
} as const

test('accepts an immutable memory-consolidation system origin', () => {
  assert.deepEqual(RunMemoryConsolidateJobPayloadSchema.parse(payload), payload)
})

test('rejects legacy memory-consolidation payloads without origin', () => {
  assert.equal(
    RunMemoryConsolidateJobPayloadSchema.safeParse({
      runId: RUN_ID,
      taskId: TASK_ID,
    }).success,
    false,
  )
})

test('binds memory-consolidation identity keys to the source run and task', () => {
  for (const invalidPayload of [
    {
      ...payload,
      origin: { ...payload.origin, requestId: 'memory-consolidation:other-run' },
    },
    {
      ...payload,
      origin: { ...payload.origin, toolCallId: `${requestId}:other-operation` },
    },
    {
      ...payload,
      origin: {
        ...payload.origin,
        taskId: '00000000-0000-4000-8000-00000000000a',
      },
    },
    {
      ...payload,
      origin: {
        ...payload.origin,
        teamId: '00000000-0000-4000-8000-00000000000b',
      },
    },
  ]) {
    assert.equal(
      RunMemoryConsolidateJobPayloadSchema.safeParse(invalidPayload).success,
      false,
    )
  }
})
