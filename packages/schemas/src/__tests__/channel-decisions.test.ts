import assert from 'node:assert/strict'
import test from 'node:test'
import { ChannelDecisionPolicySchema, DEFAULT_CHANNEL_DECISION_POLICY } from '../channel-decisions.js'

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
