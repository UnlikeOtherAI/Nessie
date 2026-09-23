import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma, type PrismaClient } from '@prisma/client'

import { sweepDueScheduledTriggers } from '../src/control/trigger-scheduler.js'
import {
  emptySkipReferenceTime,
  hasPendingThreadWork,
  recordEmptyFireSkip,
  triggerOptsIntoEmptySkip,
} from '../src/control/trigger-empty-skip.js'

const TRIGGER_ID = '20000000-0000-4000-8000-000000000001'
const AGENT_ID = '20000000-0000-4000-8000-000000000002'
const CHANNEL_ID = '20000000-0000-4000-8000-000000000003'
const THREAD_ID = '20000000-0000-4000-8000-000000000004'
const CLAIM_ID = '20000000-0000-4000-8000-000000000005'
const DELIVERY_ID = '20000000-0000-4000-8000-000000000006'
const ORGANIZATION_ID = '20000000-0000-4000-8000-000000000007'
const MESSAGE_ID = '20000000-0000-4000-8000-000000000008'
const RUN_ID = '20000000-0000-4000-8000-000000000009'
const TASK_ID = '20000000-0000-4000-8000-00000000000a'
const NEXT_RUN_AT = new Date('2026-07-23T09:00:00.000Z')

// --- pure decision helpers ---------------------------------------------------

test('triggerOptsIntoEmptySkip only accepts an explicit true', () => {
  assert.equal(triggerOptsIntoEmptySkip({ skipWhenEmpty: true }), true)
  assert.equal(triggerOptsIntoEmptySkip({ skipWhenEmpty: false }), false)
  assert.equal(triggerOptsIntoEmptySkip({ skipWhenEmpty: 'true' }), false)
  assert.equal(triggerOptsIntoEmptySkip({ skipWhenEmpty: 1 }), false)
  assert.equal(triggerOptsIntoEmptySkip({}), false)
  assert.equal(triggerOptsIntoEmptySkip(null), false)
  assert.equal(triggerOptsIntoEmptySkip('skipWhenEmpty'), false)
})

test('emptySkipReferenceTime prefers lastFiredAt, else createdAt', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const lastFiredAt = new Date('2026-06-01T00:00:00.000Z')
  assert.equal(
    emptySkipReferenceTime({ createdAt, lastFiredAt }).toISOString(),
    lastFiredAt.toISOString(),
  )
  assert.equal(
    emptySkipReferenceTime({ createdAt, lastFiredAt: null }).toISOString(),
    createdAt.toISOString(),
  )
})

test('hasPendingThreadWork excludes the trigger agent and injected kickoffs', async () => {
  const since = new Date('2026-07-23T08:00:00.000Z')
  const captured: Array<Record<string, unknown>> = []
  const prisma = {
    message: {
      count: async (args: { where: Record<string, unknown> }) => {
        captured.push(args.where)
        return 0
      },
    },
  } as unknown as Pick<PrismaClient, 'message'>

  const result = await hasPendingThreadWork(prisma, {
    agentId: AGENT_ID,
    since,
    threadId: THREAD_ID,
  })

  assert.equal(result, false)
  const where = captured[0]
  assert.equal(where?.['threadId'], THREAD_ID)
  assert.equal(where?.['deletedAt'], null)
  assert.deepEqual(where?.['createdAt'], { gt: since })
  assert.deepEqual(where?.['OR'], [
    { userId: { not: null } },
    { AND: [{ agentId: { not: null } }, { agentId: { not: AGENT_ID } }] },
  ])
})

test('hasPendingThreadWork returns true when the thread has foreign messages', async () => {
  const prisma = {
    message: { count: async () => 2 },
  } as unknown as Pick<PrismaClient, 'message'>

  assert.equal(
    await hasPendingThreadWork(prisma, {
      agentId: AGENT_ID,
      since: new Date(),
      threadId: THREAD_ID,
    }),
    true,
  )
})

