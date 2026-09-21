import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { resolveChannelPolicyReplay } from '../src/channel-policy-replay.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const CONTEXT = {
  channelId: '33333333-3333-4333-8333-333333333333',
  organizationId: '44444444-4444-4444-8444-444444444444', messageId: 'trigger',
  target: { agentId: AGENT }, promptOverride: 'Reply briefly.',
}
const plain = { action: 'reply', agentId: AGENT, promptOverride: 'Reply briefly.' }
const work = { action: 'reply', agentId: AGENT, promptOverride: 'Record the decision.', policyWork: true }
const snapshot = (decisions: unknown[]) => ({
  authorizer: null, policyFingerprint: 'original', basisScopes: [], disclosureSources: [], decisions,
})
// These selection cases must not reach identity/network/binding queries at all.
const noQueries = {} as PrismaClient

test('replay selects an ordinary reply by exact prompt even beside policy work for the same agent', async () => {
  assert.equal(await resolveChannelPolicyReplay(noQueries, {
    ...CONTEXT, snapshot: snapshot([plain, work]),
  }), null)
})

test('replay never selects another PA principal or an unrelated decision target', async () => {
  await assert.rejects(resolveChannelPolicyReplay(noQueries, {
    ...CONTEXT, promptOverride: work.promptOverride,
    snapshot: snapshot([{ ...work, principalUserId: USER }]),
  }), /target and instructions/)
})

test('malformed, ambiguous and changed decision snapshots refuse replay instead of substituting caller authority', async () => {
  await assert.rejects(resolveChannelPolicyReplay(noQueries, { ...CONTEXT, snapshot: {} }), /invalid/)
  await assert.rejects(resolveChannelPolicyReplay(noQueries, {
    ...CONTEXT, snapshot: snapshot([plain, { ...plain, policyWork: true }]),
  }), /ambiguous/)
  await assert.rejects(resolveChannelPolicyReplay(noQueries, {
    ...CONTEXT, snapshot: snapshot([work]),
  }), /no longer matches/)
})

test('matching custom work requires its saved authorizer, never the lifecycle caller', async () => {
  await assert.rejects(resolveChannelPolicyReplay(noQueries, {
    ...CONTEXT, promptOverride: work.promptOverride, snapshot: snapshot([plain, work]),
  }), /saved again/)
})
