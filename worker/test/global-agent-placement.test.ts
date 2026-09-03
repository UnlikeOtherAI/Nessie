import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import {
  AGENT_DESIGNER_SLUG,
  globalAgentHomeDmKey,
} from '@nessie/workspace-admin'

import {
  assertGlobalAgentRunPlacement,
  GlobalAgentPlacementError,
} from '../src/run/execute/global-agent-placement.js'
import { resolveIdentityDelegatedToolIds } from '../src/run/delegated-identity.js'
import { authorizeToolCall } from '../src/run/tool-policy.js'
import type { RunContext } from '../src/run/execute/types.js'

/**
 * Where a global agent may run, now that it is bindable to ordinary channels.
 *
 * Two arms, and only one of them carries identity — so every case here asserts
 * the pair: whether the run is *allowed*, and whether it may exercise the
 * identity-delegated tools. Widening placement without holding the second half
 * would hand `agent_create` to a shared room.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const USER = '22222222-2222-4222-8222-222222222222'
const DESIGNER_AGENT_ID = '44444444-4444-4444-8444-444444444444'
const CHANNEL_ID = '55555555-5555-4555-8555-555555555555'

const HOME_DM_KEY = globalAgentHomeDmKey({
  organizationId: ORG,
  slug: AGENT_DESIGNER_SLUG,
  userId: USER,
})

type PlacementOverrides = {
  boundAgentIds?: readonly string[]
  dmKey?: string | null
  organizationId?: string
  systemChannelType?: RunContext['channel']['systemChannelType']
  systemSlug?: string | null
}

const contextFor = (overrides: PlacementOverrides = {}): RunContext =>
  ({
    agent: {
      agentKind: 'shared',
      id: DESIGNER_AGENT_ID,
      systemSlug: overrides.systemSlug === undefined
        ? AGENT_DESIGNER_SLUG
        : overrides.systemSlug,
    },
    boundAgentIds: overrides.boundAgentIds ?? [],
    channel: {
      dmKey: overrides.dmKey ?? null,
      id: CHANNEL_ID,
      organizationId: overrides.organizationId ?? ORG,
      systemChannelType: overrides.systemChannelType ?? null,
    },
  } as unknown as RunContext)

const homeContext = contextFor({
  boundAgentIds: [DESIGNER_AGENT_ID],
  dmKey: HOME_DM_KEY,
  systemChannelType: 'system_agent',
})

const enabledToolIds = new Set(
  BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.requiresExplicitGrant !== true)
    .map((tool) => tool.id),
)

/** The identity half, asked the same way the run loop asks it. */
const mayCreateAgents = (context: RunContext): boolean =>
  authorizeToolCall(
    'agent_create',
    enabledToolIds,
    BUILTIN_TOOL_DEFINITIONS,
    null,
    null,
    context.agent.agentKind,
    {
      identityToolIds: resolveIdentityDelegatedToolIds(
        {
          agentKind: context.agent.agentKind,
          dmKey: context.channel.dmKey,
          organizationId: context.channel.organizationId,
          systemChannelType: context.channel.systemChannelType,
          systemSlug: context.agent.systemSlug,
        },
        USER,
      ),
    },
  ).allowed

test('an ordinary agent is not governed by this assertion at all', () => {
  assert.doesNotThrow(() =>
    assertGlobalAgentRunPlacement(contextFor({ systemSlug: null })))
})

test('a global agent runs in its own home DM, and delegates there', () => {
  assert.doesNotThrow(() => assertGlobalAgentRunPlacement(homeContext))
  assert.equal(mayCreateAgents(homeContext), true)
})

test('a global agent runs in an ordinary channel it is bound to', () => {
  const bound = contextFor({ boundAgentIds: [DESIGNER_AGENT_ID] })
  assert.doesNotThrow(() => assertGlobalAgentRunPlacement(bound))
})

test('a bound shared channel is advice-only: no identity-delegated tools', () => {
  // The whole point of the second arm. Placement widened; identity did not.
  const bound = contextFor({ boundAgentIds: [DESIGNER_AGENT_ID] })
  assert.equal(mayCreateAgents(bound), false)
})

test('the binding is verified, not the channel kind', () => {
  // Same ordinary channel, someone else's binding on it. A run enqueued after
  // the agent was unbound must fail closed rather than ride the channel type.
  const unbound = contextFor({
    boundAgentIds: ['66666666-6666-4666-8666-666666666666'],
  })
  assert.throws(
    () => assertGlobalAgentRunPlacement(unbound),
    GlobalAgentPlacementError,
  )
  assert.throws(
    () => assertGlobalAgentRunPlacement(contextFor()),
    GlobalAgentPlacementError,
  )
})

test('a system DM that is not its own home stays closed, bound or not', () => {
  for (const systemChannelType of [
    'personal_assistant',
    'external_agent',
    'system_agent',
  ] as const) {
    assert.throws(
      () =>
        assertGlobalAgentRunPlacement(
          contextFor({
            // Even with a binding row present — the second arm must not be
            // reachable through a single-agent surface somebody else owns.
            boundAgentIds: [DESIGNER_AGENT_ID],
            dmKey: 'pa:someone-else',
            systemChannelType,
          }),
        ),
      GlobalAgentPlacementError,
      `${systemChannelType} is refused`,
    )
  }
})

test("another person's home of the same blueprint is refused", () => {
  const foreignHome = contextFor({
    boundAgentIds: [DESIGNER_AGENT_ID],
    dmKey: HOME_DM_KEY,
    organizationId: OTHER_ORG,
    systemChannelType: 'system_agent',
  })
  assert.throws(
    () => assertGlobalAgentRunPlacement(foreignHome),
    GlobalAgentPlacementError,
  )
  assert.equal(mayCreateAgents(foreignHome), false)
})

test('a withdrawn blueprint slug runs nowhere, binding or not', () => {
  for (const context of [
    contextFor({ boundAgentIds: [DESIGNER_AGENT_ID], systemSlug: 'retired-agent' }),
    contextFor({
      dmKey: HOME_DM_KEY,
      systemChannelType: 'system_agent',
      systemSlug: 'retired-agent',
    }),
  ]) {
    assert.throws(
      () => assertGlobalAgentRunPlacement(context),
      GlobalAgentPlacementError,
    )
  }
})
