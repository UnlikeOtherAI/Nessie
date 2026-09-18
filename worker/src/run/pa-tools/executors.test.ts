import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOrganizationId, parseUserId } from '@nessie/schemas'
import { AGENT_DESIGNER_SLUG, globalAgentHomeDmKey } from '@nessie/team-admin'

import {
  runExecutorDescriptorReviewPrepareTool,
  runExecutorPairTool,
  runExecutorWorkspacePromotionPrepareTool,
} from './executors.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

/**
 * Which surface an executor tool may act on.
 *
 * The gate used to read `agentKind === 'personal_assistant'` AND the PA's own
 * channel type, which is exactly the defect `runDelegatesToRequestingPerson`
 * was written to remove: the Agent Designer is `agentKind: 'shared'` and
 * delegates just as completely inside its own home DM, so the whole executor
 * estate was invisible to it with no failing check anywhere. Widening the gate
 * to the one predicate must widen nothing else, so the refusals it has always
 * made are pinned here beside the admission it now allows.
 *
 * `executor_pair` is the probe throughout because it is the one executor tool
 * that reads nothing: what it returns is the gate's verdict and nothing else.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_ORGANIZATION_ID = '99999999-9999-4999-8999-999999999999'

const DESIGNER_HOME_DM_KEY = globalAgentHomeDmKey({
  organizationId: ORGANIZATION_ID,
  slug: AGENT_DESIGNER_SLUG,
  userId: USER_ID,
})

type RunContextFacts = {
  agentKind: 'personal_assistant' | 'shared'
  dmKey: string | null
  organizationId: string
  systemChannelType: string | null
  systemSlug: string | null
}

const personalAssistantFacts: RunContextFacts = {
  agentKind: 'personal_assistant',
  dmKey: null,
  organizationId: ORGANIZATION_ID,
  systemChannelType: 'personal_assistant',
  systemSlug: null,
}

const designerHomeFacts: RunContextFacts = {
  agentKind: 'shared',
  dmKey: DESIGNER_HOME_DM_KEY,
  organizationId: ORGANIZATION_ID,
  systemChannelType: 'system_agent',
  systemSlug: AGENT_DESIGNER_SLUG,
}

const makeContext = (
  overrides: Partial<BuiltinToolRuntimeContext> = {},
  facts: RunContextFacts = personalAssistantFacts,
): BuiltinToolRuntimeContext => ({
  agentId: '22222222-2222-4222-8222-222222222222',
  agentKind: facts.agentKind,
  actorContext: {
    actor: { actorId: USER_ID, actorType: 'user' },
    tenant: { organizationId: parseOrganizationId(ORGANIZATION_ID) },
    actionContext: {
      effectiveUserId: parseUserId(USER_ID),
      requestId: 'executor-pa-test',
    },
  },
  channel: {
    id: '44444444-4444-4444-8444-444444444444',
    organizationId: parseOrganizationId(ORGANIZATION_ID),
    systemChannelType: facts.systemChannelType as never,
  },
  ledgerIdentity: null,
  prisma: {} as BuiltinToolRuntimeContext['prisma'],
  realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
  run: {
    id: '55555555-5555-4555-8555-555555555555',
    messageId: '66666666-6666-4666-8666-666666666666',
    originatingUserId: USER_ID,
    threadId: '77777777-7777-4777-8777-777777777777',
  },
  runContext: {
    agent: { agentKind: facts.agentKind, systemSlug: facts.systemSlug },
    channel: {
      dmKey: facts.dmKey,
      organizationId: facts.organizationId,
      systemChannelType: facts.systemChannelType,
    },
  } as unknown as BuiltinToolRuntimeContext['runContext'],
  toolCallId: null,
  ...overrides,
})

const REFUSAL = /Executor management is available only/

test('the Personal Assistant keeps its own arm, in its own DM', async () => {
  const result = await runExecutorPairTool(makeContext())
  assert.match(result.outputPreview, /\/agents\/executors/)
})

test('the Agent Designer reaches executor tools in its own home DM', async () => {
  const result = await runExecutorPairTool(makeContext({}, designerHomeFacts))
  assert.match(result.outputPreview, /\/agents\/executors/)
})

test('executor management refuses a shared agent that delegates to nobody', async () => {
  await assert.rejects(
    () => runExecutorPairTool(makeContext({}, {
      ...designerHomeFacts, dmKey: null, systemChannelType: null, systemSlug: null,
    })),
    REFUSAL,
  )
})

test('executor management refuses a personal assistant outside its own DM', async () => {
  await assert.rejects(
    () => runExecutorPairTool(makeContext({}, {
      ...personalAssistantFacts, systemChannelType: null,
    })),
    REFUSAL,
  )
})

test('a global agent in a shared channel is refused, home DM or not', async () => {
  // A global agent bound into an ordinary room advises; it never acts as
  // whoever happened to speak, so its executor estate is out of reach there.
  await assert.rejects(
    () => runExecutorPairTool(makeContext({}, {
      ...designerHomeFacts, dmKey: null, systemChannelType: null,
    })),
    REFUSAL,
  )
})

test('an unattended run is refused even on the right surface', async () => {
  // No requester means nothing to act as, and reconstructing an absent one is
  // exactly what the originating-user equality check exists to stop.
  await assert.rejects(
    () => runExecutorPairTool(makeContext({
      run: {
        id: '55555555-5555-4555-8555-555555555555',
        messageId: '66666666-6666-4666-8666-666666666666',
        originatingUserId: null,
        threadId: '77777777-7777-4777-8777-777777777777',
      },
    }, designerHomeFacts)),
    REFUSAL,
  )
})

test('a home DM key belonging to another organisation is refused', async () => {
  await assert.rejects(
    () => runExecutorPairTool(makeContext({}, {
      ...designerHomeFacts, organizationId: OTHER_ORGANIZATION_ID,
    })),
    REFUSAL,
  )
})

test('a run with no loaded conversation fails closed', async () => {
  await assert.rejects(
    () => runExecutorPairTool(makeContext({ runContext: undefined }, designerHomeFacts)),
    REFUSAL,
  )
})

test('descriptor review preparation rejects an invalid activation request before any mutation', async () => {
  await assert.rejects(
    () => runExecutorDescriptorReviewPrepareTool(makeContext(), {
      executorId: '88888888-8888-4888-8888-888888888888',
      revision: 0,
      status: 'active',
    }),
    /positive integer/,
  )
  await assert.rejects(
    () => runExecutorDescriptorReviewPrepareTool(makeContext(), {
      executorId: '88888888-8888-4888-8888-888888888888',
      revision: 1,
      status: 'pending_review',
    }),
    /active or disabled/,
  )
})

test('workspace-promotion preparation is limited to an exact reviewed command and never falls back without receipt access', async () => {
  await assert.rejects(
    () => runExecutorWorkspacePromotionPrepareTool(makeContext(), { reviewCommandId: 'not-a-uuid' }),
    /encrypted executor receipt access is not configured/,
  )
  await assert.rejects(
    () => runExecutorWorkspacePromotionPrepareTool(makeContext({
      executorCommandEncryptionSecret: 'test-secret',
    }), { reviewCommandId: 'not-a-uuid' }),
    /reviewCommandId must be a UUID/,
  )
})
