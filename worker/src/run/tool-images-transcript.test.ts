import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '@nessie/runtime'

import { runContextCompaction } from './context-compaction.js'
import {
  estimateMessagesTokens,
  estimateShownToolImageTokens,
  estimateTokens,
  groupMessages,
  trimConversationToFit,
} from './context-management.js'
import { buildCheckpointNotePrompt } from './execute/checkpoint-note.js'
import { buildToolImagesMessage, isToolImagesMessage } from './tool-images.js'

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

const batch = (n: number, result = `result ${n}`): ProviderMessage[] => [
  { content: null, role: 'assistant', toolCalls: [{ arguments: {}, toolCallId: `call-${n}`, toolName: 'executor_mcp_call' }] },
  { content: result, role: 'tool', toolCallId: `call-${n}` },
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
  // A full-page screenshot is priced as measured on the production model.
  assert.equal(imageTokens(1), 2_300)
  assert.equal(imageTokens(2), 4_600)
  assert.equal(imageTokens(5), 4_600, 'an older turn is sent as its placeholder')
  assert.equal(estimateShownToolImageTokens(turns(5)), 4_600)
})

// A run that has taken two screenshots and is about to answer.
const screenshotRun = (): ProviderMessage[] => [
  { content: 'You are an agent.', role: 'system' },
  { content: 'Evaluate example.com.', role: 'user' },
  ...batch(1, 'x'.repeat(8_000)),
  ...batch(2, 'y'.repeat(2_000)),
  { content: 'Both pages are loaded.', role: 'assistant' },
]

const NOTE = '## State\nexample.com renders\n\n## Sources\n- none'
const compact = (messages: ProviderMessage[], targetTokens: number) =>
  runContextCompaction({ generateNote: async () => NOTE, messages, targetTokens })

// @deep/agent's own slice reserves this much for the note it is about to write.
const NOTE_RESERVE_TOKENS = 1_200

test('compaction prices the pictures still shown into the tail it keeps', async () => {
  const messages = screenshotRun()
  // Room for the second batch, its images turn and the answer — as text. With
  // its picture that tail is 2 300 tokens over, and it must not be kept.
  const tailAsText = estimateTokens('y'.repeat(2_000)) + 200
  const targetTokens = NOTE_RESERVE_TOKENS + tailAsText + 20
  const compacted = await compact(messages, targetTokens)
  assert.ok(compacted)
  assert.ok(
    estimateMessagesTokens(compacted) <= targetTokens,
    `${estimateMessagesTokens(compacted)} tokens kept for a ${targetTokens}-token target`,
  )
})

test('a compacted tail never opens with a tool-images turn whose calls went into the note', async () => {
  const messages = screenshotRun()
  // Wide enough, after the pictures, for the answer and the second images
  // turn's text, and not for the batch before it: the shared slice would keep
  // that turn with nothing above it.
  const targetTokens = estimateShownToolImageTokens(messages) + NOTE_RESERVE_TOKENS + 80
  const compacted = await compact(messages, targetTokens)
  assert.ok(compacted)
  for (const [index, message] of compacted.entries()) {
    if (isToolImagesMessage(message)) {
      assert.equal(compacted[index - 1]?.role, 'tool', 'a tool-images turn follows the results it carries')
    }
  }
  assert.equal(compacted.some((message) => isToolImagesMessage(message)), false)
  assert.equal(compacted.at(-1)?.content, 'Both pages are loaded.')
})

test('a checkpoint note renders the turn as tool images, not as something the person said', () => {
  const prompt = buildCheckpointNotePrompt({ goal: 'evaluate example.com', messages: batch(1) })
  assert.match(prompt, /\[tool images\]\nImages returned by the tool calls above/)
  assert.doesNotMatch(prompt, /\[user\]/)
})
