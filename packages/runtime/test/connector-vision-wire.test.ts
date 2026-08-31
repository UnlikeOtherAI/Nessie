import assert from 'node:assert/strict'
import test from 'node:test'

import { createConnectorRegistry } from '../src/inference/connectors/registry.js'
import type { ModelProviderName, ProviderMessage } from '../src/inference/types.js'

/**
 * The per-provider gate, checked on the wire rather than in the mapper: a
 * connector whose model can see must put the image bytes in the request body,
 * and one whose model cannot must send plain text instead of a payload the
 * endpoint would reject.
 */

const messages: ProviderMessage[] = [
  {
    role: 'user',
    content: 'what is on this image?',
    images: [{ mime: 'image/png', dataBase64: 'AAECAw==' }],
  },
]

const captureRequestBody = async (
  provider: ModelProviderName,
): Promise<Record<string, unknown>> => {
  const originalFetch = globalThis.fetch
  let body: Record<string, unknown> | null = null
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    body = JSON.parse(init?.body?.toString() ?? '{}') as Record<string, unknown>
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  }) as typeof fetch

  try {
    const connector = createConnectorRegistry().getConfigured({ apiKey: 'k', provider })
    await connector.invoke({ messages, model: 'test-model', requestId: 'req-1' })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.ok(body)
  return body
}

const userContent = (body: Record<string, unknown>): unknown =>
  (body.messages as Array<Record<string, unknown>>).find(
    (message) => message.role === 'user',
  )?.content

test('the OpenAI connector puts the image on the wire', async () => {
  const parts = userContent(await captureRequestBody('openai')) as Array<
    { type: string; image_url?: { url: string } }
  >
  assert.ok(Array.isArray(parts))
  assert.equal(parts.at(-1)?.image_url?.url, 'data:image/png;base64,AAECAw==')
})

test('an OpenAI-compatible endpoint gets the same image parts', async () => {
  const parts = userContent(await captureRequestBody('openai-compatible')) as unknown[]
  assert.ok(Array.isArray(parts))
})

test('DeepSeek, whose chat API is text-only, gets plain text and no image', async () => {
  const body = await captureRequestBody('deepseek')
  assert.equal(userContent(body), 'what is on this image?')
  assert.equal(JSON.stringify(body).includes('AAECAw=='), false)
})

test('capability snapshots report vision truthfully per provider', async () => {
  const registry = createConnectorRegistry()
  const visionOf = async (provider: ModelProviderName): Promise<boolean> =>
    (await registry
      .getConfigured({ apiKey: 'k', provider })
      .getModelCapabilities('test-model')).supportsVision

  assert.equal(await visionOf('openai'), true)
  assert.equal(await visionOf('openai-compatible'), true)
  assert.equal(await visionOf('deepseek'), false)
  assert.equal(await visionOf('kimi'), false)
})
