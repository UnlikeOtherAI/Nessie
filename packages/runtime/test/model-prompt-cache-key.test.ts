import assert from 'node:assert/strict'
import test from 'node:test'

import { createModelClient } from '../src/model.js'

const MODEL_RESPONSE = {
  choices: [
    {
      finish_reason: 'stop',
      message: { content: 'ok' },
    },
  ],
  model: 'gpt-5-mini',
  usage: {
    completion_tokens: 1,
    prompt_tokens: 2,
    total_tokens: 3,
  },
}

const withCapturedBodies = async (
  run: (
    chat: ReturnType<typeof createModelClient>['chat'],
  ) => Promise<void>,
): Promise<Array<Record<string, unknown>>> => {
  const bodies: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(JSON.stringify(MODEL_RESPONSE))
  }) as typeof fetch
  const client = createModelClient({
    apiKey: 'k',
    baseUrl: 'https://example.test/v1',
    modelName: 'gpt-5-mini',
    provider: 'openai',
  })
  try {
    await run(client.chat)
  } finally {
    globalThis.fetch = originalFetch
    client.close()
  }
  return bodies
}

test('a system-led call gets a default prompt_cache_key, stable across user-turn variance', async () => {
  const bodies = await withCapturedBodies(async (chat) => {
    await chat([
      { role: 'system', content: 'Decide whether the agent should engage.' },
      { role: 'user', content: 'first message' },
    ])
    await chat([
      { role: 'system', content: 'Decide whether the agent should engage.' },
      { role: 'user', content: 'a completely different message' },
    ])
    await chat([
      { role: 'system', content: 'A different system prompt.' },
      { role: 'user', content: 'first message' },
    ])
  })
  const [a, b, c] = bodies
  assert.equal(typeof a?.prompt_cache_key, 'string')
  assert.equal(a?.prompt_cache_key, b?.prompt_cache_key)
  assert.notEqual(c?.prompt_cache_key, a?.prompt_cache_key)
})

test('an explicit caller key wins; a user-led call derives none', async () => {
  const bodies = await withCapturedBodies(async (chat) => {
    await chat(
      [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hi' },
      ],
      { promptCacheKey: 'pinned-key' },
    )
    await chat([{ role: 'user', content: 'no system prefix here' }])
  })
  assert.equal(bodies[0]?.prompt_cache_key, 'pinned-key')
  assert.equal(bodies[1]?.prompt_cache_key, undefined)
})
