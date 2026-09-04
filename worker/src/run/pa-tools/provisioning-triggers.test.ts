import assert from 'node:assert/strict'
import test from 'node:test'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { runAgentTriggerCreateTool } from './provisioning.js'

const ORGANIZATION_ID = '90a00000-0000-4000-8000-000000000001'
const PROJECT_ID = '90a00000-0000-4000-8000-000000000002'
const TEAM_ID = '90a00000-0000-4000-8000-000000000003'
const USER_ID = '90a00000-0000-4000-8000-000000000004'
const CHANNEL_ID = '90a00000-0000-4000-8000-000000000005'
const THREAD_ID = '90a00000-0000-4000-8000-000000000006'
const AGENT_ID = '90a00000-0000-4000-8000-000000000007'

const UOA_IDENTITY = {
  organizationId: 'uoa-org-1',
  subject: 'uoa-subject-1',
  teamId: 'uoa-team-1',
  tokenVersion: 1,
}

type TriggerType = 'event' | 'interval' | 'manual' | 'scheduled' | 'webhook'

const makeContext = (
  created: Array<Record<string, unknown>>,
): BuiltinToolRuntimeContext => {
  let index = 0
  const prisma = {
    agent: {
      count: async () => 1,
      findUnique: async () => ({
        agentKind: 'shared',
        id: AGENT_ID,
        organizationId: ORGANIZATION_ID,
        systemSlug: null,
      }),
    },
    agentBinding: { findFirst: async () => ({ id: 'binding-1' }) },
    agentTrigger: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
        index += 1
        return {
          agentId: AGENT_ID,
          config: data.config,
          createdAt: new Date('2026-09-04T09:00:00.000Z'),
          description: null,
          enabled: true,
          id: `90a00000-0000-4000-8000-0000000000${index.toString(10).padStart(2, '0')}`,
          lastFiredAt: null,
          name: data.name ?? null,
          nextRunAt: data.nextRunAt ?? null,
          status: 'active',
          targetChannelId: CHANNEL_ID,
          targetThreadId: THREAD_ID,
          type: data.type as TriggerType,
          updatedAt: new Date('2026-09-04T09:00:00.000Z'),
          workflowInstallationId: null,
        }
      },
    },
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: 'owner' }),
    },
    team: { findFirst: async () => ({ id: TEAM_ID }) },
    thread: { findFirst: async () => ({ id: THREAD_ID }) },
  }

  return {
    actorContext: {
      actionContext: { requestId: 'request-1', teamId: TEAM_ID, uoaIdentity: UOA_IDENTITY },
      actor: { actorId: USER_ID, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, teamId: TEAM_ID },
    },
    agentId: 'personal-assistant-1',
    agentKind: 'personal_assistant',
    channel: { id: CHANNEL_ID, organizationId: ORGANIZATION_ID },
    prisma: prisma as unknown as BuiltinToolRuntimeContext['prisma'],
    realtimeTransport: {},
    run: { id: 'run-1', messageId: 'message-1', threadId: THREAD_ID },
    toolCallId: 'tool-call-1',
  } as unknown as BuiltinToolRuntimeContext
}

test('agent_trigger_create creates every non-workflow trigger type with executable config', async () => {
  const created: Array<Record<string, unknown>> = []
  const context = makeContext(created)
  const cases: Array<{
    config?: Record<string, unknown>
    name: string
    type: TriggerType
  }> = [
    { config: { prompt: 'Run the checklist' }, name: 'Manual', type: 'manual' },
    {
      config: { cron: '0 9 * * 1-5', prompt: 'Send the daily digest', timezone: 'Europe/London' },
      name: 'Cron',
      type: 'scheduled',
    },
    {
      config: { interval_minutes: 30, prompt: 'Check the service health' },
      name: 'Interval',
      type: 'interval',
    },
    { name: 'Webhook', type: 'webhook' },
    {
      config: { events: ['release.shipped'], filter: { region: 'eu' } },
      name: 'Event',
      type: 'event',
    },
  ]

  for (const trigger of cases) {
    const result = await runAgentTriggerCreateTool(context, {
      agentId: AGENT_ID,
      config: trigger.config,
      name: trigger.name,
      targetChannelId: CHANNEL_ID,
      type: trigger.type,
    })
    assert.equal(result.toolName, 'agent_trigger_create')
    assert.match(result.outputPreview, new RegExp(`Created ${trigger.type} trigger`))
  }

  assert.equal(created.length, cases.length)
  for (const trigger of created) {
    assert.equal(trigger.agentId, AGENT_ID)
    assert.equal(trigger.targetChannelId, CHANNEL_ID)
    assert.equal(trigger.targetThreadId, THREAD_ID)
  }

  const byType = new Map(created.map((trigger) => [trigger.type as TriggerType, trigger]))
  assert.equal((byType.get('manual')?.config as Record<string, unknown>)['prompt'], 'Run the checklist')
  assert.equal(
    (byType.get('webhook')?.config as Record<string, unknown>)['apiKey']?.toString().startsWith('ntk_'),
    true,
  )
  assert.deepEqual((byType.get('event')?.config as Record<string, unknown>)['events'], ['release.shipped'])
  assert.deepEqual(
    (byType.get('event')?.config as Record<string, unknown>)['filter'],
    { region: 'eu' },
  )

  for (const type of ['scheduled', 'interval'] as const) {
    const config = byType.get(type)?.config as Record<string, unknown>
    assert.ok(byType.get(type)?.nextRunAt instanceof Date, `${type} is armed with a next run`)
    assert.equal(config.createdByUserId, USER_ID)
    assert.deepEqual(config.launchOrigin, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      teamId: TEAM_ID,
      uoaIdentity: UOA_IDENTITY,
      userId: USER_ID,
    })
  }
})
