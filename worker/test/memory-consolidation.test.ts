import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { LedgerAttribution } from '@nessie/runtime'
import { RunExecuteJobPayloadSchema } from '@nessie/schemas'
import type { Pool } from 'pg'

import {
  buildRunMemoryConsolidationJobPayload,
  enqueueRunMemoryConsolidation,
  executeRunMemoryConsolidationJob,
  MEMORY_CONSOLIDATION_TOPIC,
} from '../src/run/memory-consolidation.js'

type QueryResult = {
  rowCount?: number | null
  rows: Record<string, unknown>[]
}

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const PROJECT_ID = '00000000-0000-4000-8000-000000000002'
const LAUNCH_TEAM_ID = '00000000-0000-4000-8000-000000000003'
const CHANNEL_ID = '00000000-0000-4000-8000-000000000004'
const THREAD_ID = '00000000-0000-4000-8000-000000000005'
const TASK_ID = '00000000-0000-4000-8000-000000000006'
const SOURCE_RUN_ID = '00000000-0000-4000-8000-000000000007'
const PA_AGENT_ID = '00000000-0000-4000-8000-000000000008'
const USER_ID = '00000000-0000-4000-8000-000000000009'
const MESSAGE_ID = '00000000-0000-4000-8000-00000000000a'
const PA_SYSTEM_TEAM_ID = '00000000-0000-4000-8000-00000000000b'
const PA_SYSTEM_PROJECT_ID = '00000000-0000-4000-8000-00000000000c'
const SYSTEM_AGENT_ID = '09a86284-7325-5194-8163-0b5d813407f6'
const SYSTEM_RUN_ID = 'e59b3d88-7a3e-512a-a1a3-cc1680abe674'

const sourcePayload = RunExecuteJobPayloadSchema.parse({
  actorContext: {
    actor: {
      actorId: USER_ID,
      actorType: 'user',
    },
    tenant: {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      teamId: LAUNCH_TEAM_ID,
    },
    actionContext: {
      agentId: PA_AGENT_ID,
      channelId: CHANNEL_ID,
      correlationId: 'launch-correlation',
      effectiveUserId: USER_ID,
      requestId: 'launch-request',
      taskId: TASK_ID,
      teamId: LAUNCH_TEAM_ID,
      threadId: THREAD_ID,
    },
  },
  agentId: PA_AGENT_ID,
  messageId: MESSAGE_ID,
  runId: SOURCE_RUN_ID,
  taskId: TASK_ID,
  threadId: THREAD_ID,
})

const createPoolStub = (
  handler: (
    sql: string,
    params: unknown[] | undefined,
  ) => QueryResult | Promise<QueryResult>,
): Pool => {
  const query = async (sql: string, params?: unknown[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] }
    }
    return handler(sql, params)
  }
  return {
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as Pool
}

test('builds a deterministic system origin from the authenticated launch', () => {
  const first = buildRunMemoryConsolidationJobPayload(sourcePayload)
  const second = buildRunMemoryConsolidationJobPayload(sourcePayload)

  assert.deepEqual(first, second)
  assert.deepEqual(first.origin, {
    actorId: SYSTEM_AGENT_ID,
    actorType: 'system',
    agentId: SYSTEM_AGENT_ID,
    agentKind: 'system',
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    teamId: LAUNCH_TEAM_ID,
    projectId: PROJECT_ID,
    channelId: CHANNEL_ID,
    threadId: THREAD_ID,
    taskId: TASK_ID,
    runId: SYSTEM_RUN_ID,
    requestId: `memory-consolidation:${SOURCE_RUN_ID}`,
    systemComponent: 'memory-consolidation',
    toolCallId: `memory-consolidation:${SOURCE_RUN_ID}:capture`,
  })
  assert.deepEqual(first.source, {
    agentId: PA_AGENT_ID,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    teamId: LAUNCH_TEAM_ID,
    projectId: PROJECT_ID,
    channelId: CHANNEL_ID,
    threadId: THREAD_ID,
    taskId: TASK_ID,
  })
  assert.notEqual(first.origin.agentId, PA_AGENT_ID)
  assert.notEqual(first.origin.runId, SOURCE_RUN_ID)
})

