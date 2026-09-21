import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import {
  AuthorizedActionContextSchema, DEFAULT_CHANNEL_DECISION_POLICY, OrchestrateDecideJobPayloadSchema,
} from '@nessie/schemas'
import type { DecisionModelClient } from '@nessie/runtime'
import { evaluateChannelPolicy } from './orchestrate-policy.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const agent = { id: id(1), name: 'Archivist', role: 'Keep decisions current', systemPrompt: null }
const authorizer = AuthorizedActionContextSchema.parse({
  actor: { actorId: id(2), actorType: 'user', roles: ['member'] },
  tenant: { organizationId: id(3), teamId: id(4) },
  actionContext: { requestId: 'saved-policy', channelId: id(5), purpose: 'channel.policy', effectiveUserId: id(2) },
})
const payload = OrchestrateDecideJobPayloadSchema.parse({
  actorContext: {
    ...authorizer, actor: { actorId: id(6), actorType: 'user', roles: ['owner'] },
    actionContext: { ...authorizer.actionContext, effectiveUserId: id(6), purpose: 'message.create' },
  },
  channelAgents: [agent], channelId: id(5), content: 'Platí, díky!', messageId: id(7),
  role: 'user', threadId: id(8),
})
const policy = {
  ...DEFAULT_CHANNEL_DECISION_POLICY, enabled: true,
  questions: [{ id: 'decision', instructions: 'What stage is the decision at?', options: [
    { id: 'skip', description: 'No lasting decision' },
    { id: 'proposal', description: 'Still discussing' },
    { id: 'record', description: 'Confirmed', followUp: {
      agentId: agent.id, instructions: 'Record this decision in the project log.',
    } },
  ] }],
}
const input = {
  payload, policy, authorizer, snapshot: null, structuralDecisions: null,
  context: { content: payload.content, recentMessages: [], followingAgentIds: [],
    basisScopes: [], disclosureSources: [] }, restrictedTrigger: false,
}
const fixture = () => {
  let snapshot: unknown = null
  let bound = true
  let calls = 0
  const client: DecisionModelClient = { evaluate: async ({ questions }) => {
    calls++
    const picks: Record<string, string> = {
      engagement: 'acknowledge', agent: agent.id, reaction: 'r0', custom_decision: 'record',
    }
    return Object.fromEntries(Object.entries(questions).map(([key, question]) => {
      const selected = picks[key] ?? Object.keys(question.criteria)[0]!
      return [key, { type: 'choice', choice: selected, probabilities: Object.fromEntries(
        Object.keys(question.criteria).map((option) => [option, Number(option === selected)]),
      ) }]
    }))
  } }
  const prisma = {
    agentBinding: { findMany: async () => bound ? [{ agentId: agent.id, principalUserId: null }] : [] },
    message: {
      updateMany: async ({ data }: { data: { channelDecision: unknown } }) => {
        if (snapshot) return { count: 0 }
        snapshot = data.channelDecision
        return { count: 1 }
      },
      findUniqueOrThrow: async () => ({ channelDecision: snapshot }),
    },
  } as unknown as PrismaClient
  return { prisma, client, snapshot: () => snapshot, calls: () => calls, unbind: () => { bound = false } }
}

test('replay pins actions and policy authorizer despite a new policy or unavailable classifier', async () => {
  const f = fixture()
  const first = await evaluateChannelPolicy({ prisma: f.prisma, decisionClient: f.client }, input)
  assert.equal(first.decisions.length, 2)
  assert.equal(first.authorizer?.actor.actorId, id(2))
  const replay = await evaluateChannelPolicy({ prisma: f.prisma }, {
    ...input, snapshot: f.snapshot(), policy: { ...policy, questions: [] }, authorizer: payload.actorContext,
  })
  assert.deepEqual(replay, first)
  assert.equal(f.calls(), 1)
  f.unbind()
  assert.deepEqual((await evaluateChannelPolicy({ prisma: f.prisma }, {
    ...input, snapshot: f.snapshot(),
  })).decisions, [])
})

test('racing redeliveries both return the single persisted decision snapshot', async () => {
  const f = fixture()
  const outcomes = await Promise.all([input, { ...input, authorizer: payload.actorContext }].map((request) =>
    evaluateChannelPolicy({ prisma: f.prisma, decisionClient: f.client }, request)))
  assert.deepEqual(outcomes[0], outcomes[1])
  assert.ok(f.snapshot())
})

test('restricted input never drives public policy effects but preserves an explicit address', async () => {
  const f = fixture()
  const addressed = [{ action: 'reply' as const, agentId: agent.id, replyPlacement: 'thread' as const }]
  const result = await evaluateChannelPolicy({ prisma: f.prisma, decisionClient: f.client }, {
    ...input, restrictedTrigger: true, structuralDecisions: addressed,
  })
  assert.deepEqual(result, { decisions: addressed, authorizer: null })
  assert.equal(f.calls(), 0)
  assert.equal(f.snapshot(), null)
})
