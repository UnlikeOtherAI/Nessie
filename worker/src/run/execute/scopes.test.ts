import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_DESIGNER_SLUG, globalAgentHomeDmKey } from '@nessie/team-admin'

import { buildScopesForAgent } from './scopes.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const CHANNEL = '44444444-4444-4444-8444-444444444444'
const AGENT = '55555555-5555-4555-8555-555555555555'
const USER = '22222222-2222-4222-8222-222222222222'

const channel = (
  overrides: Partial<Parameters<typeof buildScopesForAgent>[0]> = {},
): Parameters<typeof buildScopesForAgent>[0] => ({
  id: CHANNEL,
  organizationId: ORG,
  projectId: 'p',
  systemChannelType: null,
  teamId: 't',
  ...overrides,
})

const kinds = (scopes: ReturnType<typeof buildScopesForAgent>) =>
  scopes.map((scope) => scope.kind).sort()

test('an ordinary channel keeps the organization and agent lanes', () => {
  assert.deepEqual(
    kinds(buildScopesForAgent(channel(), { agentKind: 'shared', id: AGENT })),
    ['agent', 'channel', 'organization'],
  )
})

test('a PA DM publishes on its channel lane alone', () => {
  assert.deepEqual(
    kinds(
      buildScopesForAgent(channel({ systemChannelType: 'personal_assistant' }), {
        agentKind: 'personal_assistant',
        id: AGENT,
      }),
    ),
    ['channel'],
  )
})

test("a global agent's home DM publishes on its channel lane alone", () => {
  const home = channel({
    dmKey: globalAgentHomeDmKey({
      organizationId: ORG,
      slug: AGENT_DESIGNER_SLUG,
      userId: USER,
    }),
    systemChannelType: 'system_agent',
  })

  assert.deepEqual(
    kinds(
      buildScopesForAgent(home, {
        agentKind: 'shared',
        id: AGENT,
        systemSlug: AGENT_DESIGNER_SLUG,
      }),
    ),
    ['channel'],
    'an org lane would broadcast one person’s private design conversation, and '
    + 'the agent lane would reach every member’s home DM of the same global row',
  )

  // The same agent outside its home keeps the ordinary lanes.
  assert.deepEqual(
    kinds(
      buildScopesForAgent(channel(), {
        agentKind: 'shared',
        id: AGENT,
        systemSlug: AGENT_DESIGNER_SLUG,
      }),
    ),
    ['agent', 'channel', 'organization'],
  )
})
