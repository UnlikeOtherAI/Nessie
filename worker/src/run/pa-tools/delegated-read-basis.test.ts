import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CHANNEL_DECISION_POLICY } from '@nessie/schemas'

import { createConsumedSourceSink } from '../execute/disclosure-basis.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { runChannelFindTool, runChannelListTool } from './channels.js'
import { recordVisibleAgentRead } from './message-search-basis.js'

/**
 * The delegated reads the Agent Designer uses resolve content as the PERSON —
 * through their own memberships and their own agent entitlement — so each owes
 * the disclosure sink the scopes it read through. These assert the stamps land,
 * because an unfed sink does not fail loudly: an empty basis means unrestricted.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'

const CHANNELS = [
  {
    archivedAt: null,
    id: 'channel-public',
    label: 'General',
    slug: 'general',
    team: { name: 'Core', project: { name: 'Acme' } },
    topic: null,
    visibility: 'public',
  },
  {
    archivedAt: null,
    id: 'channel-private',
    label: 'Founders',
    slug: 'founders',
    team: { name: 'Core', project: { name: 'Acme' } },
    topic: null,
    visibility: 'private',
  },
]

const buildContext = () => {
  const consumedSources = createConsumedSourceSink()
  const context = {
    actorContext: {
      actionContext: { effectiveUserId: USER },
      actor: { actorId: USER, actorType: 'user', roles: ['member'] },
      tenant: {},
    },
    agentId: 'agent-1',
    agentKind: 'shared',
    channel: { id: 'home-dm', organizationId: ORG, systemChannelType: 'system_agent' },
    consumedSources,
    prisma: {
      channel: { findMany: async () => CHANNELS },
      organizationMember: {
        findUnique: async () => ({ deactivatedAt: null, role: 'member' }),
      },
    },
  } as unknown as BuiltinToolRuntimeContext
  return { consumedSources, context }
}

test('channel_list stamps the non-public channels it resolved through membership', async () => {
  const { consumedSources, context } = buildContext()
  await runChannelListTool(context, {})

  assert.deepEqual(consumedSources.list(), [
    { scopeId: 'channel-private', scopeType: 'channel' },
  ])
})

test('channel_find stamps the same way', async () => {
  const { consumedSources, context } = buildContext()
  await runChannelFindTool(context, { query: 'founders' })

  assert.deepEqual(consumedSources.list(), [
    { scopeId: 'channel-private', scopeType: 'channel' },
  ])
})

test('a channel-specific policy read includes current enum options and participant principals', async () => {
  const { consumedSources, context } = buildContext()
  const channelId = '33333333-3333-4333-8333-333333333333'
  const participants = [{ agentId: '44444444-4444-4444-8444-444444444444', principalUserId: USER }]
  context.prisma = {
    channel: { findMany: async (query: { where: { id: string } }) => {
      assert.equal(query.where.id, channelId)
      return [{ ...CHANNELS[1], id: channelId, decisionPolicy: DEFAULT_CHANNEL_DECISION_POLICY,
        agentBindings: participants }]
    } },
  } as unknown as BuiltinToolRuntimeContext['prisma']
  const result = await runChannelListTool(context, { channelId })
  assert.ok(result.outputPreview?.includes(JSON.stringify(DEFAULT_CHANNEL_DECISION_POLICY)))
  assert.ok(result.outputPreview?.includes(JSON.stringify(participants)))
  assert.deepEqual(consumedSources.list(), [{ scopeId: channelId, scopeType: 'channel' }])
})

test('agent_list stamps private agents only, never team-visible ones', () => {
  const consumedSources = createConsumedSourceSink()
  recordVisibleAgentRead({ consumedSources }, [
    { id: 'agent-private', visibility: 'private' },
    { id: 'agent-team', visibility: 'team' },
  ])

  // A team-visible agent is deliberately NOT stamped `agent:<id>`: an org
  // owner's list is wider than the shared visibility predicate that scope
  // denotes, so stamping would withhold the reply from the person who asked.
  assert.deepEqual(consumedSources.list(), [
    { scopeId: 'agent-private', scopeType: 'agent' },
  ])
})
