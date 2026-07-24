import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify, { type FastifyReply } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import {
  RunExecuteJobPayloadSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { registerTriggerRoutes } from '../src/routes/triggers.js'
import { queueTriggerRun } from '../../worker/src/control/trigger-run.js'

const ORGANIZATION_ID = '20000000-0000-4000-8000-000000000001'
const PROJECT_ID = '20000000-0000-4000-8000-000000000002'
const TEAM_ID = '20000000-0000-4000-8000-000000000003'
const USER_ID = '20000000-0000-4000-8000-000000000004'
const AGENT_ID = '20000000-0000-4000-8000-000000000005'
const CHANNEL_ID = '20000000-0000-4000-8000-000000000006'
const THREAD_ID = '20000000-0000-4000-8000-000000000007'
const TRIGGER_ID = '20000000-0000-4000-8000-000000000008'
const DELIVERY_ID = '20000000-0000-4000-8000-000000000009'
const MESSAGE_ID = '20000000-0000-4000-8000-00000000000a'
const RUN_ID = '20000000-0000-4000-8000-00000000000b'
const TASK_ID = '20000000-0000-4000-8000-00000000000c'
const OTHER_ID = '20000000-0000-4000-8000-00000000000f'

const actorContext: AuthorizedActionContext = {
  actor: { actorId: USER_ID, actorType: 'user', roles: ['owner'] },
  actionContext: { requestId: 'rest-create' },
  tenant: {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
  },
}

type Harness = {
  app: ReturnType<typeof Fastify>
  getOrganizationMemberQueries: () => Array<Record<string, unknown>>
  getPersistedConfig: () => Record<string, unknown> | null
  getQueuePayloads: () => unknown[]
  getTeamQueries: () => Array<Record<string, unknown>>
  getWrites: () => number
  prisma: PrismaClient
}

const createHarness = (
  context: AuthorizedActionContext,
): Harness => {
  let persistedConfig: Record<string, unknown> | null = null
  let writes = 0
  const queuePayloads: unknown[] = []
  const organizationMemberQueries: Array<Record<string, unknown>> = []
  const teamQueries: Array<Record<string, unknown>> = []
  const now = new Date('2026-07-19T10:00:00.000Z')

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
    agent: {
      findUnique: async () => ({
        agentKind: 'shared',
        id: AGENT_ID,
        organizationId: ORGANIZATION_ID,
      }),
    },
    agentBinding: {
      findFirst: async () => ({ id: 'binding' }),
    },
    agentTrigger: {
      create: async (args: { data: { config: Record<string, unknown> } }) => {
        writes += 1
        persistedConfig = args.data.config
        return {
          agentId: AGENT_ID,
          config: persistedConfig,
          createdAt: now,
          description: null,
          enabled: true,
          id: TRIGGER_ID,
          lastFiredAt: null,
          name: null,
          nextRunAt: now,
          status: 'active',
          targetChannelId: CHANNEL_ID,
          targetThreadId: THREAD_ID,
          type: 'interval',
          updatedAt: now,
          workflowInstallationId: null,
        }
      },
      update: async () => ({}),
    },
    agentTriggerDelivery: {
      findFirst: async () => null,
      upsert: async () => ({}),
    },
    channelMember: {
      findFirst: async () => ({ userId: USER_ID }),
    },
    organizationMember: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        organizationMemberQueries.push(args.where)
        return { id: 'organization-member' }
      },
    },
    team: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        teamQueries.push(args.where)
        return { id: TEAM_ID }
      },
    },
    thread: {
      findUnique: async () => ({
        channel: {
          organizationId: ORGANIZATION_ID,
          visibility: 'private',
        },
        channelId: CHANNEL_ID,
      }),
    },
    $transaction: async (callback: (client: typeof tx) => Promise<void>) =>
      callback(tx),
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerTriggerRoutes(app, {
    isAgentAccessibleToActor: async () => true,
    isJsonContentType: () => true,
    isTimingSafeMatch: () => false,
    isTriggerAccessibleToActor: async () => true,
    isTriggerTargetWritableByActor: async () => true,
    parseHeaderValue: () => undefined,
    prisma,
    readFirstHeader: () => undefined,
    readWebhookApiKey: () => undefined,
    requireActorContext: () => context,
    requireOwner: () => true,
    requireUserActor: (
      candidate: AuthorizedActionContext,
      reply: FastifyReply,
    ) => {
      if (candidate.actor.actorType === 'user') {
        return true
      }
      void reply.code(403).send({ error: { code: 'FORBIDDEN' } })
      return false
    },
  } as unknown as Parameters<typeof registerTriggerRoutes>[1])

  return {
    app,
    getOrganizationMemberQueries: () => organizationMemberQueries,
    getPersistedConfig: () => persistedConfig,
    getQueuePayloads: () => queuePayloads,
    getTeamQueries: () => teamQueries,
    getWrites: () => writes,
    prisma,
  }
}