test('recordEmptyFireSkip persists a skipped delivery', async () => {
  const created: Array<Record<string, unknown>> = []
  const prisma = {
    agentTriggerDelivery: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data)
        return { id: DELIVERY_ID }
      },
    },
  } as unknown as Pick<PrismaClient, 'agentTriggerDelivery'>

  await recordEmptyFireSkip(prisma, {
    dedupeKey: 'scheduled:one',
    payload: { reason: 'empty_work_source' },
    source: 'scheduler',
    triggerId: TRIGGER_ID,
  })

  assert.equal(created.length, 1)
  assert.equal(created[0]?.['status'], 'skipped')
  assert.equal(created[0]?.['triggerId'], TRIGGER_ID)
  assert.equal(created[0]?.['dedupeKey'], 'scheduled:one')
})

test('recordEmptyFireSkip swallows a duplicate-fire conflict', async () => {
  const prisma = {
    agentTriggerDelivery: {
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        })
      },
    },
  } as unknown as Pick<PrismaClient, 'agentTriggerDelivery'>

  await assert.doesNotReject(
    recordEmptyFireSkip(prisma, {
      dedupeKey: 'scheduled:one',
      payload: {},
      source: 'scheduler',
      triggerId: TRIGGER_ID,
    }),
  )
})

test('recordEmptyFireSkip rethrows non-conflict errors', async () => {
  const prisma = {
    agentTriggerDelivery: {
      create: async () => {
        throw new Error('db offline')
      },
    },
  } as unknown as Pick<PrismaClient, 'agentTriggerDelivery'>

  await assert.rejects(
    recordEmptyFireSkip(prisma, {
      dedupeKey: 'scheduled:one',
      payload: {},
      source: 'scheduler',
      triggerId: TRIGGER_ID,
    }),
    /db offline/,
  )
})

// --- scheduler sweep: skip vs run wiring -------------------------------------

type SweepCalls = {
  failedDeliveries: Array<Record<string, unknown>>
  finalizeCalls: number
  healthReasons: string[]
  messageCounts: number
  runEnqueues: number
  skippedDeliveries: Array<Record<string, unknown>>
  threadLookups: number
}

const makeSweepPrisma = (opts: {
  agentBound?: boolean
  config: Record<string, unknown>
  createdAt?: Date
  lastFiredAt?: Date | null
  messageCount: number
}): { calls: SweepCalls; prisma: PrismaClient } => {
  const calls: SweepCalls = {
    failedDeliveries: [],
    finalizeCalls: 0,
    healthReasons: [],
    messageCounts: 0,
    runEnqueues: 0,
    skippedDeliveries: [],
    threadLookups: 0,
  }
  let existingDelivery: { id: string; status: string } | null = null

  const tx = {
    agentTriggerDelivery: {
      create: async () => ({ id: DELIVERY_ID }),
      update: async () => ({}),
    },
    agentTrigger: { update: async () => ({}) },
    message: { create: async () => ({ id: MESSAGE_ID }) },
    run: {
      create: async () => ({ id: RUN_ID }),
      findFirst: async () => null,
    },
    runThreadPendingMessage: {
      create: async () => ({}),
      findFirst: async () => null,
    },
    task: { create: async () => ({ id: TASK_ID }) },
    $queryRaw: async (query: { values?: unknown[] }) => {
      const healthReason = query.values?.find((value) =>
        value === 'agent_channel_access_lost' || value === 'channel_access_lost')
      if (typeof healthReason === 'string') calls.healthReasons.push(healthReason)
      return [{ healthRevision: 1 }]
    },
    $executeRaw: async (query: { strings?: string[]; values?: unknown[] }) => {
      if (query.strings?.some((sql) => sql.includes('pg_advisory_xact_lock'))) return 0
      const encoded = query.values?.find(
        (value): value is string =>
          typeof value === 'string' && value.includes('"actorContext"'),
      )
      if (encoded) calls.runEnqueues += 1
      return 1
    },
  }

  const prisma = {
    $queryRaw: async () => [
      {
        agentId: AGENT_ID,
        config: opts.config,
        id: TRIGGER_ID,
        nextRunAt: NEXT_RUN_AT,
        schedulerClaimId: CLAIM_ID,
        targetChannelId: CHANNEL_ID,
        targetThreadId: THREAD_ID,
        type: 'scheduled',
        workflowInstallationId: null,
      },
    ],
    agentTrigger: {
      findMany: async () => [
        {
          agent: {
            agentKind: 'shared',
            organizationId: ORGANIZATION_ID,
            projectId: null,
            teamId: null,
          },
          createdAt: opts.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
          id: TRIGGER_ID,
          lastFiredAt: opts.lastFiredAt ?? null,
          workflowInstallation: null,
        },
      ],
      update: async () => ({}),
    },
    message: {
      count: async () => {
        calls.messageCounts += 1
        return opts.messageCount
      },
    },
    agentBinding: {
      findFirst: async () => opts.agentBound === false ? null : { id: 'binding' },
    },
    agentTriggerDelivery: {
      findFirst: async () => existingDelivery,
      create: async (args: { data: Record<string, unknown> }) => {
        const status = String(args.data['status'])
        existingDelivery = { id: DELIVERY_ID, status }
        if (status === 'skipped') calls.skippedDeliveries.push(args.data)
        if (status === 'failed') calls.failedDeliveries.push(args.data)
        return { id: DELIVERY_ID }
      },
      updateMany: async () => ({ count: 1 }),
    },
    thread: {
      findUnique: async () => {
        calls.threadLookups += 1
        return {
          channelId: CHANNEL_ID,
          channel: {
            deletedAt: null,
            organizationId: ORGANIZATION_ID,
            systemChannelType: null,
            type: 'standard',
            visibility: 'public',
          },
        }
      },
    },
    organizationMember: { findFirst: async () => null },
    team: { findFirst: async () => null },
    channelMember: { findFirst: async () => null },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    $executeRaw: async () => {
      calls.finalizeCalls += 1
      return 1
    },
  }

  return { calls, prisma: prisma as unknown as PrismaClient }
}

