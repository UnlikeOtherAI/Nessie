import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isMcpRegistryRowExposed,
  type McpRunScopeContext,
} from '../src/run/mcp-tool-access.js'

const CREATOR = 'user-creator'
const COLLEAGUE = 'user-colleague'

const run = (overrides: Partial<McpRunScopeContext> = {}): McpRunScopeContext => ({
  agentKind: 'shared',
  channelId: 'channel-1',
  effectiveUserId: CREATOR,
  isPersonalAssistantPresence: false,
  projectId: 'project-1',
  teamId: 'team-1',
  ...overrides,
})

const exposed = (input: {
  ctx: McpRunScopeContext
  instance: { scopeType: string; scopeId: string }
  toolPolicy?: Record<string, boolean> | null
  requiresExplicitGrant?: boolean
  grants?: Array<{ agentId: string | null; config: unknown; state: string }>
}): boolean =>
  isMcpRegistryRowExposed(
    input.toolPolicy ?? null,
    'row-1',
    input.instance,
    input.ctx,
    { requiresExplicitGrant: input.requiresExplicitGrant ?? true },
    input.grants ?? [],
    'agent-designer',
    'fingerprint',
  )

const creatorConnection = { scopeId: CREATOR, scopeType: 'user' }

test('a shared agent uses the connection of the person it is talking to, without a grant', () => {
  assert.equal(exposed({ ctx: run(), instance: creatorConnection }), true)
})

test('the personal assistant uses its person\'s connection outside a presence session too', () => {
  assert.equal(
    exposed({ ctx: run({ agentKind: 'personal_assistant' }), instance: creatorConnection }),
    true,
  )
})

test('an explicit per-tool deny still withholds the person\'s own connection', () => {
  assert.equal(
    exposed({ ctx: run(), instance: creatorConnection, toolPolicy: { 'row-1': false } }),
    false,
  )
})

test('a colleague talking to the same agent never reaches the creator\'s connection', () => {
  assert.equal(
    exposed({
      ctx: run({ effectiveUserId: COLLEAGUE }),
      grants: [{ agentId: 'agent-designer', config: {}, state: 'allowed' }],
      instance: creatorConnection,
      toolPolicy: { 'row-1': true },
    }),
    false,
  )
})

test('a shared team connection still needs its per-agent grant', () => {
  assert.equal(
    exposed({ ctx: run(), instance: { scopeId: 'team-1', scopeType: 'team' } }),
    false,
  )
})
