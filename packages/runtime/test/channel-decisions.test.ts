import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CHANNEL_DECISION_POLICY, type ChannelDecisionPolicy } from '@nessie/schemas'
import { decideChannelActions } from '../src/channel-decisions.js'
import type { DecisionModelClient } from '../src/decision-model.js'

const agent = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Archivist',
  role: 'Keep project decisions current', systemPrompt: null,
}
const policy: ChannelDecisionPolicy = {
  ...DEFAULT_CHANNEL_DECISION_POLICY, enabled: true,
  reactions: [{ emoji: '👍', description: 'Acknowledged' }],
  questions: [{
    id: 'decision', instructions: 'How does this message change the project decision?',
    options: [
      { id: 'proposed', description: 'A proposal still being discussed' },
      {
        id: 'confirmed', description: 'A decision has been made',
        followUp: { agentId: agent.id, instructions: 'Record the confirmed decision in the project decision log.' },
      },
      { id: 'superseded', description: 'An earlier decision is replaced' },
      { id: 'unrelated', description: 'No decision is involved' },
    ],
  }],
}
const input = (content: string) => ({
  policy, agents: [agent], content, recentMessages: [], followingAgentIds: [],
  triggerIsHuman: true, usage: { organizationId: 'org', actorId: 'user', actorType: 'user' as const },
})
const model = (picks: Record<string, string>, probability = 1): DecisionModelClient => ({
  evaluate: async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const options = Object.keys(question.criteria)
    const selected = picks[id] ?? options[0]!
    return [id, {
      type: 'choice' as const, choice: selected,
      probabilities: Object.fromEntries(options.map((key) =>
        [key, key === selected ? probability : (1 - probability) / (options.length - 1)])),
    }]
  })),
})

for (const content of ['Platí, použijeme PostgreSQL. Díky!', 'yep lets do it, thx', 'sí, decisión tomada']) {
  test(`acknowledgement and enum-selected background work coexist: ${content}`, async () => {
    const decisions = await decideChannelActions(model({
      engagement: 'acknowledge', agent: agent.id, reaction: 'r0', custom_decision: 'confirmed',
    }), input(content))
    assert.equal(decisions.length, 2)
    assert.deepEqual(decisions[0], { action: 'acknowledge', agentId: agent.id, emoji: '👍' })
    const run = decisions[1]!
    assert.equal(run.action, 'reply')
    if (run.action !== 'reply') throw new Error('Expected a follow-up run')
    assert.equal(run.background, true)
    assert.equal(run.policyWork, true)
    assert.match(run.promptOverride!, /Record the confirmed decision/)
    assert.match(run.promptOverride!, /conclude_silently/)
    assert.ok(run.promptOverride!.includes(content))
  })
}

test('custom options are a multi-valued enum and all questions share one request', async () => {
  let calls = 0
  const client: DecisionModelClient = { evaluate: async (request) => {
    calls++
    assert.deepEqual(Object.keys(request.questions.custom_decision!.criteria),
      ['proposed', 'confirmed', 'superseded', 'unrelated'])
    assert.ok(request.questions.engagement && request.questions.depth && request.questions.reaction)
    return model({ engagement: 'no_action', custom_decision: 'unrelated' }).evaluate(request)
  } }
  assert.deepEqual(await decideChannelActions(client, input('Maybe we could switch storage?')), [])
  assert.equal(calls, 1)
})

test('uncertain policy choices start no automatic work but keep explicit addressing', async () => {
  const decisions = await decideChannelActions(model({ custom_decision: 'confirmed' }, 0.2), {
    ...input('Archivist, explain our decision'),
    agentMentions: [{ agentId: agent.id }],
  })
  assert.equal(decisions.length, 1)
  const run = decisions[0]!
  assert.equal(run.action, 'reply')
  if (run.action !== 'reply') throw new Error('Expected addressed reply')
  assert.equal(run.background, undefined)
  assert.equal(run.policyWork, undefined)
  assert.doesNotMatch(run.promptOverride!, /Record the confirmed decision/)
})

test('a follow-up cannot name an unavailable agent or another principal', async () => {
  const decisions = await decideChannelActions(model({
    engagement: 'no_action', custom_decision: 'confirmed',
  }), { ...input('Agreed.'), agents: [{ ...agent, principalUserId: 'another-owner' }] })
  assert.deepEqual(decisions, [])
})

test('agent-authored messages never evaluate or trigger recursive work', async () => {
  const client: DecisionModelClient = { evaluate: async () => { throw new Error('Must not evaluate') } }
  assert.deepEqual(await decideChannelActions(client, { ...input('I updated the log.'), triggerIsHuman: false }), [])
})

test('reply depth is prompt guidance and policy work stays separate from a conversational reply', async () => {
  const decisions = await decideChannelActions(model({
    engagement: 'reply', agent: agent.id, depth: 'detailed', custom_decision: 'confirmed', placement: 'thread',
  }), input('Explain the decision thoroughly and record it.'))
  assert.equal(decisions.length, 2)
  const run = decisions[0]!
  if (run.action !== 'reply') throw new Error('Expected reply')
  assert.match(run.promptOverride!, /thorough answer/)
  assert.doesNotMatch(run.promptOverride!, /Record the confirmed decision/)
  assert.equal(run.background, undefined)
  assert.equal(run.policyWork, undefined)
  const work = decisions[1]!
  if (work.action !== 'reply') throw new Error('Expected background work')
  assert.equal(work.policyWork, true)
  assert.equal(work.background, true)
  assert.match(work.promptOverride!, /Record the confirmed decision/)
})