test('scheduled PA work preserves effectiveUserId without a user kickoff', () => {
  const scheduledPayload = RunExecuteJobPayloadSchema.parse({
    ...sourcePayload,
    actorContext: {
      ...sourcePayload.actorContext,
      actor: {
        actorId: PA_AGENT_ID,
        actorType: 'agent',
        roles: ['system'],
      },
    },
  })

  const result = buildRunMemoryConsolidationJobPayload(scheduledPayload)

  assert.equal(result.origin.userId, USER_ID)
  assert.equal(result.origin.teamId, LAUNCH_TEAM_ID)
  assert.equal(result.origin.actorType, 'system')
  assert.equal(result.origin.agentId, SYSTEM_AGENT_ID)
  assert.equal(result.origin.runId, SYSTEM_RUN_ID)
})

test('enqueue persists the origin with a per-source-run idempotency key', async () => {
  const calls: unknown[] = []
  const prisma = {
    $executeRaw: async (query: unknown) => {
      calls.push(query)
      return 1
    },
  } as Pick<PrismaClient, '$executeRaw'>

  const inserted = await enqueueRunMemoryConsolidation(prisma, sourcePayload)

  assert.equal(inserted, true)
  assert.equal(calls.length, 1)
  const sqlCall = calls[0] as { values?: unknown[] }
  assert.ok(sqlCall.values?.includes(MEMORY_CONSOLIDATION_TOPIC))
  assert.ok(
    sqlCall.values?.includes(`memory-run-consolidate:${SOURCE_RUN_ID}`),
  )
  const encodedPayload = sqlCall.values?.find(
    (value): value is string =>
      typeof value === 'string' && value.includes('"origin"'),
  )
  assert.ok(encodedPayload)
  assert.deepEqual(
    JSON.parse(encodedPayload),
    buildRunMemoryConsolidationJobPayload(sourcePayload),
  )
})

