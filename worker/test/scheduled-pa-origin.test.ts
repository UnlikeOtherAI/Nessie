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
  organizationMemberQueries: Array<Record<string, unknown>>
  queuePayloads: unknown[]
  teamQueries: Array<Record<string, unknown>>
  transactionCount: number
  triggerUpdates: Array<Record<string, unknown>>
  prisma: PrismaClient
}

const createTriggerHarness = (
  teamScopeValid = true,
  organizationMemberActive = true,
  // Users who are members of the private target channel at fire time.
  channelMembers: string[] = [USER_ID],
): TriggerPrismaHarness => {
  const failedDeliveries: Array<Record<string, unknown>> = []
  const organizationMemberQueries: Array<Record<string, unknown>> = []
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
      // The per-(agent, thread) slot claim: no active run, so the fire claims.
      findFirst: async () => null,
    },
    runThreadPendingMessage: {
      // Redelivery dedupe: no pending marker for this message.
      findFirst: async () => null,
      create: async () => ({}),
    },
    task: {
      create: async () => ({ id: TASK_ID }),
    },
    agentTrigger: {
      update: async () => ({}),
    },
    $executeRaw: async (query: { strings?: string[]; values?: unknown[] }) => {
      // The thread-run claim's advisory lock is not a queue enqueue.
      if (query.strings?.some((sql) => sql.includes('pg_advisory_xact_lock'))) {
        return 0
      }
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
    agentBinding: {
      findFirst: async () => ({ id: 'binding' }),
    },
    agentTriggerDelivery: {
      findFirst: async () => null,
      upsert: async (args: { create: Record<string, unknown> }) => {
        failedDeliveries.push(args.create)
        return {}
      },
    },
    agentTrigger: {
      // The classified health write reads the current state before deciding
      // whether this is a NEW failure (bump the revision, alert) or the same
      // one repeating (leave it, stay quiet).
      findUnique: async () => ({
        healthReason: null,
        healthRevision: 0,
        status: 'active',
      }),
      update: async (args: { data: Record<string, unknown> }) => {
        triggerUpdates.push(args.data)
        return {}
      },
    },
    organizationMember: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        organizationMemberQueries.push(args.where)
        return organizationMemberActive ? { id: 'organization-member' } : null
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
    // The PA is its owner's delegate, so firing into a private channel is
    // re-checked against that owner's membership at fire time — exactly like a
    // shared agent's saved launcher.
    channelMember: {
      findFirst: async (args: { where: { userId: string } }) =>
        channelMembers.includes(args.where.userId) ? { userId: args.where.userId } : null,
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
    organizationMemberQueries,
    queuePayloads,
    teamQueries,
    triggerUpdates,
    prisma: prisma as unknown as PrismaClient,
  }
}

