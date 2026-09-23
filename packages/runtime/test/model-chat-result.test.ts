import assert from 'node:assert/strict'
import test from 'node:test'

import { createModelClient } from '../src/model.js'

/**
 * An empty answer is not one fact. A reasoning model that spent its whole
 * output allowance thinking comes back with no text and `length`; the portrait
 * prompt writer met exactly that and could only say "could not be generated".
 * `chatResult` carries the reason beside the text so a caller can say which.
 */

const withResponse = async (
  body: Record<string, unknown>,
  run: (client: ReturnType<typeof createModelClient>) => Promise<void>,
): Promise<Array<Record<string, unknown>>> => {
  const bodies: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(JSON.stringify(body))
  }) as typeof fetch
  const client = createModelClient({
    apiKey: 'k',
    baseUrl: 'https://example.test/v1',
    modelName: 'gpt-5-mini',
    provider: 'openai',
  })
  try {
    await run(client)
  } finally {
    globalThis.fetch = originalFetch
    client.close()
  }
  return bodies
}

const completion = (content: string | null, finishReason: string) => ({
  choices: [{ finish_reason: finishReason, message: { content } }],
  model: 'gpt-5-mini',
  usage: { completion_tokens: 2_000, prompt_tokens: 20, total_tokens: 2_020 },
})

test('an answer that ran out of budget says so beside its empty text', async () => {
  await withResponse(completion(null, 'length'), async (client) => {
    const result = await client.chatResult([{ role: 'user', content: 'Describe a portrait.' }])
    assert.equal(result.text, '')
    assert.equal(result.finishReason, 'length')
  })
})

test('chat is chatResult\'s text, unchanged for every existing caller', async () => {
  const bodies = await withResponse(completion('a portrait prompt', 'stop'), async (client) => {
    assert.equal(await client.chat([{ role: 'user', content: 'hi' }]), 'a portrait prompt')
    const result = await client.chatResult(
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 2_000, reasoningEffort: 'low' },
    )
    assert.deepEqual(result, { finishReason: 'stop', text: 'a portrait prompt' })
  })
  // The options still reach the wire through the one shared path.
  assert.equal(bodies[1]?.reasoning_effort, 'low')
})
