import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '@nessie/runtime'
import {
  buildCompactionPrompt,
  COMPACTION_NOTE_MARKER,
  runContextCompaction,
  selectCompactionSlice,
} from './context-compaction.js'
import { contextWindowForModel, buildContextPlan } from './context-window.js'

const toolGroup = (id: string, size: number): ProviderMessage[] => [
  {
    content: null,
    role: 'assistant',
    toolCalls: [{ arguments: { q: id }, toolCallId: id, toolName: 'web_search' }],
  },
  { content: 'x'.repeat(size), role: 'tool', toolCallId: id },
]

const conversation = (): ProviderMessage[] => [
  { content: 'You are an agent.', role: 'system' },
  { content: 'Research slack clones.', role: 'user' },
  ...toolGroup('call-1', 8_000),
  ...toolGroup('call-2', 8_000),
  ...toolGroup('call-3', 400),
  { content: 'Still working.', role: 'assistant' },
]

test('compaction never splits an assistant tool-call group', () => {
  const slice = selectCompactionSlice(conversation(), 1_200)
  assert.ok(slice, 'expected an elder slice')

  for (const part of [slice.elder, slice.tail]) {
    for (const [index, message] of part.entries()) {
      if (message.role !== 'tool') continue
      const previous = part[index - 1]
      assert.ok(previous, 'a tool result must never lead its part')
      const owner = previous.role === 'assistant'
        ? previous.toolCalls?.some((tc) => tc.toolCallId === message.toolCallId)
        : previous.role === 'tool'
      assert.ok(owner, 'a tool result must stay with the call that produced it')
    }
  }
})

test('the system prompt is preserved and the most recent turn is always kept', () => {
  const slice = selectCompactionSlice(conversation(), 1_200)
  assert.ok(slice)
  assert.deepEqual(slice.system, [{ content: 'You are an agent.', role: 'system' }])
  assert.equal(slice.tail.at(-1)?.content, 'Still working.')
  assert.ok(slice.elder.length > 0)
})

test('nothing to compact returns null so the caller can skip the model call', () => {
  const short: ProviderMessage[] = [
    { content: 'You are an agent.', role: 'system' },
    { content: 'hi', role: 'user' },
  ]
  assert.equal(selectCompactionSlice(short, 100_000), null)
})

test('the compaction prompt demands verbatim source URLs in their own section', () => {
  const prompt = buildCompactionPrompt({ elder: conversation(), previousNote: null })
  assert.match(prompt, /## Sources/)
  assert.match(prompt, /COPIED VERBATIM/)
  assert.match(prompt, /Never shorten, normalize, guess, or invent a URL/)
})

test('a previous note is folded into the next compaction instead of being dropped', async () => {
  let seenPrompt = ''
  const first = await runContextCompaction({
    generateNote: async () => '## State\nfound two candidates\n\n## Sources\n- https://example.com/a — A',
    messages: conversation(),
    targetTokens: 1_200,
  })
  assert.ok(first)
  const note = first.find((message) => (message.content ?? '').startsWith(COMPACTION_NOTE_MARKER))
  assert.ok(note, 'expected the rolling note in the rebuilt conversation')
  // Verbatim URLs survive into the rebuilt context.
  assert.match(note.content ?? '', /https:\/\/example\.com\/a/)
  assert.match(note.content ?? '', /untrusted/i)

  const second = await runContextCompaction({
    generateNote: async (prompt) => {
      seenPrompt = prompt
      return '## State\nstill working\n\n## Sources\n- https://example.com/a — A'
    },
    messages: [...first, ...toolGroup('call-4', 8_000), { content: 'more', role: 'user' }],
    targetTokens: 1_200,
  })
  assert.ok(second)
  assert.match(seenPrompt, /previous compaction/)
  assert.match(seenPrompt, /https:\/\/example\.com\/a/)
  // Exactly one rolling note survives; the old one is folded in, not stacked.
  assert.equal(
    second.filter((message) => (message.content ?? '').startsWith(COMPACTION_NOTE_MARKER)).length,
    1,
  )
})

test('a failed note call leaves the caller to fall back', async () => {
  const result = await runContextCompaction({
    generateNote: async () => '   ',
    messages: conversation(),
    targetTokens: 1_200,
  })
  assert.equal(result, null)
})

test('context windows are per model with a conservative default', () => {
  assert.equal(contextWindowForModel('gpt-5-mini'), 400_000)
  assert.equal(contextWindowForModel('gpt-4o-mini'), 128_000)
  assert.equal(contextWindowForModel('some-custom-model'), 100_000)
  assert.equal(contextWindowForModel(null), 100_000)

  const plan = buildContextPlan({ model: 'gpt-5-mini', toolSchemaTokens: 0 })
  // Trigger at 80% of the (safety-discounted) window, rebuild target at 60%.
  assert.equal(plan.triggerTokens, Math.floor(plan.availableTokens * 0.8))
  assert.equal(plan.targetTokens, Math.floor(plan.availableTokens * 0.6))
  assert.ok(plan.availableTokens < 400_000, 'estimator headroom must be reserved')
})