test('enqueue fails closed without a durable launch user or team', async () => {
  for (const actorContext of [
    {
      ...sourcePayload.actorContext,
      tenant: {
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      actionContext: {
        ...sourcePayload.actorContext.actionContext,
        teamId: undefined,
      },
    },
    {
      ...sourcePayload.actorContext,
      actor: {
        actorId: PA_AGENT_ID,
        actorType: 'agent' as const,
      },
      actionContext: {
        ...sourcePayload.actorContext.actionContext,
        effectiveUserId: undefined,
      },
    },
  ]) {
    let insertCount = 0
    const prisma = {
      $executeRaw: async () => {
        insertCount += 1
        return 1
      },
    } as unknown as Pick<PrismaClient, '$executeRaw'>
    const incomplete = RunExecuteJobPayloadSchema.parse({
      ...sourcePayload,
      actorContext,
    })

    await assert.rejects(
      enqueueRunMemoryConsolidation(prisma, incomplete),
      /Ledger-routed requests require non-empty/,
    )
    assert.equal(insertCount, 0)
  }
})

test('consumer rejects a legacy payload before database or model access', async () => {
  let databaseCalls = 0
  let modelCalls = 0
  const pool = createPoolStub(() => {
    databaseCalls += 1
    return { rows: [] }
  })

  await assert.rejects(
    executeRunMemoryConsolidationJob(
      {
        captureConfig: {
          modelClient: {
            chatJson: async () => {
              modelCalls += 1
              return {}
            },
            embed: async () => {
              modelCalls += 1
              return []
            },
          },
          pool,
        },
      },
      {
        runId: SOURCE_RUN_ID,
        taskId: TASK_ID,
      },
    ),
    /origin/,
  )

  assert.equal(databaseCalls, 0)
  assert.equal(modelCalls, 0)
})

test('consumer rejects forged system UUIDs before database or model access', async () => {
  const valid = buildRunMemoryConsolidationJobPayload(sourcePayload)
  const replacementId = '00000000-0000-4000-8000-00000000000f'
  let databaseCalls = 0
  let modelCalls = 0
  const pool = createPoolStub(() => {
    databaseCalls += 1
    return { rows: [] }
  })

  const forgedOrigins = [
    { ...valid.origin, actorId: replacementId },
    { ...valid.origin, agentId: replacementId },
    {
      ...valid.origin,
      actorId: replacementId,
      agentId: replacementId,
    },
    { ...valid.origin, runId: replacementId },
  ]
  for (const origin of forgedOrigins) {
    const forged = { ...valid, origin }
    await assert.rejects(
      executeRunMemoryConsolidationJob(
        {
          captureConfig: {
            modelClient: {
              chatJson: async () => {
                modelCalls += 1
                return {}
              },
              embed: async () => {
                modelCalls += 1
                return []
              },
            },
            pool,
          },
        },
        forged,
      ),
      /system actorId|system identity/,
    )
  }

  assert.equal(databaseCalls, 0)
  assert.equal(modelCalls, 0)
})

test('consumer bills the launch team under the named system identities', async () => {
  let insertCount = 0
  const modelUsage: LedgerAttribution[] = []
  const pool = createPoolStub((sql) => {
    if (sql.includes('FROM runs AS r')) {
      return {
        rows: [
          {
            agent_id: PA_AGENT_ID,
            channel_id: CHANNEL_ID,
            finished_at: '2026-05-31T10:00:00.000Z',
            organization_id: ORGANIZATION_ID,
            project_id: PA_SYSTEM_PROJECT_ID,
            run_status: 'completed',
            task_purpose: 'Capture durable rollout facts.',
            task_status: 'done',
            task_title: 'Rollout',
            task_project_id: null,
            team_id: PA_SYSTEM_TEAM_ID,
            thread_id: THREAD_ID,
          },
        ],
      }
    }

    if (sql.includes('FROM messages')) {
      return {
        rows: [
          {
            agent_id: PA_AGENT_ID,
            content: 'The rollout must remain invite-only because capacity is limited.',
            created_at: '2026-05-31T10:00:00.000Z',
            id: '00000000-0000-4000-8000-00000000000d',
            role: 'assistant',
            user_id: null,
          },
          {
            agent_id: null,
            content: 'This unrelated participant must not become the billed user.',
            created_at: '2026-05-31T09:59:00.000Z',
            id: '00000000-0000-4000-8000-00000000000e',
            role: 'user',
            user_id: '00000000-0000-4000-8000-00000000000f',
          },
        ],
      }
    }

    if (sql.includes('SELECT id, metadata FROM thoughts')) {
      return { rows: [] }
    }

    if (sql.includes('INSERT INTO thoughts')) {
      insertCount += 1
      return {
        rows: [
          {
            created_at: '2026-05-31T10:01:00.000Z',
            id: `11111111-1111-4111-8111-11111111111${insertCount}`,
          },
        ],
      }
    }

    if (sql.includes('INSERT INTO thought_audit_logs')) {
      return { rowCount: 1, rows: [] }
    }

    throw new Error(`Unexpected query: ${sql}`)
  })
  const payload = buildRunMemoryConsolidationJobPayload(sourcePayload)

  await executeRunMemoryConsolidationJob(
    {
      captureConfig: {
        modelClient: {
          chatJson: async (_messages, options) => {
            assert.ok(options?.usage)
            modelUsage.push(options.usage)
            return { hasReasoning: false, type: 'constraint' }
          },
          embed: async (_text, options) => {
            assert.ok(options?.usage)
            modelUsage.push(options.usage)
            return [0.1, 0.2, 0.3]
          },
        },
        pool,
      },
    },
    payload,
  )

  assert.ok(insertCount > 0)
  assert.ok(insertCount <= 5)
  assert.ok(modelUsage.length > 0)
  for (const usage of modelUsage) {
    assert.deepEqual(usage, payload.origin)
  }
  assert.ok(modelUsage.every((usage) => usage.teamId === LAUNCH_TEAM_ID))
  assert.ok(modelUsage.every((usage) => usage.teamId !== PA_SYSTEM_TEAM_ID))
  assert.ok(modelUsage.every((usage) => usage.userId === USER_ID))
  assert.ok(modelUsage.every((usage) => usage.agentKind === 'system'))
  assert.ok(modelUsage.every((usage) => usage.toolCallId === payload.origin.toolCallId))
})
