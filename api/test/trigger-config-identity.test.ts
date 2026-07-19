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
} from '../src/services/trigger-config-identity.js'

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
        launchOrigin,
        prompt: 'before',
      },
      {
        createdByUserId: '00000000-0000-4000-8000-00000000000f',
        launchOrigin: { ...launchOrigin, teamId: 'forged-team' },
        prompt: 'after',
      },
    ),
    {
      createdByUserId: launchOrigin.userId,
      launchOrigin,
      prompt: 'after',
    },
  )
})

test('createAgentTrigger cannot persist forged launch identity', async () => {
  let persistedConfig: unknown
  const prisma = {
    agent: {
      findUnique: async () => ({ agentKind: 'shared', id: AGENT_ID }),
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
  } as unknown as PrismaClient

  const created = await createAgentTrigger(prisma, AGENT_ID, {
    config: {
      createdByUserId: launchOrigin.userId,
      interval_minutes: 60,
      launchOrigin,
    },
    targetThreadId: THREAD_ID,
    type: 'interval',
  })

  assert.ok(created)
  assert.deepEqual(persistedConfig, { interval_minutes: 60 })
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
      findUnique: async () => ({
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

  const updated = await updateAgentTrigger(prisma, TRIGGER_ID, {
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
