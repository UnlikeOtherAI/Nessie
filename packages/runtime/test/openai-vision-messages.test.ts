import assert from 'node:assert/strict'
import test from 'node:test'

import { mapMessagesToOpenAi } from '../src/inference/connectors/openai-chat-protocol.js'
import type { ProviderMessage } from '../src/inference/types.js'

const withImage: ProviderMessage[] = [
  { role: 'system', content: 'You are Nessie.' },
  {
    role: 'user',
    content: 'what is on this image?',
    images: [{ mime: 'image/png', dataBase64: 'AAECAw==' }],
  },
]

type OpenAiPart = { type: string; text?: string; image_url?: { url: string } }

const userContent = (mapped: Array<Record<string, unknown>>): unknown =>
  mapped.find((message) => message.role === 'user')?.content

test('a vision-capable model gets the image as an inline data-URI part', () => {
  const parts = userContent(mapMessagesToOpenAi(withImage, { vision: true })) as OpenAiPart[]
  assert.ok(Array.isArray(parts))
  assert.deepEqual(parts[0], { text: 'what is on this image?', type: 'text' })
  assert.equal(parts[1]?.type, 'image_url')
  assert.equal(parts[1]?.image_url?.url, 'data:image/png;base64,AAECAw==')
})

test('an image-only turn sends the image with no empty text part', () => {
  const parts = userContent(
    mapMessagesToOpenAi(
      [{ role: 'user', content: '', images: [{ mime: 'image/jpeg', dataBase64: 'Zm8=' }] }],
      { vision: true },
    ),
  ) as OpenAiPart[]
  assert.equal(parts.length, 1)
  assert.equal(parts[0]?.type, 'image_url')
})

test('a text-only model keeps plain string content and never sees the image field', () => {
  const mapped = mapMessagesToOpenAi(withImage)
  assert.equal(userContent(mapped), 'what is on this image?')
  for (const message of mapped) {
    assert.equal('images' in message, false)
  }
})

test('a user turn without images stays a plain string even for a vision model', () => {
  const mapped = mapMessagesToOpenAi([{ role: 'user', content: 'hi' }], { vision: true })
  assert.equal(userContent(mapped), 'hi')
})

test('system, assistant, and tool turns are unaffected by the vision flag', () => {
  const mapped = mapMessagesToOpenAi(
    [
      { role: 'system', content: 'rules' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ toolCallId: 'call_1', toolName: 'ping', arguments: { a: 1 } }],
      },
      { role: 'tool', content: 'pong', toolCallId: 'call_1' },
    ],
    { vision: true },
  )
  assert.deepEqual(mapped[0], { content: 'rules', role: 'system' })
  assert.equal(mapped[1]?.content, '')
  assert.deepEqual(mapped[2], { content: 'pong', role: 'tool', tool_call_id: 'call_1' })
})
