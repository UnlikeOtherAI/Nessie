import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenAiLikeConnector } from '../src/inference/connectors/openai.js'

const withFetchStub = async (
  responder: (url: string, init: RequestInit | undefined) => Response,
  run: (calls: Array<{ url: string; body: unknown }>) => Promise<void>,
): Promise<void> => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString()
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url, body })
    return responder(url, init)
  }) as typeof fetch

  try {
    await run(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('embedBatch sorts embeddings by index and maps usage/model', async () => {
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0.2, 0.3] },
            { index: 0, embedding: [0.1, 0.1] },
          ],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 12, total_tokens: 12 },
        }),
        { status: 200 },
      ),
    async (calls) => {
      const connector = createOpenAiLikeConnector('openai', {
        apiKey: 'test-key',
        provider: 'openai',
      })

      const result = await connector.embedBatch!({
        input: ['a', 'b'],
        requestId: 'req-1',
      })

      assert.deepEqual(result.embeddings, [[0.1, 0.1], [0.2, 0.3]])
      assert.equal(result.invocation.operationType, 'embedding')
      assert.equal(result.invocation.model, 'text-embedding-3-small')
      assert.equal(result.invocation.usage.inputTokens, 12)
      assert.equal(calls.length, 1)
      assert.deepEqual((calls[0]!.body as { input: string[] }).input, ['a', 'b'])
    },
  )
})

test('embedBatch truncates each input to 8000 chars before sending', async () => {
  const longText = 'x'.repeat(9000)
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }),
        { status: 200 },
      ),
    async (calls) => {
      const connector = createOpenAiLikeConnector('openai', {
        apiKey: 'test-key',
        provider: 'openai',
      })

      await connector.embedBatch!({ input: [longText], requestId: 'req-2' })

      const sentInput = (calls[0]!.body as { input: string[] }).input
      assert.equal(sentInput[0]!.length, 8000)
    },
  )
})

test('embedBatch throws when the provider returns a different embedding count', async () => {
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }),
        { status: 200 },
      ),
    async () => {
      const connector = createOpenAiLikeConnector('openai', {
        apiKey: 'test-key',
        provider: 'openai',
      })

      await assert.rejects(
        connector.embedBatch!({ input: ['a', 'b'], requestId: 'req-3' }),
      )
    },
  )
})
