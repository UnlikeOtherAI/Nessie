import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '@nessie/runtime'

import {
  estimateMessagesTokens,
  groupMessages,
  trimConversationToFit,
} from './context-management.js'
import { buildCheckpointNotePrompt } from './execute/checkpoint-note.js'
import { buildToolImagesMessage } from './tool-images.js'

/**
 * How the rest of the transcript machinery treats a tool-images turn: it is
 * glued to the batch that returned its pictures, it is counted for the images
 * it will actually carry, and a transcript rendered for a note calls it tool
 * output, never the person.
 */

const imagesTurn = (n: number): ProviderMessage => buildToolImagesMessage([{
  imageRefs: [{ attachmentId: `0b7c6a8e-3f1d-4c2a-9e5b-7d8f9a0b1c${String(n).padStart(2, '0')}`, byteLength: 13_715, mimeType: 'image/png' }],
  toolName: 'executor_mcp_call',
}])!

const batch = (n: number): ProviderMessage[] => [
  { content: null, role: 'assistant', toolCalls: [{ arguments: {}, toolCallId: `call-${n}`, toolName: 'executor_mcp_call' }] },
  { content: `result ${n}`, role: 'tool', toolCallId: `call-${n}` },
  imagesTurn(n),
]

test('a tool-images turn stays in the group of the batch that returned its pictures', () => {
  const groups = groupMessages([{ content: 'go', role: 'user' }, ...batch(1), { content: 'and?', role: 'user' }])
  assert.equal(groups.length, 3)
  assert.deepEqual(groups[1]!.map((message) => message.role), ['assistant', 'tool', 'user'])
  // Room for the newest batch and one more images turn: on its own, the older
  // images turn would survive the trim without the call it answers.
  const budget = estimateMessagesTokens(batch(2)) + estimateMessagesTokens([imagesTurn(1)])
  assert.deepEqual(trimConversationToFit([...batch(1), ...batch(2)], budget), batch(2))
})

test('only the tool-images turns still shown are counted for their pictures', () => {
  const turns = (count: number) => Array.from({ length: count }, (_, index) => imagesTurn(index + 1))
  const asText = (message: ProviderMessage): ProviderMessage => ({ content: message.content ?? '', role: 'user' })
  const imageTokens = (count: number) =>
    estimateMessagesTokens(turns(count)) - estimateMessagesTokens(turns(count).map(asText))
  assert.equal(imageTokens(1), 1_500)
  assert.equal(imageTokens(2), 3_000)
  assert.equal(imageTokens(5), 3_000, 'an older turn is sent as its placeholder')
})

test('a checkpoint note renders the turn as tool images, not as something the person said', () => {
  const prompt = buildCheckpointNotePrompt({ goal: 'evaluate example.com', messages: batch(1) })
  assert.match(prompt, /\[tool images\]\nImages returned by the tool calls above/)
  assert.doesNotMatch(prompt, /\[user\]/)
})
