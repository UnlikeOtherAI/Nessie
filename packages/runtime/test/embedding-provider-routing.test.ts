import assert from 'node:assert/strict'
import test from 'node:test'

import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import {
  isSameInferenceHost,
  resolveEmbeddingProvider,
} from '../src/inference/embedding-provider.js'
import { createModelClient } from '../src/model.js'
import type { ModelProviderConfig } from '../src/inference/types.js'

// The deployment shape this exists for: chat on Ledger's DeepSeek adapter,
// which serves no embeddings endpoint at all.
const LEDGER_DEEPSEEK_CHAT: ModelProviderConfig = {
  apiKey: 'lk_test',
  baseUrl: 'https://ledger.unlikeotherai.com/v1/deepseek',
  modelName: 'deepseek-chat',
  provider: 'deepseek',
}

const JINA_OVERRIDE = {
  modelName: 'jina-embeddings-v3',
  provider: 'openai-compatible' as const,
  serviceId: 'jina',
}

// The five fields a Ledger-routed call must carry; anything less is refused
// before the request is built.
const LEDGER_ATTRIBUTION = {
  actorId: '00000000-0000-4000-8000-000000000001',
  actorType: 'user' as const,
  organizationId: '00000000-0000-4000-8000-000000000002',
  requestId: 'request-embed-1',
  teamId: '00000000-0000-4000-8000-000000000003',
  userId: '00000000-0000-4000-8000-000000000001',
}

type Captured = { body: Record<string, unknown>; headers: Headers; url: string }

const withFetchStub = async (
  response: () => Response,
  run: (calls: Captured[]) => Promise<void>,
): Promise<void> => {
  const originalFetch = globalThis.fetch
  const calls: Captured[] = []
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push({
      body: JSON.parse(init?.body?.toString() ?? '{}') as Record<string, unknown>,
      headers: new Headers(init?.headers),
      url: input.toString(),
    })
    return response()
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

const embeddingResponse = (model: string): Response =>
  new Response(
    JSON.stringify({
      data: [{ index: 0, embedding: Array<number>(EMBEDDING_DIMENSIONS).fill(0.1) }],
      model,
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }),
    { status: 200 },
  )

test('unset embedding config leaves embeddings on the chat provider', () => {
  const resolved = resolveEmbeddingProvider(LEDGER_DEEPSEEK_CHAT, undefined)

  assert.equal(resolved.config, null)
  assert.equal(resolved.model, 'text-embedding-3-small')
})

test('an all-empty embedding config is the same as none at all', () => {
  const resolved = resolveEmbeddingProvider(LEDGER_DEEPSEEK_CHAT, {
    apiKey: '  ',
    baseUrl: '',
    provider: undefined,
    serviceId: '',
  })

  assert.equal(resolved.config, null)
})

test('a model name alone changes what is asked for, not where', () => {
  const resolved = resolveEmbeddingProvider(LEDGER_DEEPSEEK_CHAT, {
    modelName: 'text-embedding-3-large',
  })

  assert.equal(resolved.config, null)
  assert.equal(resolved.model, 'text-embedding-3-large')
})

test('a set embedding config targets the embedding provider, inheriting key and host', () => {
  const resolved = resolveEmbeddingProvider(LEDGER_DEEPSEEK_CHAT, JINA_OVERRIDE)

  assert.ok(resolved.config)
  assert.equal(resolved.config.provider, 'openai-compatible')
  assert.equal(resolved.config.serviceId, 'jina')
  assert.equal(resolved.config.apiKey, 'lk_test')
  assert.equal(resolved.config.baseUrl, LEDGER_DEEPSEEK_CHAT.baseUrl)
  assert.equal(resolved.model, 'jina-embeddings-v3')
})

test('serviceId defaults to the embedding provider when not named', () => {
  const resolved = resolveEmbeddingProvider(LEDGER_DEEPSEEK_CHAT, {
    provider: 'openai',
  })

  assert.equal(resolved.config?.serviceId, 'openai')
})

test('an explicit base URL overrides the chat host', () => {
  const resolved = resolveEmbeddingProvider(LEDGER_DEEPSEEK_CHAT, {
    apiKey: 'local-key',
    baseUrl: 'https://embeddings.internal.example/v1',
    provider: 'openai-compatible',
  })

  assert.equal(resolved.config?.baseUrl, 'https://embeddings.internal.example/v1')
  assert.equal(resolved.config?.apiKey, 'local-key')
})

test('a Ledger chat base URL is rewritten to the embedding service segment', async () => {
  await withFetchStub(
    () => embeddingResponse('jina-embeddings-v3'),
    async (calls) => {
      const client = createModelClient(LEDGER_DEEPSEEK_CHAT, {
        embedding: JINA_OVERRIDE,
      })

      const vector = await client.embed('hello world')
      client.close()

      assert.equal(vector.length, EMBEDDING_DIMENSIONS)
      assert.equal(calls.length, 1)
      assert.equal(
        calls[0]!.url,
        'https://ledger.unlikeotherai.com/v1/jina/embeddings',
      )
      assert.equal(calls[0]!.body.model, 'jina-embeddings-v3')
      assert.equal(calls[0]!.body.dimensions, EMBEDDING_DIMENSIONS)
    },
  )
})

test('embeddingModel is the model every embed call asks for', async () => {
  await withFetchStub(
    () => embeddingResponse('jina-embeddings-v3'),
    async () => {
      const configured = createModelClient(LEDGER_DEEPSEEK_CHAT, {
        embedding: JINA_OVERRIDE,
      })
      assert.equal(configured.embeddingModel, 'jina-embeddings-v3')
      configured.close()

      const unconfigured = createModelClient(LEDGER_DEEPSEEK_CHAT)
      assert.equal(unconfigured.embeddingModel, 'text-embedding-3-small')
      unconfigured.close()
    },
  )
})

test('chat still goes to the chat provider when embeddings are rerouted', async () => {
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'hi' } }],
          model: 'deepseek-chat',
        }),
        { status: 200 },
      ),
    async (calls) => {
      const client = createModelClient(LEDGER_DEEPSEEK_CHAT, {
        embedding: JINA_OVERRIDE,
      })

      await client.chat([{ content: 'hey', role: 'user' }])
      client.close()

      assert.equal(
        calls[0]!.url,
        'https://ledger.unlikeotherai.com/v1/deepseek/chat/completions',
      )
    },
  )
})

