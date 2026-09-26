import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '../src/inference/types.js'
import {
  COMPLETION_MINIMUM_PROBABILITY,
  completionDigest,
  judgeAnswerComplete,
  judgeWatchDisposition,
  type RunDecisionEvaluator,
} from '../src/run-decisions.js'

/**
 * Jev is a stub: these pin the evidence a run's judgements are asked over and
 * the rule that only a sure answer replaces the generative judge.
 */

const answering = (answers: Record<string, [string, number]>) => {
  const seen: Array<Parameters<RunDecisionEvaluator>[0]> = []
  const evaluate: RunDecisionEvaluator = async (input) => {
    seen.push(input)
    return Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
      const [choice, probability] = answers[id] ?? [Object.keys(question.criteria)[0]!, 0.3]
      return [id, { type: 'choice' as const, choice, probabilities: { [choice]: probability } }]
    }))
  }
  return { evaluate, seen }
}

const transcript: ProviderMessage[] = [
  { role: 'system', content: 'You are Ledger Clerk. '.repeat(400) },
  { role: 'user', content: 'mám tu dvě faktury od Alzy' },
  { role: 'assistant', content: 'Mám je zaúčtovat?' },
  { role: 'user', content: 'jo, obě, díky' },
  {
    role: 'assistant', content: null,
    toolCalls: [
      { toolCallId: 'c1', toolName: 'ledger_post', arguments: { invoice: 'A-1' } },
      { toolCallId: 'c2', toolName: 'ledger_post', arguments: { invoice: 'A-2' } },
    ],
  },
  { role: 'tool', toolCallId: 'c1', content: '{"posted":true}' },
  { role: 'tool', toolCallId: 'c2', content: '{"posted":false,"error":"duplicate"}' },
  { role: 'system', content: 'loop instruction' },
]

test('the completion digest carries the request, its lead-in, the work and the answer — not the system prompt', () => {
  const digest = completionDigest(transcript, 'Hotovo, obě zaúčtované.')

  assert.equal(digest.latest_request, 'jo, obě, díky')
  assert.deepEqual(digest.conversation_before_it, [
    { role: 'user', content: 'mám tu dvě faktury od Alzy' },
    { role: 'assistant', content: 'Mám je zaúčtovat?' },
  ])
  assert.deepEqual(digest.work_this_turn, [
    { tool: 'ledger_post', arguments: '{"invoice":"A-1"}', result: '{"posted":true}' },
    { tool: 'ledger_post', arguments: '{"invoice":"A-2"}', result: '{"posted":false,"error":"duplicate"}' },
  ])
  assert.equal(digest.proposed_answer, 'Hotovo, obě zaúčtované.')
  assert.ok(!JSON.stringify(digest).includes('You are Ledger Clerk'))
})

test('a long turn keeps its latest work inside Jev\'s input limit and says how much it left out', () => {
  const long: ProviderMessage[] = [{ role: 'user', content: 'projdi všechno' }]
  for (let index = 0; index < 60; index += 1) {
    long.push({
      role: 'assistant', content: null,
      toolCalls: [{ toolCallId: `c${index}`, toolName: 'read_file', arguments: { index } }],
    })
    long.push({ role: 'tool', toolCallId: `c${index}`, content: 'y'.repeat(2_000) })
  }
  const digest = completionDigest(long, 'Hotovo.')
  const steps = digest.work_this_turn as Array<{ arguments: string }>

  assert.ok(Buffer.byteLength(JSON.stringify(digest), 'utf8') <= 18_000)
  assert.ok(steps.length > 0 && steps.length < 60)
  assert.equal(steps.at(-1)!.arguments, '{"index":59}')
  assert.equal(digest.earlier_work_steps_omitted, 60 - steps.length)
})

test('only a sure "complete" skips the generative review', async () => {
  const sure = answering({ completion: ['complete', COMPLETION_MINIMUM_PROBABILITY] })
  assert.equal(await judgeAnswerComplete(sure.evaluate, transcript, 'Hotovo.'), true)
  assert.deepEqual(Object.keys(sure.seen[0]!.questions.completion!.criteria), ['complete', 'unfinished'])

  const unsure = answering({ completion: ['complete', 0.85] })
  assert.equal(await judgeAnswerComplete(unsure.evaluate, transcript, 'Hotovo.'), null)
  // Even a sure "unfinished" goes to the generative review: its reason is what the run is told.
  const unfinished = answering({ completion: ['unfinished', 0.99] })
  assert.equal(await judgeAnswerComplete(unfinished.evaluate, transcript, 'Hned to udělám.'), null)
  const failing: RunDecisionEvaluator = async () => { throw new Error('timeout') }
  assert.equal(await judgeAnswerComplete(failing, transcript, 'Hotovo.'), null)
})

test('a watch disposition is Jev\'s only when it is sure', async () => {
  const quiet = answering({ disposition: ['status', 0.9] })
  assert.equal(await judgeWatchDisposition(quiet.evaluate, 'Vše v pořádku, beze změn.'), 'status')
  assert.deepEqual(Object.keys(quiet.seen[0]!.questions.disposition!.criteria), ['post', 'status'])

  const finding = answering({ disposition: ['post', 0.95] })
  assert.equal(await judgeWatchDisposition(finding.evaluate, 'Disk je na 97 %!'), 'post')
  const unsure = answering({ disposition: ['status', 0.6] })
  assert.equal(await judgeWatchDisposition(unsure.evaluate, 'asi ok?'), null)
  const failing: RunDecisionEvaluator = async () => { throw new Error('timeout') }
  assert.equal(await judgeWatchDisposition(failing, 'cokoli'), null)
})
