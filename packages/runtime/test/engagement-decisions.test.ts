import assert from 'node:assert/strict'
import test from 'node:test'

import type { DecisionModelClient } from '../src/decision-model.js'
import { ENGAGEMENT_MINIMUM_PROBABILITY, judgeChannelEngagement } from '../src/engagement-decisions.js'
import { ProviderInvocationError } from '../src/inference/types.js'
import type { ModelClient } from '../src/model.js'
import { decideAgentEngagement, type OrchestratorAgent } from '../src/orchestrator.js'

/**
 * Jev is a stub: the unit under test is the question the room asks it and
 * what each answer becomes, including every way of handing the decision back
 * to the generative orchestrator. Messages are Czech and slang on purpose —
 * the code never reads them.
 */

const usage = { organizationId: 'org', requestId: 'message-1' }
const aria: OrchestratorAgent = { id: 'a-1', name: 'Aria', role: 'researcher', systemPrompt: 'Finds sources.' }
const beck: OrchestratorAgent = { id: 'b-1', name: 'Beck', role: 'bookkeeper', systemPrompt: null }

const stub = (answers: Record<string, [string, number]>) => {
  const seen: Array<Parameters<DecisionModelClient['evaluate']>[0]> = []
  const client: DecisionModelClient = {
    evaluate: async (input) => {
      seen.push(input)
      return Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
        const [choice, probability] = answers[id] ?? [Object.keys(question.criteria)[0]!, 0.3]
        return [id, { type: 'choice' as const, choice, probabilities: { [choice]: probability } }]
      }))
    },
  }
  return { client, seen }
}

const failing = (error: unknown): DecisionModelClient => ({ evaluate: async () => { throw error } })

const judge = (client: DecisionModelClient, agents = [aria, beck], followingAgentIds: string[] = []) =>
  judgeChannelEngagement(client, {
    agents, content: 'kdo mi najde ty faktury z řijna?', followingAgentIds,
    recentMessages: [{ role: 'user', content: 'x'.repeat(2_000) }], usage,
  })

test('the room asks whether to engage, whom, where and with which reaction', async () => {
  const { client, seen } = stub({ engagement: ['none', 0.95] })
  await judge(client, [aria, beck], [beck.id])

  const asked = seen[0]!
  assert.deepEqual(Object.keys(asked.questions), ['engagement', 'agent', 'placement', 'reaction'])
  assert.deepEqual(Object.keys(asked.questions.engagement!.criteria), ['reply', 'acknowledge', 'none'])
  assert.deepEqual(Object.keys(asked.questions.agent!.criteria), ['none', aria.id, beck.id])
  assert.deepEqual(Object.keys(asked.questions.reaction!.criteria), ['agree', 'celebrate', 'thanks'])
  // A follower is marked as one, and long history reaches Jev only as an excerpt.
  const agents = asked.state.agents as Array<Record<string, unknown>>
  assert.equal(agents[1]!.already_participating_in_this_thread, true)
  assert.equal(agents[0]!.already_participating_in_this_thread, undefined)
  const recent = asked.state.recent_messages as Array<{ content: string }>
  assert.ok(recent[0]!.content.endsWith('[excerpt]'))
  // The generative orchestrator is still there, so Jev is not waited on long.
  assert.ok(asked.timeoutMs !== undefined && asked.timeoutMs <= 5_000)
})

test('with one agent in the room there is no one else to choose', async () => {
  const { client, seen } = stub({ engagement: ['reply', 0.9] })
  const decisions = await judge(client, [aria])

  assert.equal(seen[0]!.questions.agent, undefined)
  assert.deepEqual(decisions, [{ action: 'reply', agentId: aria.id, replyPlacement: 'thread' }])
})

test('a confident "stay out" is final, with no generative call behind it', async () => {
  const { client } = stub({ engagement: ['none', ENGAGEMENT_MINIMUM_PROBABILITY] })
  assert.deepEqual(await judge(client), [])
})

test('a confident reply names the agent and carries its placement', async () => {
  const { client } = stub({ engagement: ['reply', 0.92], agent: [beck.id, 0.88], placement: ['channel', 0.9] })
  assert.deepEqual(await judge(client), [{ action: 'reply', agentId: beck.id, replyPlacement: 'channel' }])
})

test('an unsure placement keeps the reply with the exchange that asked for it', async () => {
  const { client } = stub({ engagement: ['reply', 0.92], agent: [beck.id, 0.88], placement: ['channel', 0.6] })
  assert.deepEqual(await judge(client), [{ action: 'reply', agentId: beck.id, replyPlacement: 'thread' }])
})