const fireSchedule = async (
  harness: TriggerPrismaHarness,
  config: Record<string, unknown>,
  agent: {
    agentKind: 'personal_assistant' | 'shared'
    organizationId: string | null
    projectId: string | null
    teamId: string | null
  } = {
    agentKind: 'personal_assistant',
    organizationId: null,
    projectId: null,
    teamId: null,
  },
): Promise<void> => queueTriggerRun(harness.prisma, {
  dedupeKey: 'scheduled:one',
  payload: { scheduledFor: '2026-07-19T10:00:00.000Z' },
  source: 'scheduler',
  trigger: {
    agent,
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

  await assert.rejects(fireSchedule(harness, config), /then recreate the schedule/)
  assert.equal(harness.transactionCount, 0)
  assert.equal(harness.queuePayloads.length, 0)
  assert.equal(harness.failedDeliveries.length, 1)
  assert.match(
    String(harness.failedDeliveries[0]?.['errorMessage']),
    /then recreate the schedule/,
  )
  assert.equal(harness.triggerUpdates.length, 1)
  assert.equal(harness.triggerUpdates[0]?.['status'], 'error')
  assert.equal(harness.triggerUpdates[0]?.['healthReason'], 'launch_origin_invalid')
})

test('saved team outside the organization fails before run enqueue', async () => {
  const config = await createSchedule()
  const harness = createTriggerHarness(false)

  await assert.rejects(fireSchedule(harness, config), /does not belong/)
  assert.equal(harness.transactionCount, 0)
  assert.equal(harness.queuePayloads.length, 0)
  assert.equal(harness.triggerUpdates.length, 1)
  assert.equal(harness.triggerUpdates[0]?.['status'], 'error')
  assert.equal(harness.triggerUpdates[0]?.['healthReason'], 'team_unreachable')
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
  assert.equal(harness.triggerUpdates.length, 1)
  assert.equal(harness.triggerUpdates[0]?.['status'], 'error')
  assert.equal(harness.triggerUpdates[0]?.['healthReason'], 'team_unreachable')
})

test('a PA schedule stops firing once its owner loses the private channel', async () => {
  // The PA reaches exactly what its owner reaches. A schedule created while the
  // owner was a member must not keep firing — and loading that channel's
  // conversation — after the owner is removed from it.
  const config = await createSchedule()
  const harness = createTriggerHarness(true, true, [])

  await assert.rejects(fireSchedule(harness, config), /no longer has access/)
  assert.equal(harness.transactionCount, 0)
  assert.equal(harness.queuePayloads.length, 0)
  assert.equal(harness.triggerUpdates.length, 1)
  assert.equal(harness.triggerUpdates[0]?.['status'], 'error')
  assert.equal(harness.triggerUpdates[0]?.['healthReason'], 'channel_access_lost')
})

test('deactivated organization member fails before run enqueue', async () => {
  const config = await createSchedule()
  const harness = createTriggerHarness(true, false)

  await assert.rejects(
    fireSchedule(harness, config),
    /no longer an active member of its saved organization/,
  )
  assert.deepEqual(harness.organizationMemberQueries, [{
    deactivatedAt: null,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
  }])
  assert.deepEqual(harness.teamQueries[0]?.['members'], {
    some: { userId: USER_ID },
  })
  assert.equal(harness.transactionCount, 0)
  assert.equal(harness.queuePayloads.length, 0)
  assert.equal(harness.failedDeliveries.length, 1)
  assert.equal(harness.failedDeliveries[0]?.['status'], 'failed')
  assert.match(
    String(harness.failedDeliveries[0]?.['errorMessage']),
    /no longer an active member of its saved organization/,
  )
  assert.equal(harness.triggerUpdates.length, 1)
  // `error`, not `needs_reauthorization`: a deactivated member cannot repair
  // this by proving who they are, so offering Reauthorize would be a dead end.
  assert.equal(harness.triggerUpdates[0]?.['status'], 'error')
  assert.equal(harness.triggerUpdates[0]?.['healthReason'], 'member_inactive')
  assert.equal(harness.triggerUpdates[0]?.['healthRevision'], 1)
})

test('legacy REST schedule without an origin fails before run enqueue', async () => {
  const harness = createTriggerHarness()
  await assert.rejects(
    fireSchedule(
      harness,
      { interval_minutes: 60 },
      {
        agentKind: 'shared',
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        teamId: TEAM_ID,
      },
    ),
    /legacy user-facing schedule[\s\S]*then recreate the schedule/,
  )
  assert.equal(harness.transactionCount, 0)
  assert.equal(harness.queuePayloads.length, 0)
  // A legacy schedule carries no identity to refresh, so it is `error` (fix the
  // configuration) rather than `needs_reauthorization` (prove who you are).
  assert.equal(harness.triggerUpdates.length, 1)
  assert.equal(harness.triggerUpdates[0]?.['status'], 'error')
  assert.equal(harness.triggerUpdates[0]?.['healthReason'], 'launch_origin_invalid')
})

test('trusted autonomous schedule_task marker retains agent scope', async () => {
  const harness = createTriggerHarness()
  await fireSchedule(
    harness,
    { createdViaTool: true, interval_minutes: 60 },
    {
      agentKind: 'shared',
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      teamId: TEAM_ID,
    },
  )

  const payload = RunExecuteJobPayloadSchema.parse(harness.queuePayloads[0])
  assert.equal(payload.actorContext.actionContext.effectiveUserId, undefined)
  assert.equal(harness.organizationMemberQueries.length, 0)
  assert.equal(harness.transactionCount, 1)
  assert.equal(harness.queuePayloads.length, 1)
  assert.deepEqual(payload.actorContext.tenant, {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
  })
})

test('malformed launch identity cannot fall back to autonomous scope', async () => {
  const harness = createTriggerHarness()
  await assert.rejects(
    fireSchedule(
      harness,
      {
        createdViaTool: true,
        interval_minutes: 60,
        launchOrigin: { teamId: TEAM_ID },
      },
      {
        agentKind: 'shared',
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        teamId: TEAM_ID,
      },
    ),
    /launch origin is missing or malformed/,
  )
  assert.equal(harness.transactionCount, 0)
  assert.equal(harness.queuePayloads.length, 0)
})
