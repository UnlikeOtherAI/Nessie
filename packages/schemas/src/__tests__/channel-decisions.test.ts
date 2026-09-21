import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ChannelDecisionPolicySchema, DEFAULT_CHANNEL_DECISION_POLICY, MAX_CHANNEL_DECISION_POLICY_BYTES,
} from '../channel-decisions.js'

const question = {
  id: 'decision_record',
  instructions: 'Má se toto rozhodnutí zapsat? Include informal or misspelled decisions.',
  options: [
    { id: 'leave', description: 'No lasting decision to record.' },
    { id: 'discuss', description: 'Still discussing; no agreement yet.' },
    { id: 'record', description: 'A lasting decision was made.', followUp: {
      agentId: '11111111-1111-4111-8111-111111111111',
      instructions: 'Record this decision in the project documentation.',
    } },
  ],
}

test('policies support named multi-option decisions with a safe no-action choice', () => {
  const parsed = ChannelDecisionPolicySchema.parse({ ...DEFAULT_CHANNEL_DECISION_POLICY, questions: [question] })
  assert.equal(parsed.questions[0]?.options.length, 3)
  assert.equal(parsed.questions[0]?.options[2]?.followUp?.instructions, question.options[2]?.followUp?.instructions)
  assert.equal(parsed.enabled, false)
})

test('a question cannot force a follow-up for every classification', () => {
  assert.equal(ChannelDecisionPolicySchema.safeParse({
    ...DEFAULT_CHANNEL_DECISION_POLICY,
    questions: [{ ...question, options: question.options.map((option) => ({
      ...option, followUp: question.options[2]!.followUp,
    })) }],
  }).success, false)
})

test('question IDs, option IDs and reaction enums must be unambiguous', () => {
  const invalidPolicies = [
    { questions: [question, question] },
    { questions: [{ ...question, options: [question.options[0], question.options[0]] }] },
    { reactions: [DEFAULT_CHANNEL_DECISION_POLICY.reactions[0], DEFAULT_CHANNEL_DECISION_POLICY.reactions[0]] },
  ]
  for (const invalid of invalidPolicies) {
    assert.equal(ChannelDecisionPolicySchema.safeParse({
      ...DEFAULT_CHANNEL_DECISION_POLICY, ...invalid,
    }).success, false)
  }
})

test('bounds refuse unbounded prompts, invalid probabilities, and single-option decisions', () => {
  const invalidPolicies = [
    { minimumProbability: -0.1 }, { minimumProbability: 1.1 },
    { instructions: 'x'.repeat(4001) },
    { questions: [{ ...question, options: [question.options[0]] }] },
    { questions: Array.from({ length: 9 }, (_, index) => ({ ...question, id: `q${index}` })) },
    { questions: [{ ...question, options: Array.from({ length: 17 }, (_, index) => ({
      id: `option${index}`, description: 'No action',
    })) }] },
  ]
  for (const invalid of invalidPolicies) {
    assert.equal(ChannelDecisionPolicySchema.safeParse({
      ...DEFAULT_CHANNEL_DECISION_POLICY, ...invalid,
    }).success, false)
  }
})

test('unknown action fields cannot become hidden capabilities', () => {
  assert.equal(ChannelDecisionPolicySchema.safeParse({
    ...DEFAULT_CHANNEL_DECISION_POLICY,
    questions: [{ ...question, options: [{ id: 'none', description: 'Skip' }, {
      id: 'archive', description: 'Archive', archiveChannel: true,
    }] }],
  }).success, false)
})

test('reaction choices are emojis and cannot impersonate the working marker', () => {
  for (const emoji of ['plain text', '👀', '👍 leaked text', '']) {
    assert.equal(ChannelDecisionPolicySchema.safeParse({
      ...DEFAULT_CHANNEL_DECISION_POLICY, reactions: [{ emoji, description: 'Acknowledged' }],
    }).success, false)
  }
  for (const emoji of ['👍🏽', '✅', '👩‍💻']) {
    assert.equal(ChannelDecisionPolicySchema.safeParse({
      ...DEFAULT_CHANNEL_DECISION_POLICY, reactions: [{ emoji, description: 'Acknowledged' }],
    }).success, true)
  }
})

test('the aggregate policy budget rejects individually valid guidance and options before saving', () => {
  const result = ChannelDecisionPolicySchema.safeParse({
    ...DEFAULT_CHANNEL_DECISION_POLICY,
    instructions: 'x'.repeat(4000),
    questions: Array.from({ length: 4 }, (_, index) => ({
      ...question, id: `decision${index}`, instructions: 'y'.repeat(3000),
    })),
  })
  assert.equal(result.success, false)
  if (!result.success) assert.match(result.error.message, /16,000 UTF-8 bytes.*Shorten its guidance or options/)
})

test('multilingual policy guidance is bounded by serialized UTF-8 bytes rather than character count', () => {
  const policy = (character: string) => ({
    ...DEFAULT_CHANNEL_DECISION_POLICY,
    instructions: character.repeat(3000),
    questions: [{ ...question, instructions: character.repeat(3000) }],
  })
  assert.equal(ChannelDecisionPolicySchema.safeParse(policy('a')).success, true)
  assert.equal(ChannelDecisionPolicySchema.safeParse(policy('ž')).success, true)
  const japanese = ChannelDecisionPolicySchema.safeParse(policy('決'))
  assert.equal(japanese.success, false)
  if (!japanese.success) assert.match(japanese.error.message, /UTF-8 bytes/)
})

test('the serialized policy may occupy exactly the budget, but no more', () => {
  const policy = {
    ...DEFAULT_CHANNEL_DECISION_POLICY, instructions: 'a'.repeat(4000), reactions: [],
    questions: [{ id: 'decision', instructions: 'b', options: Array.from({ length: 8 }, (_, index) => ({
      id: `option${index}`, description: 'c'.repeat(1000),
    })) }],
  }
  const bytes = new TextEncoder().encode(JSON.stringify(policy)).byteLength
  policy.questions[0]!.instructions += 'd'.repeat(MAX_CHANNEL_DECISION_POLICY_BYTES - bytes)
  assert.equal(new TextEncoder().encode(JSON.stringify(policy)).byteLength, MAX_CHANNEL_DECISION_POLICY_BYTES)
  assert.equal(ChannelDecisionPolicySchema.safeParse(policy).success, true)
  policy.questions[0]!.instructions += 'd'
  assert.equal(ChannelDecisionPolicySchema.safeParse(policy).success, false)
})