test('REST schedule creation stamps trusted scope through run.execute', async () => {
  const harness = createHarness(actorContext)
  try {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/agents/${AGENT_ID}/triggers`,
      payload: {
        config: {
          createdByUserId: OTHER_ID,
          createdViaTool: true,
          interval_minutes: 60,
          launchOrigin: {
            organizationId: OTHER_ID,
            teamId: OTHER_ID,
            userId: OTHER_ID,
          },
        },
        targetThreadId: THREAD_ID,
        type: 'interval',
      },
    })

    assert.equal(response.statusCode, 201)
    assert.deepEqual(harness.getPersistedConfig(), {
      createdByUserId: USER_ID,
      interval_minutes: 60,
      launchOrigin: {
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        teamId: TEAM_ID,
        userId: USER_ID,
      },
    })
    assert.deepEqual(harness.getTeamQueries()[0], {
      id: TEAM_ID,
      members: { some: { userId: USER_ID } },
      project: { organizationId: ORGANIZATION_ID },
      projectId: PROJECT_ID,
    })

    await queueTriggerRun(harness.prisma, {
      dedupeKey: 'rest-schedule:first-fire',
      payload: { scheduledFor: '2026-07-19T11:00:00.000Z' },
      source: 'scheduler',
      trigger: {
        agent: {
          agentKind: 'shared',
          organizationId: ORGANIZATION_ID,
          projectId: null,
          teamId: null,
        },
        agentId: AGENT_ID,
        config: harness.getPersistedConfig(),
        id: TRIGGER_ID,
        targetChannelId: CHANNEL_ID,
        targetThreadId: THREAD_ID,
        type: 'interval',
      },
    })

    const payload = RunExecuteJobPayloadSchema.parse(
      harness.getQueuePayloads()[0],
    )
    assert.equal(payload.actorContext.actionContext.effectiveUserId, USER_ID)
    assert.deepEqual(harness.getOrganizationMemberQueries(), [{
      deactivatedAt: null,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    }])
    assert.deepEqual(payload.actorContext.tenant, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      teamId: TEAM_ID,
    })
  } finally {
    await harness.app.close()
  }
})

test('REST schedule creation rejects a missing active team before write', async () => {
  const harness = createHarness({
    ...actorContext,
    tenant: {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    },
  })
  try {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/agents/${AGENT_ID}/triggers`,
      payload: {
        config: { interval_minutes: 60 },
        targetThreadId: THREAD_ID,
        type: 'interval',
      },
    })

    assert.equal(response.statusCode, 400)
    assert.match(response.body, /TRIGGER_LAUNCH_ORIGIN_REQUIRED/)
    assert.equal(harness.getWrites(), 0)
  } finally {
    await harness.app.close()
  }
})

test('REST schedule creation rejects a non-user actor before write', async () => {
  const harness = createHarness({
    ...actorContext,
    actor: {
      actorId: 'scheduler-service',
      actorType: 'service',
      roles: ['owner'],
    },
  })
  try {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/agents/${AGENT_ID}/triggers`,
      payload: {
        config: { interval_minutes: 60 },
        targetThreadId: THREAD_ID,
        type: 'interval',
      },
    })

    assert.equal(response.statusCode, 403)
    assert.equal(harness.getWrites(), 0)
  } finally {
    await harness.app.close()
  }
})
