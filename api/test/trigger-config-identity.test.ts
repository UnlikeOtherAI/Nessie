import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  createAgentTrigger,
  updateAgentTrigger,
} from '../src/services/trigger-crud.js'
import {
  mergeTriggerConfigPreservingIdentity,
  stripServerOwnedTriggerConfig,
} from '@nessie/team-admin'

const launchOrigin = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  teamId: '00000000-0000-4000-8000-000000000003',
  userId: '00000000-0000-4000-8000-000000000004',
}
const AGENT_ID = '00000000-0000-4000-8000-000000000005'
const CHANNEL_ID = '00000000-0000-4000-8000-000000000006'
const THREAD_ID = '00000000-0000-4000-8000-000000000007'
const TRIGGER_ID = '00000000-0000-4000-8000-000000000008'
const now = new Date('2026-07-19T10:00:00.000Z')

const triggerRecord = (config: unknown) => ({
  agentId: AGENT_ID,
  config,
  createdAt: now,
  description: null,
  enabled: true,
  id: TRIGGER_ID,
  lastFiredAt: null,
  name: null,
  nextRunAt: now,
  status: 'active' as const,
  targetChannelId: CHANNEL_ID,
  targetThreadId: THREAD_ID,
  type: 'interval' as const,
  updatedAt: now,
  workflowInstallationId: null,
})

test('generic trigger creation strips caller-supplied launch identity', () => {
  assert.deepEqual(
    stripServerOwnedTriggerConfig({
      createdByUserId: launchOrigin.userId,
      createdViaTool: true,
      launchOrigin,
      prompt: 'safe prompt',
    }),
    { prompt: 'safe prompt' },
  )
})

test('generic trigger updates preserve server-owned launch identity', () => {
  assert.deepEqual(
    mergeTriggerConfigPreservingIdentity(
      {
        createdByUserId: launchOrigin.userId,
        createdViaTool: true,
        launchOrigin,
        prompt: 'before',
      },
      {
        createdByUserId: '00000000-0000-4000-8000-00000000000f',
        createdViaTool: false,
        launchOrigin: { ...launchOrigin, teamId: 'forged-team' },
        prompt: 'after',
      },
    ),
    {
      createdByUserId: launchOrigin.userId,
      createdViaTool: true,
      launchOrigin,
      prompt: 'after',
    },
  )
})

test('createAgentTrigger cannot persist forged launch identity', async () => {
  let persistedConfig: unknown
  const prisma = {
    agent: {
      findUnique: async () => ({
        agentKind: 'shared',
        id: AGENT_ID,
        organizationId: launchOrigin.organizationId,
      }),
    },
    agentBinding: {
      findFirst: async () => ({ id: 'binding' }),
    },
    thread: {
      findUnique: async () => ({ channelId: CHANNEL_ID }),
    },
    agentTrigger: {
      create: async (args: { data: { config: unknown } }) => {
        persistedConfig = args.data.config
        return triggerRecord(persistedConfig)
      },
    },
    team: {
      findFirst: async () => ({ id: launchOrigin.teamId }),
    },
  } as unknown as PrismaClient

  const created = await createAgentTrigger(prisma, AGENT_ID, {
    config: {
      createdByUserId: launchOrigin.userId,
      createdViaTool: true,
      interval_minutes: 60,
      launchOrigin,
    },
    targetThreadId: THREAD_ID,
    type: 'interval',
  }, { launchOrigin })

  assert.ok(created)
  assert.deepEqual(persistedConfig, {
    createdByUserId: launchOrigin.userId,
    interval_minutes: 60,
    launchOrigin,
  })
})

test('createAgentTrigger rejects a scheduled trigger without trusted origin', async () => {
  let writes = 0
  const prisma = {
    agentTrigger: {
      create: async () => {
        writes += 1
        return triggerRecord({})
      },
    },
  } as unknown as PrismaClient

  const created = await createAgentTrigger(prisma, AGENT_ID, {
    config: { interval_minutes: 60 },
    targetThreadId: THREAD_ID,
    type: 'interval',
  })

  assert.equal(created, null)
  assert.equal(writes, 0)
})

test('createAgentTrigger rejects malformed trusted user or team identity', async () => {
  let writes = 0
  const prisma = {
    agentTrigger: {
      create: async () => {
        writes += 1
        return triggerRecord({})
      },
    },
  } as unknown as PrismaClient

  for (const invalidOrigin of [
    { ...launchOrigin, teamId: undefined },
    { ...launchOrigin, userId: undefined },
  ]) {
    const created = await createAgentTrigger(
      prisma,
      AGENT_ID,
      {
        config: { interval_minutes: 60 },
        targetThreadId: THREAD_ID,
        type: 'interval',
      },
      { launchOrigin: invalidOrigin } as never,
    )
    assert.equal(created, null)
  }
  assert.equal(writes, 0)
})

test('updateAgentTrigger cannot overwrite persisted launch identity', async () => {
  const existingConfig = {
    createdByUserId: launchOrigin.userId,
    interval_minutes: 60,
    launchOrigin,
  }
  let persistedConfig: unknown
  const prisma = {
    agentTrigger: {
      // The scope is folded into the `where`, so the by-id read is a
      // `findFirst`; the tenancy itself is proved DB-backed in
      // `trigger-tenancy-scope.test.ts`.
      findFirst: async () => ({
        agentId: AGENT_ID,
        config: existingConfig,
        id: TRIGGER_ID,
        targetChannelId: CHANNEL_ID,
        targetThreadId: THREAD_ID,
        type: 'interval',
        workflowInstallationId: null,
      }),
      update: async (args: { data: { config: unknown } }) => {
        persistedConfig = args.data.config
        return triggerRecord(persistedConfig)
      },
    },
  } as unknown as PrismaClient

  const updated = await updateAgentTrigger(prisma, {
    organizationId: launchOrigin.organizationId,
    triggerId: TRIGGER_ID,
  }, {
    config: {
      createdByUserId: '00000000-0000-4000-8000-00000000000f',
      interval_minutes: 120,
      launchOrigin: { ...launchOrigin, teamId: 'forged-team' },
    },
  })

  assert.ok(updated)
  assert.deepEqual(persistedConfig, {
    createdByUserId: launchOrigin.userId,
    interval_minutes: 120,
    launchOrigin,
  })
})