test('empty opted-in schedule records a skip and never attempts a run', async () => {
  const { calls, prisma } = makeSweepPrisma({
    config: { createdViaTool: true, cron: '0 9 * * *', skipWhenEmpty: true },
    messageCount: 0,
  })

  await sweepDueScheduledTriggers(prisma, { limit: 10 })

  assert.equal(calls.messageCounts, 1)
  assert.equal(calls.skippedDeliveries.length, 1)
  assert.equal(calls.skippedDeliveries[0]?.['status'], 'skipped')
  assert.equal(calls.skippedDeliveries[0]?.['source'], 'scheduler')
  // Admission is deliberately checked before the empty-work optimisation.
  assert.equal(calls.threadLookups, 1)
  // The schedule still advances so the next fire is scheduled.
  assert.equal(calls.finalizeCalls, 1)
})

test('opted-in schedule with pending work runs instead of skipping', async () => {
  const { calls, prisma } = makeSweepPrisma({
    config: { createdViaTool: true, cron: '0 9 * * *', skipWhenEmpty: true },
    messageCount: 3,
  })

  await sweepDueScheduledTriggers(prisma, { limit: 10 })

  assert.equal(calls.messageCounts, 1)
  assert.equal(calls.skippedDeliveries.length, 0)
  assert.equal(calls.threadLookups, 2)
  assert.equal(calls.runEnqueues, 1)
})

test('schedule without skipWhenEmpty always runs and never counts work', async () => {
  const { calls, prisma } = makeSweepPrisma({
    config: { createdViaTool: true, cron: '0 9 * * *' },
    messageCount: 0,
  })

  await sweepDueScheduledTriggers(prisma, { limit: 10 })

  assert.equal(calls.messageCounts, 0)
  assert.equal(calls.skippedDeliveries.length, 0)
  assert.equal(calls.threadLookups, 2)
  assert.equal(calls.runEnqueues, 1)
})

test('a quiet schedule still stops when its agent left the channel', async () => {
  const { calls, prisma } = makeSweepPrisma({
    agentBound: false,
    config: { createdViaTool: true, cron: '0 9 * * *', skipWhenEmpty: true },
    messageCount: 0,
  })

  await sweepDueScheduledTriggers(prisma, { limit: 10 })

  assert.equal(calls.messageCounts, 0, 'authority must be checked before emptiness')
  assert.equal(calls.skippedDeliveries.length, 0)
  assert.equal(calls.failedDeliveries.length, 1)
  assert.equal(calls.failedDeliveries[0]?.['nextRetryAt'], null)
  assert.deepEqual(calls.healthReasons, ['agent_channel_access_lost'])
  assert.equal(calls.runEnqueues, 0)
  assert.equal(calls.finalizeCalls, 1, 'the failed delivery owns and settles its occurrence')
})
