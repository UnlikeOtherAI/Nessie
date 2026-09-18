import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_DESIGNER_SLUG, globalAgentHomeDmKey } from '@nessie/team-admin'

import { runExecutorPairTool } from '../src/run/pa-tools/executors.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

/**
 * Which surface an executor tool may act on.
 *
 * The gate used to read `agentKind === 'personal_assistant'` AND the PA's own
 * channel type, which is the exact defect `runDelegatesToRequestingPerson` was
 * written to remove: the Agent Designer is `agentKind: 'shared'` and delegates
 * just as completely inside its own home DM, so the whole executor estate was
 * invisible to it with no failing check anywhere. Widening the gate to the one
 * predicate must not widen anything else, so the three refusals it has always
 * made are pinned here beside the admission.
 *
 * `executor_pair` is the probe because it is the one executor tool that reads
 * nothing: what it returns is the gate's verdict and nothing else.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const USER = '22222222-2222-4222-8222-222222222222'
const AGENT = '44444444-4444-4444-8444-444444444444'

const HOME_DM_KEY = globalAgentHomeDmKey({
  organizationId: ORG,
  slug: AGENT_DESIGNER_SLUG,
  userId: USER,
})

type Surface = {
  agentKind: 'personal_assistant' | 'shared'
  dmKey: string | null
  organizationId?: string
  originatingUserId: string | null
  systemChannelType: string | null
  systemSlug: string | null
}

const contextFor = (surface: Surface): BuiltinToolRuntimeContext => ({
  actorContext: {
    actionContext: { effectiveUserId: USER },
    actor: { actorId: USER, actorType: 'user' },
    tenant: { organizationId: ORG },
  },
  agentId: AGENT,
  agentKind: surface.agentKind,
  channel: { id: 'channel', organizationId: ORG, systemChannelType: surface.systemChannelType },
  run: { id: 'run', messageId: 'message', originatingUserId: surface.originatingUserId, threadId: 'thread' },
  runContext: {
    agent: { agentKind: surface.agentKind, systemSlug: surface.systemSlug },
    channel: {
      dmKey: surface.dmKey,
      organizationId: surface.organizationId ?? ORG,
      systemChannelType: surface.systemChannelType,
    },
  },
} as unknown as BuiltinToolRuntimeContext)

const designerHome: Surface = {
  agentKind: 'shared',
  dmKey: HOME_DM_KEY,
  originatingUserId: USER,
  systemChannelType: 'system_agent',
  systemSlug: AGENT_DESIGNER_SLUG,
}

const refuses = async (surface: Surface, because: string): Promise<void> => {
  await assert.rejects(
    () => runExecutorPairTool(contextFor(surface)),
    /Executor management is available only/,
    because,
  )
}

test('the Designer reaches executor tools in its own home DM', async () => {
  const result = await runExecutorPairTool(contextFor(designerHome))
  assert.match(result.outputPreview, /\/agents\/executors/)
})

test('the Personal Assistant keeps its own arm unchanged', async () => {
  const result = await runExecutorPairTool(contextFor({
    agentKind: 'personal_assistant',
    dmKey: null,
    originatingUserId: USER,
    systemChannelType: 'personal_assistant',
    systemSlug: null,
  }))
  assert.match(result.outputPreview, /\/agents\/executors/)
})

test('a shared channel is refused, even for the same agent', async () => {
  // A global agent bound into an ordinary room advises; it does not act as
  // whoever happened to speak, so its executor estate is not reachable there.
  await refuses(
    { ...designerHome, dmKey: null, systemChannelType: null },
    'a shared channel is not the person\u2019s private estate',
  )
})

test('an agent that delegates to nobody is refused', async () => {
  await refuses(
    { ...designerHome, dmKey: null, systemChannelType: null, systemSlug: null },
    'an ordinary shared agent has no requesting person to act as',
  )
})

test('an unattended run is refused even on the right surface', async () => {
  // No requester means nothing to act as, and reconstructing one is exactly
  // what the equality check exists to stop.
  await refuses(
    { ...designerHome, originatingUserId: null },
    'an unattended run has no requesting person',
  )
})

test('a home DM belonging to another organisation is refused', async () => {
  await refuses(
    { ...designerHome, organizationId: OTHER_ORG },
    'the home DM key encodes the organisation',
  )
})

test('a run with no loaded conversation fails closed', async () => {
  const context = contextFor(designerHome) as unknown as { runContext?: unknown }
  context.runContext = undefined
  await assert.rejects(
    () => runExecutorPairTool(context as unknown as BuiltinToolRuntimeContext),
    /Executor management is available only/,
  )
})
