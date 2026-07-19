import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { RunExecuteJobPayloadSchema } from '@nessie/schemas'

import { queueTriggerRun } from '../src/control/trigger-run.js'
import { buildRunMemoryConsolidationJobPayload } from '../src/run/memory-consolidation.js'
import { runScheduleTaskTool } from '../src/run/schedule-tools.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001'
const PROJECT_ID = '10000000-0000-4000-8000-000000000002'
const TEAM_ID = '10000000-0000-4000-8000-000000000003'
const CHANNEL_ID = '10000000-0000-4000-8000-000000000004'
const THREAD_ID = '10000000-0000-4000-8000-000000000005'
const USER_ID = '10000000-0000-4000-8000-000000000006'
const PA_AGENT_ID = '10000000-0000-4000-8000-000000000007'
const TRIGGER_ID = '10000000-0000-4000-8000-000000000008'
const DELIVERY_ID = '10000000-0000-4000-8000-000000000009'
const MESSAGE_ID = '10000000-0000-4000-8000-00000000000a'
const RUN_ID = '10000000-0000-4000-8000-00000000000b'
const TASK_ID = '10000000-0000-4000-8000-00000000000c'

const createSchedule = async (): Promise<Record<string, unknown>> => {
  let savedConfig: Record<string, unknown> | null = null
  const prisma = {
    agentTrigger: {
      count: async () => 0,
      create: async (args: { data: { config: Record<string, unknown> } }) => {
        savedConfig = args.data.config
        return { id: TRIGGER_ID }
      },
    },
  }
  const context = {
    agentId: PA_AGENT_ID,
    agentKind: 'personal_assistant',
    actorContext: {
      actor: { actorId: PA_AGENT_ID, actorType: 'agent', roles: ['system'] },
      actionContext: {
        agentId: PA_AGENT_ID,
        channelId: CHANNEL_ID,
        effectiveUserId: USER_ID,
        requestId: 'interactive-request',
        taskId: TASK_ID,
        threadId: THREAD_ID,
      },
      tenant: {
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        teamId: TEAM_ID,
      },
    },
    channel: { id: CHANNEL_ID, organizationId: ORGANIZATION_ID },
    prisma,
    realtimeTransport: {},
    run: { id: RUN_ID, messageId: MESSAGE_ID, threadId: THREAD_ID },
  } as unknown as BuiltinToolRuntimeContext

  await runScheduleTaskTool(context, {
    instructions: 'Prepare the recurring research brief',
    schedule: { every_minutes: 60, kind: 'interval' },
  })
  assert.ok(savedConfig)
  return savedConfig
}

type TriggerPrismaHarness = {
  failedDeliveries: Array<Record<string, unknown>>
  queuePayloads: unknown[]
  teamQueries: Array<Record<string, unknown>>
  transactionCount: number
  triggerUpdates: Array<Record<string, unknown>>
  prisma: PrismaClient
}

const createTriggerHarness = (
  teamScopeValid = true,
): TriggerPrismaHarness => {
  const failedDeliveries: Array<Record<string, unknown>> = []
  const queuePayloads: unknown[] = []
  const triggerUpdates: Array<Record<string, unknown>> = []
  const teamQueries: Array<Record<string, unknown>> = []
  let transactionCount = 0

  const tx = {
    agentTriggerDelivery: {
      create: async () => ({ id: DELIVERY_ID }),
      update: async () => ({}),
    },
    message: {
      create: async () => ({ id: MESSAGE_ID }),
    },
    run: {
      create: async () => ({ id: RUN_ID }),
    },
    task: {
      create: async () => ({ id: TASK_ID }),
    },
    agentTrigger: {
      update: async () => ({}),
    },
    $executeRaw: async (query: { values?: unknown[] }) => {
      const encoded = query.values?.find(
        (value): value is string =>
          typeof value === 'string' && value.includes('"actorContext"'),
      )
      assert.ok(encoded)
      queuePayloads.push(JSON.parse(encoded))
      return 1
    },
  }
  const prisma = {
    agentTriggerDelivery: {
      findFirst: async () => null,
      upsert: async (args: { create: Record<string, unknown> }) => {
        failedDeliveries.push(args.create)
        return {}
      },
    },
    agentTrigger: {
      update: async (args: { data: Record<string, unknown> }) => {
        triggerUpdates.push(args.data)
        return {}
      },
    },
    team: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        teamQueries.push(args.where)
        return teamScopeValid ? { id: TEAM_ID } : null
      },
    },
    thread: {
      findUnique: async () => ({
        channelId: CHANNEL_ID,
        channel: {
          organizationId: ORGANIZATION_ID,
          visibility: 'private',
        },
      }),
    },
    $transaction: async (callback: (client: typeof tx) => Promise<void>) => {
      transactionCount += 1
      return callback(tx)
    },
  }

  return {
    failedDeliveries,
    get transactionCount() {
      return transactionCount
    },
    queuePayloads,
    teamQueries,
    triggerUpdates,
    prisma: prisma as unknown as PrismaClient,
  }
}

