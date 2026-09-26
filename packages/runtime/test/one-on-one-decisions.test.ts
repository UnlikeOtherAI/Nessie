import assert from 'node:assert/strict'
import test from 'node:test'

import type { DecisionModelClient } from '../src/decision-model.js'
import {
  judgeOneOnOneTurn,
  OFFER_ANSWER_MINIMUM_PROBABILITY,
  ONE_ON_ONE_MINIMUM_PROBABILITY,
} from '../src/one-on-one-decisions.js'

/**
 * Jev is a stub here: the unit under test is the question it is asked and what
 * each answer becomes. Inputs are Czech, slang and misspelled on purpose — the
 * code never reads them, and a test that only passed in English would say so.
 */

const usage = { organizationId: 'org', requestId: 'message-1' }
const agent = { name: 'Ledger Clerk', role: 'bookkeeper', systemPrompt: 'Keeps the books tidy.' }
const earlier = [
  { id: 'e1', author: 'person' as const, content: 'rozpočet na Q4 je 42k, nezapomeň' },
  { id: 'e2', author: 'agent' as const, content: 'Noted: the Q4 budget is 42k.' },
]

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

const judge = (client: DecisionModelClient, content: string, candidates = earlier) =>
  judgeOneOnOneTurn(client, {
    agent, content, earlierMessages: candidates, recentMessages: [], timeoutMs: 1_500, usage,
  })

test('Jev is asked about the reply, the reaction, and which earlier message — nothing about engagement', async () => {
  const { client, seen } = stub({ response: ['reply', 0.9] })
  await judge(client, 'kolik ze to bylo?? budget')

  const asked = seen[0]!
  assert.deepEqual(Object.keys(asked.questions), ['response', 'reaction', 'earlier', 'reference'])
  assert.deepEqual(Object.keys(asked.questions.response!.criteria), ['reply', 'act', 'acknowledge'])
  assert.deepEqual(Object.keys(asked.questions.earlier!.criteria), ['none', 'm1', 'm2'])
  assert.equal(asked.questions.earlier!.criteria.m1, 'The person: rozpočet na Q4 je 42k, nezapomeň')
  assert.equal(asked.questions.earlier!.criteria.m2, 'The agent: Noted: the Q4 budget is 42k.')
  assert.deepEqual(Object.keys(asked.questions.reference!.criteria), ['mention', 'link', 'thread'])
  assert.equal(asked.state.latest_message, 'kolik ze to bylo?? budget')
  // The caller's patience travels with the request.
  assert.equal(asked.timeoutMs, 1_500)
})

test('without earlier messages there is nothing to go back to, so it is not asked', async () => {
  const { client, seen } = stub({ response: ['reply', 0.9] })
  const result = await judge(client, 'a dál?', [])

  assert.deepEqual(Object.keys(seen[0]!.questions), ['response', 'reaction'])
  assert.deepEqual(result.judgement, { shape: 'reply' })
})

test('a long earlier message is offered as a bounded excerpt', async () => {
  const { client, seen } = stub({})
  await judge(client, 'hm', [{ id: 'e1', author: 'person', content: 'x'.repeat(1_000) }])

  const option = seen[0]!.questions.earlier!.criteria.m1!
  assert.ok(option.length < 320)
  assert.ok(option.endsWith('[excerpt]'))
})

test('a confident pick of an earlier message carries how to point at it', async () => {
  const { client } = stub({ response: ['reply', 0.95], earlier: ['m1', 0.9], reference: ['link', 0.85] })
  const result = await judge(client, 'kolik ze to bylo?? budget')

  assert.deepEqual(result.judgement, { shape: 'reply', earlier: { messageId: 'e1', reference: 'link' } })
})

test('work and an earlier message are independent answers', async () => {
  const { client } = stub({ response: ['act', 0.9], earlier: ['m2', 0.9], reference: ['thread', 0.9] })
  const result = await judge(client, 'tak to zaúčtuj jak jsme se bavili')

  assert.deepEqual(result.judgement, { shape: 'act', earlier: { messageId: 'e2', reference: 'thread' } })
})

