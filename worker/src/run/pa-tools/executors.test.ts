import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOrganizationId, parseUserId } from '@nessie/schemas'

import {
  runExecutorDescriptorReviewPrepareTool,
  runExecutorPairTool,
} from './executors.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'

const makeContext = (
  overrides: Partial<BuiltinToolRuntimeContext> = {},
): BuiltinToolRuntimeContext => ({
  agentId: '22222222-2222-4222-8222-222222222222',
  agentKind: 'personal_assistant',
  actorContext: {
    actor: { actorId: USER_ID, actorType: 'user' },
    tenant: { organizationId: parseOrganizationId('33333333-3333-4333-8333-333333333333') },
    actionContext: {
      effectiveUserId: parseUserId(USER_ID),
      requestId: 'executor-pa-test',
    },
  },
  channel: {
    id: '44444444-4444-4444-8444-444444444444',
    organizationId: parseOrganizationId('33333333-3333-4333-8333-333333333333'),
    systemChannelType: 'personal_assistant',
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
  toolCallId: null,
  ...overrides,
})

test('executor management refuses a shared agent even when it has a user context', async () => {
  await assert.rejects(
    () => runExecutorPairTool(makeContext({ agentKind: 'shared' })),
    /Personal Assistant conversation/,
  )
})

test('executor management refuses a personal assistant outside its own DM', async () => {
  await assert.rejects(
    () => runExecutorPairTool(makeContext({
      channel: {
        id: '44444444-4444-4444-8444-444444444444',
        organizationId: parseOrganizationId('33333333-3333-4333-8333-333333333333'),
        systemChannelType: null,
      },
    })),
    /Personal Assistant conversation/,
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