test('signed identity reaches a Ledger-routed embedding host', async () => {
  await withFetchStub(
    () => embeddingResponse('jina-embeddings-v3'),
    async (calls) => {
      const client = createModelClient(LEDGER_DEEPSEEK_CHAT, {
        embedding: JINA_OVERRIDE,
        requestHeaders: async () => ({ 'X-Nessie-Context': 'signed-context' }),
        systemComponent: 'test-embedding-service',
      })

      await client.embed('hello world', { usage: LEDGER_ATTRIBUTION })
      client.close()

      assert.equal(calls[0]!.headers.get('x-nessie-context'), 'signed-context')
    },
  )
})

test('signed identity is withheld from an embedding host that is not Ledger', async () => {
  await withFetchStub(
    () => embeddingResponse('bge-m3'),
    async (calls) => {
      const client = createModelClient(LEDGER_DEEPSEEK_CHAT, {
        embedding: {
          apiKey: 'local-key',
          baseUrl: 'https://embeddings.internal.example/v1',
          modelName: 'bge-m3',
          provider: 'openai-compatible',
        },
        requestHeaders: async () => ({ 'X-Nessie-Context': 'signed-context' }),
        systemComponent: 'test-embedding-service',
      })

      await client.embed('hello world', { usage: LEDGER_ATTRIBUTION })
      client.close()

      assert.equal(
        calls[0]!.url,
        'https://embeddings.internal.example/v1/embeddings',
      )
      assert.equal(calls[0]!.headers.get('x-nessie-context'), null)
    },
  )
})

test('two Ledger adapter paths are one host; a different origin is not', () => {
  assert.equal(
    isSameInferenceHost(
      'https://ledger.unlikeotherai.com/v1/jina',
      'https://ledger.unlikeotherai.com/v1/deepseek',
    ),
    true,
  )
  assert.equal(
    isSameInferenceHost(
      'https://embeddings.internal.example/v1',
      'https://ledger.unlikeotherai.com/v1/deepseek',
    ),
    false,
  )
  assert.equal(isSameInferenceHost(undefined, undefined), true)
  assert.equal(isSameInferenceHost('https://api.openai.com/v1', undefined), false)
})
