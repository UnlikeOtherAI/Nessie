import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CHANNEL_DECISION_POLICY, type ChannelDecisionChoice, type ChannelDecisionPolicy } from '@nessie/schemas'
import { decideChannelActions, POLICY_WORK_QUIET_MARK } from '../src/channel-decisions.js'
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

/**
 * How background work ends when it has nothing to report, as the run is told.
 * It names a mark the worker really suppresses (`concludesQuietly`), not a
 * tool: `conclude_silently` was removed, and a run told to call a tool it does
 * not have improvises instead. Not silence either — an empty answer is what a
 * failed provider looks like, and the agent loop asks again.
 */
const QUIET_END = 'This is background work. Complete the configured work. When nothing about it needs '
  + 'to reach anyone, answer with just ✅ and nothing else: that answer is not posted. Write a failure, '
  + 'a result someone needs, or an action required of them in words.'

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
    assert.ok(run.promptOverride!.includes(QUIET_END))
    assert.ok(run.promptOverride!.includes(content))
  })
}

test('background work is told to end with the bare mark, never a tool it does not have', async () => {
  const decisions = await decideChannelActions(model({
    engagement: 'no_action', agent: 'none', custom_decision: 'confirmed',
  }), input('Platí, jdeme na PostgreSQL.'))
  assert.equal(decisions.length, 1)
  const work = decisions[0]!
  if (work.action !== 'reply') throw new Error('Expected background work')
  assert.equal(work.background, true)
  assert.equal(POLICY_WORK_QUIET_MARK, '✅')
  assert.ok(work.promptOverride!.includes(QUIET_END), work.promptOverride)
  assert.doesNotMatch(work.promptOverride!, /conclude_silently/)
})

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
  let choices: ChannelDecisionChoice[] = []
  const decisions = await decideChannelActions(model({ custom_decision: 'confirmed' }, 0.2), {
    ...input('Archivist, explain our decision'),
    agentMentions: [{ agentId: agent.id }],
    onEvaluated: (result) => { choices = result },
  })
  assert.equal(decisions.length, 1)
  const run = decisions[0]!
  assert.equal(run.action, 'reply')
  if (run.action !== 'reply') throw new Error('Expected addressed reply')
  assert.equal(run.background, undefined)
  assert.equal(run.policyWork, undefined)
  assert.doesNotMatch(run.promptOverride!, /Record the confirmed decision/)
  assert.deepEqual(choices.find((choice) => choice.questionId === 'custom_decision'), {
    questionId: 'custom_decision', choice: 'confirmed', probability: 0.2, meetsThreshold: false,
  })
})

test('a confident reply request with an uncertain recipient records its abstention', async () => {
  let choices: ChannelDecisionChoice[] = []
  const client: DecisionModelClient = { evaluate: async (request) => {
    const answers = await model({ engagement: 'reply', agent: agent.id, custom_decision: 'unrelated' }).evaluate(request)
    answers.agent = { type: 'choice', choice: agent.id, probabilities: { [agent.id]: 0.55, none: 0.45 } }
    return answers
  } }
  const decisions = await decideChannelActions(client, {
    ...input('¿alguien puede explicar esto?'), onEvaluated: (result) => { choices = result },
  })
  assert.deepEqual(decisions, [])
  assert.equal(choices.find((choice) => choice.questionId === 'engagement')?.meetsThreshold, true)
  assert.deepEqual(choices.find((choice) => choice.questionId === 'agent'), {
    questionId: 'agent', choice: agent.id, probability: 0.55, meetsThreshold: false,
  })
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
  // A conversational reply owes the person an answer: it is never offered the quiet end.
  assert.ok(!run.promptOverride!.includes(QUIET_END))
  assert.equal(run.background, undefined)
  assert.equal(run.policyWork, undefined)
  const work = decisions[1]!
  if (work.action !== 'reply') throw new Error('Expected background work')
  assert.equal(work.policyWork, true)
  assert.equal(work.background, true)
  assert.match(work.promptOverride!, /Record the confirmed decision/)
})
