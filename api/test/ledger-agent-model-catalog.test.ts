import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertLedgerAgentModelSelection,
  LedgerAgentModelCatalogError,
  listLedgerAgentModels,
} from '../src/services/ledger-agent-model-catalog.js'

const catalogConfig = {
  apiKey: 'lk_nessie_test',
  baseUrl: 'https://ledger.example/v1/openai',
}

const ledgerPublicUrl = 'https://ledger.example'

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })

test('lists only token-authorized chat-completions models from Ledger', async () => {
  let requestedUrl: string | undefined
  let authorization: string | null | undefined
  const models = await listLedgerAgentModels({
    config: catalogConfig,
    fetchImpl: async (input, init) => {
      requestedUrl = input.toString()
      authorization = new Headers(init?.headers).get('authorization')
      return response({
        object: 'list',
        data: [
          {
            id: 'gpt-5-mini',
            kind: 'service',
            display_name: 'GPT-5 mini',
            description: 'Fast chat model.',
            service: { id: 'openai', name: 'OpenAI' },
            endpoints: ['chat/completions', 'embeddings'],
          },
          {
            id: 'mistral-embed',
            kind: 'service',
            service: { id: 'mistral', name: 'Mistral' },
            endpoints: ['embeddings'],
          },
          {
            id: 'claude-sonnet',
            kind: 'service',
            service: { id: 'anthropic', name: 'Anthropic' },
            endpoints: ['messages'],
          },
          {
            id: 'team-fusion',
            kind: 'fusion',
            display_name: 'Team Fusion',
            path: '/v1/chat/completions',
          },
          {
            id: 'mistral-large',
            kind: 'service',
            service: { id: 'mistral', name: 'Mistral' },
            endpoints: ['chat/completions'],
          },
        ],
      })
    },
    ledgerPublicUrl,
  })

  assert.equal(requestedUrl, 'https://ledger.example/v1/models')
  assert.equal(authorization, 'Bearer lk_nessie_test')
  assert.deepEqual(models, [
    {
      displayName: 'mistral-large',
      model: 'mistral-large',
      provider: 'mistral',
      providerDisplayName: 'Mistral',
    },
    {
      description: 'Fast chat model.',
      displayName: 'GPT-5 mini',
      model: 'gpt-5-mini',
      provider: 'openai',
      providerDisplayName: 'OpenAI',
    },
  ])
})

test('rejects a selected model that is not currently granted to the Ledger key', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => response({
    data: [
      {
        id: 'gpt-5-mini',
        kind: 'service',
        service: { id: 'openai', name: 'OpenAI' },
        endpoints: ['chat/completions'],
      },
    ],
  })) as typeof fetch

  try {
    await assert.rejects(
      assertLedgerAgentModelSelection({
        config: catalogConfig,
        ledgerPublicUrl,
        model: 'gpt-5',
        provider: 'openai',
      }),
      (error: unknown) =>
        error instanceof LedgerAgentModelCatalogError
        && error.code === 'LEDGER_AGENT_MODEL_NOT_AVAILABLE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fails closed when the configured model URL is not Ledger', async () => {
  await assert.rejects(
    listLedgerAgentModels({
      config: {
        ...catalogConfig,
        baseUrl: 'https://api.openai.com/v1',
      },
      ledgerPublicUrl,
    }),
    (error: unknown) =>
      error instanceof LedgerAgentModelCatalogError
      && error.code === 'LEDGER_MODEL_CATALOG_UNCONFIGURED',
  )
})