const fireSchedule = async (
  harness: TriggerPrismaHarness,
  config: Record<string, unknown>,
): Promise<void> => queueTriggerRun(harness.prisma, {
  dedupeKey: 'scheduled:one',
  payload: { scheduledFor: '2026-07-19T10:00:00.000Z' },
  source: 'scheduler',
  trigger: {
    agent: {
      agentKind: 'personal_assistant',
      organizationId: null,
      projectId: null,
      teamId: null,
    },
    agentId: PA_AGENT_ID,
    config,
    id: TRIGGER_ID,
    targetChannelId: CHANNEL_ID,
    targetThreadId: THREAD_ID,
    type: 'interval',
  },
})

test('schedule_task to PA firing preserves exact launch scope through memory', async () => {
  const config = await createSchedule()
  assert.deepEqual(config['launchOrigin'], {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
    userId: USER_ID,
  })

  const harness = createTriggerHarness()
  await fireSchedule(harness, config)

  assert.equal(harness.transactionCount, 1)
  assert.equal(harness.queuePayloads.length, 1)
  const runPayload = RunExecuteJobPayloadSchema.parse(harness.queuePayloads[0])
  assert.equal(runPayload.actorContext.actionContext.effectiveUserId, USER_ID)
  assert.deepEqual(runPayload.actorContext.tenant, {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
  })
  const memoryPayload = buildRunMemoryConsolidationJobPayload(runPayload)
  assert.equal(memoryPayload.origin.organizationId, ORGANIZATION_ID)
  assert.equal(memoryPayload.origin.projectId, PROJECT_ID)
  assert.equal(memoryPayload.origin.teamId, TEAM_ID)
  assert.equal(memoryPayload.origin.userId, USER_ID)
  assert.deepEqual(harness.teamQueries[0]?.['members'], {
    some: { userId: USER_ID },
  })
})

test('legacy user-owned PA schedule fails closed before run enqueue', async () => {
  const config = await createSchedule()
  delete config['launchOrigin']
  const harness = createTriggerHarness()

  await assert.rejects(fireSchedule(harness, config), /Cancel and recreate/)
  assert.equal(harness.transactionCount, 0)
  assert.equal(harness.queuePayloads.length, 0)
  assert.equal(harness.failedDeliveries.length, 1)
  assert.match(
    String(harness.failedDeliveries[0]?.['errorMessage']),
    /Cancel and recreate/,
  )
  assert.deepEqual(harness.triggerUpdates, [{ status: 'error' }])
})

test('saved team outside the organization fails before run enqueue', async () => {
  const config = await createSchedule()
  const harness = createTriggerHarness(false)

  await assert.rejects(fireSchedule(harness, config), /does not belong/)
  assert.equal(harness.transactionCount, 0)
  assert.equal(harness.queuePayloads.length, 0)
  assert.deepEqual(harness.triggerUpdates, [{ status: 'error' }])
})

test('revoked team member fails before a scheduled PA run is enqueued', async () => {
  const config = await createSchedule()
  const harness = createTriggerHarness(false)

  await assert.rejects(fireSchedule(harness, config), /no longer a member/)
  assert.deepEqual(harness.teamQueries[0]?.['members'], {
    some: { userId: USER_ID },
  })
  assert.equal(harness.transactionCount, 0)
  assert.equal(harness.queuePayloads.length, 0)
  assert.deepEqual(harness.triggerUpdates, [{ status: 'error' }])
})