test('the threshold is inclusive and every uncertain choice falls back', async () => {
  const atThreshold = stub({
    response: ['acknowledge', ONE_ON_ONE_MINIMUM_PROBABILITY],
    reaction: ['celebrate', ONE_ON_ONE_MINIMUM_PROBABILITY],
  })
  assert.deepEqual((await judge(atThreshold.client, 'we shipped it 🎉')).judgement, {
    shape: 'acknowledge', emoji: '🎉',
  })

  const unsure = stub({
    response: ['acknowledge', 0.79],
    earlier: ['m1', 0.79],
    reference: ['thread', 0.99],
  })
  // An unsure acknowledgement is an answer, and an unsure earlier pick is none.
  assert.deepEqual((await judge(unsure.client, 'jj')).judgement, { shape: 'reply' })
})

test('an earlier pick with an unsure reference is mentioned in words', async () => {
  const { client } = stub({ response: ['reply', 0.9], earlier: ['m1', 0.9], reference: ['thread', 0.5] })
  assert.deepEqual((await judge(client, 'the budget thing')).judgement, {
    shape: 'reply', earlier: { messageId: 'e1', reference: 'mention' },
  })
})

test('choosing none is not going back', async () => {
  const { client } = stub({ response: ['reply', 0.9], earlier: ['none', 0.95], reference: ['thread', 0.95] })
  assert.deepEqual((await judge(client, 'ok and next?')).judgement, { shape: 'reply' })
})

test('every question comes back with its probability and whether it cleared the bar', async () => {
  const { client } = stub({ response: ['reply', 0.9], earlier: ['m1', 0.4] })
  const { choices } = await judge(client, 'hm')

  assert.deepEqual(choices.map(({ questionId, choice, meetsThreshold }) => [questionId, choice, meetsThreshold]), [
    ['response', 'reply', true],
    ['reaction', 'agree', false],
    ['earlier', 'm1', false],
    ['reference', 'mention', false],
  ])
})

const offer = {
  text: 'Book the Aquarium room\nWhich slot?\nButtons: Thu 10:00, Fri 14:00',
  options: [
    { key: 'thursday', label: 'Thu 10:00', does: 'runs room_book with {"day":"thursday"}' },
    { key: 'none', label: 'Neither', does: 'runs room_release with {}' },
  ],
}

const answer = (client: DecisionModelClient, content: string) =>
  judgeOneOnOneTurn(client, {
    agent, content, earlierMessages: [], offer, recentMessages: [], timeoutMs: 1_500, usage,
  })

test('an offered card adds which button, and whether it was taken as offered', async () => {
  const { client, seen } = stub({ response: ['reply', 0.9] })
  await answer(client, 'jo ten čtvrtek')

  const asked = seen[0]!
  // A button keyed "none" can never pass for the refusal.
  assert.deepEqual(Object.keys(asked.questions.offer_answer!.criteria), ['none', 'b_thursday', 'b_none'])
  assert.equal(asked.questions.offer_answer!.criteria.b_thursday, 'Thu 10:00: runs room_book with {"day":"thursday"}')
  assert.deepEqual(Object.keys(asked.questions.offer_exact!.criteria), ['exact', 'changed'])
  assert.equal(asked.state.offered_card, offer.text)
})

test('only a sure button taken exactly as offered answers the card', async () => {
  const sure = await answer(stub({
    response: ['acknowledge', 0.9], offer_answer: ['b_thursday', OFFER_ANSWER_MINIMUM_PROBABILITY],
    offer_exact: ['exact', 0.97],
  }).client, 'jj čtvrtek bere')
  assert.equal(sure.offerAnswer, 'thursday')

  for (const answers of [
    { offer_answer: ['b_thursday', 0.9], offer_exact: ['exact', 0.99] },
    { offer_answer: ['b_thursday', 0.99], offer_exact: ['changed', 0.99] },
    { offer_answer: ['b_thursday', 0.99], offer_exact: ['exact', 0.9] },
    { offer_answer: ['none', 0.99], offer_exact: ['exact', 0.99] },
  ] as const) {
    const judged = await answer(stub({ response: ['reply', 0.9], ...answers }).client, 'čtvrtek ale ve 3?')
    assert.equal(judged.offerAnswer, undefined, JSON.stringify(answers))
  }
})

test('without an offer nothing about cards is asked', async () => {
  const { client, seen } = stub({ response: ['reply', 0.9] })
  const judged = await judge(client, 'a co dál?', [])
  assert.equal(seen[0]!.questions.offer_answer, undefined)
  assert.equal(judged.offerAnswer, undefined)
})
