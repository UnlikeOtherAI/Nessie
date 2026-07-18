import assert from 'node:assert/strict'
import test from 'node:test'

import type { ModelConfig, ModelProvider } from '@nessie/config'
import { resolveStageApiKey } from './inference.js'

const ledgerConfig = (provider: ModelProvider): ModelConfig => ({
  apiKey: 'ledger-proxy-token',
  baseUrl: 'https://ledger.unlikeotherai.com/v1',
  backends: [],
  maxTokens: 2048,
  provider,
  temperature: 0.2,
})

test('Ledger routing never forwards provider bindings or direct-provider keys', () => {
  const previous = {
    bound: process.env.TEST_PROVIDER_BINDING,
    kimi: process.env.KIMI_API_KEY,
    minimax: process.env.MINIMAX_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  }
  process.env.TEST_PROVIDER_BINDING = 'bound-direct-secret'
  process.env.KIMI_API_KEY = 'kimi-direct-secret'
  process.env.MINIMAX_API_KEY = 'minimax-direct-secret'
  process.env.OPENAI_API_KEY = 'openai-direct-secret'

  try {
    for (const provider of ['openai', 'kimi', 'minimax'] as const) {
      assert.equal(
        resolveStageApiKey({
          authSecretRef: 'TEST_PROVIDER_BINDING',
          modelConfig: ledgerConfig(provider),
          runtimeProvider: provider,
        }),
        'ledger-proxy-token',
      )
    }
  } finally {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
    restore('TEST_PROVIDER_BINDING', previous.bound)
    restore('KIMI_API_KEY', previous.kimi)
    restore('MINIMAX_API_KEY', previous.minimax)
    restore('OPENAI_API_KEY', previous.openai)
  }
})

test('Ledger routing fails closed when its ProxyToken is absent', () => {
  assert.equal(
    resolveStageApiKey({
      authSecretRef: null,
      modelConfig: { ...ledgerConfig('openai'), apiKey: undefined },
      runtimeProvider: 'openai',
    }),
    '',
  )
})

test('provider-record Ledger routing never substitutes its bound direct key', () => {
  const previous = process.env.TEST_PROVIDER_BINDING
  process.env.TEST_PROVIDER_BINDING = 'bound-direct-secret'

  try {
    assert.equal(
      resolveStageApiKey({
        authSecretRef: 'TEST_PROVIDER_BINDING',
        baseUrl: 'https://ledger.unlikeotherai.com/v1/kimi',
        modelConfig: {
          ...ledgerConfig('kimi'),
          baseUrl: undefined,
        },
        runtimeProvider: 'kimi',
      }),
      'ledger-proxy-token',
    )
  } finally {
    if (previous === undefined) {
      delete process.env.TEST_PROVIDER_BINDING
    } else {
      process.env.TEST_PROVIDER_BINDING = previous
    }
  }
})