test('an acknowledgement reacts with the fitting emoji, or 👍 when unsure', async () => {
  const sure = stub({ engagement: ['acknowledge', 0.9], agent: [aria.id, 0.9], reaction: ['thanks', 0.85] })
  assert.deepEqual(await judge(sure.client), [{ action: 'acknowledge', agentId: aria.id, emoji: '❤️' }])
  const unsure = stub({ engagement: ['acknowledge', 0.9], agent: [aria.id, 0.9], reaction: ['thanks', 0.5] })
  assert.deepEqual(await judge(unsure.client), [{ action: 'acknowledge', agentId: aria.id, emoji: '👍' }])
})

test('a PA presence keeps its owner', async () => {
  const presence: OrchestratorAgent = { ...aria, engagementId: 'pa:owner-1', principalUserId: 'owner-1' }
  const { client, seen } = stub({ engagement: ['reply', 0.9], agent: ['pa:owner-1', 0.9] })
  const decisions = await judge(client, [presence, beck])

  assert.ok('pa:owner-1' in seen[0]!.questions.agent!.criteria)
  assert.deepEqual(decisions, [{
    action: 'reply', agentId: aria.id, principalUserId: 'owner-1', replyPlacement: 'thread',
  }])
})

test('doubt, a contradiction or a failure hands the decision back', async () => {
  assert.equal(await judge(stub({ engagement: ['reply', 0.7] }).client), null)
  assert.equal(await judge(stub({ engagement: ['reply', 0.9], agent: ['none', 0.9] }).client), null)
  assert.equal(await judge(stub({ engagement: ['reply', 0.9], agent: [aria.id, 0.5] }).client), null)
  assert.equal(await judge(failing(new Error('ledger unavailable'))), null)
  assert.equal(
    await judgeChannelEngagement(stub({ engagement: ['none', 0.99] }).client, {
      agents: [aria], content: 'hej', followingAgentIds: [], recentMessages: [],
    }),
    null,
    'no attribution, no call',
  )
})

const creditRefusal = () => new ProviderInvocationError(
  'vercel evaluate request failed with HTTP 402',
  {
    finishReason: 'error', invocationId: 'invocation-402', latencyMs: 1, model: 'typesafe-ai/jev',
    operationType: 'other', provider: 'vercel', requestId: 'request-402', usage: {},
  },
  undefined,
  { creditRefusal: 'ledger', providerCode: 'budget_exceeded', statusCode: 402 },
)

test('exhausted credits are surfaced, not retried on the generative model', async () => {
  const refusal = creditRefusal()
  await assert.rejects(judge(failing(refusal)), (error) => error === refusal)
})

const model = (reply: string) => {
  let calls = 0
  const client = { chat: async () => { calls += 1; return reply } } as unknown as ModelClient
  return { client, calls: () => calls }
}

test('the orchestrator uses Jev\'s sure answer and never asks the generative model', async () => {
  const generative = model('{"action":"reply","agentId":"a-1"}')
  const decisions = await decideAgentEngagement(generative.client, {
    agents: [aria, beck], content: 'dobrý, díky kluci', recentMessages: [], triggerIsHuman: true,
    decisionClient: stub({ engagement: ['none', 0.97] }).client, usage,
  })

  assert.deepEqual(decisions, [])
  assert.equal(generative.calls(), 0)
})

test('the orchestrator asks the generative model when Jev is unsure', async () => {
  const generative = model('{"action":"reply","agentId":"b-1","replyPlacement":"thread"}')
  const decisions = await decideAgentEngagement(generative.client, {
    agents: [aria, beck], content: 'hmm a co ty čísla?', recentMessages: [], triggerIsHuman: true,
    decisionClient: stub({ engagement: ['reply', 0.55] }).client, usage,
  })

  assert.deepEqual(decisions, [{ action: 'reply', agentId: beck.id, replyPlacement: 'thread' }])
  assert.equal(generative.calls(), 1)
})

test('structural answers still come first: Jev is not asked about an @mention', async () => {
  const { client, seen } = stub({ engagement: ['none', 0.99] })
  const generative = model('{}')
  const decisions = await decideAgentEngagement(generative.client, {
    agents: [aria, beck], content: '@Beck mrkneš na to?', recentMessages: [], triggerIsHuman: true,
    decisionClient: client, usage,
  })

  assert.deepEqual(decisions, [{ action: 'reply', agentId: beck.id, replyPlacement: 'thread' }])
  assert.equal(seen.length, 0)
  assert.equal(generative.calls(), 0)
})
