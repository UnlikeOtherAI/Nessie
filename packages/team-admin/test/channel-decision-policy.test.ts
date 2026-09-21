import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CHANNEL_DECISION_POLICY, type ChannelDecisionPolicy } from '@nessie/schemas'
import {
  ChannelDecisionPolicyError,
  matchesChannelDecisionTarget,
  validateChannelDecisionPolicy,
} from '../src/channel-decision-policy.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const CHANNEL = '33333333-3333-4333-8333-333333333333'
const ORGANIZATION = '44444444-4444-4444-8444-444444444444'
const OTHER = '55555555-5555-4555-8555-555555555555'

const policyFor = (principalUserId?: string): ChannelDecisionPolicy => ({
  ...DEFAULT_CHANNEL_DECISION_POLICY,
  questions: [{ id: 'record', instructions: 'Record a settled decision?', options: [
    { id: 'none', description: 'No settled decision.' },
    { id: 'record', description: 'Keep this decision.', followUp: {
      agentId: AGENT, ...(principalUserId ? { principalUserId } : {}), instructions: 'Update the decision log.',
    } },
  ] }],
})

const prismaFor = (principalUserId: string | null, found = true) => ({
  agentBinding: {
    findMany: async (query: { where: unknown }) => {
      assert.deepEqual(query.where, {
        channelId: CHANNEL, agentId: { in: [AGENT] },
        agent: { organizationId: ORGANIZATION, visibility: { not: 'private' } },
      })
      return found ? [{ agentId: AGENT, principalUserId }] : []
    },
  },
}) as unknown as Parameters<typeof validateChannelDecisionPolicy>[0]

const input = (policy: ChannelDecisionPolicy | null) => ({
  channelId: CHANNEL, organizationId: ORGANIZATION, userId: USER, policy,
})

test('only exact channel participants are valid follow-up targets', async () => {
  assert.deepEqual(await validateChannelDecisionPolicy(prismaFor(null), input(policyFor())), policyFor())
  await assert.rejects(validateChannelDecisionPolicy(prismaFor(null, false), input(policyFor())),
    ChannelDecisionPolicyError)
})

test('a PA presence needs the exact principal and cannot borrow another user authority', async () => {
  assert.deepEqual(await validateChannelDecisionPolicy(prismaFor(USER), input(policyFor(USER))), policyFor(USER))
  await assert.rejects(validateChannelDecisionPolicy(prismaFor(USER), input(policyFor())), ChannelDecisionPolicyError)
  await assert.rejects(validateChannelDecisionPolicy(prismaFor(null), input(policyFor(USER))),
    ChannelDecisionPolicyError)
  await assert.rejects(validateChannelDecisionPolicy(prismaFor(OTHER), input(policyFor(OTHER))), /only your own/)
})

test('disabled policies still validate destinations, while clearing needs no participant lookup', async () => {
  await assert.rejects(validateChannelDecisionPolicy(prismaFor(null, false), input(policyFor())),
    ChannelDecisionPolicyError)
  assert.equal(await validateChannelDecisionPolicy(prismaFor(null, false), input(null)), null)
})

test('live runtime matching never treats a PA principal as an ordinary binding', () => {
  assert.equal(matchesChannelDecisionTarget({ agentId: AGENT }, { agentId: AGENT, principalUserId: null }), true)
  assert.equal(matchesChannelDecisionTarget({ agentId: AGENT }, { agentId: AGENT, principalUserId: USER }), false)
  assert.equal(matchesChannelDecisionTarget({ agentId: AGENT, principalUserId: USER }, {
    agentId: AGENT, principalUserId: OTHER,
  }), false)
})
