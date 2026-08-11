import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { loadConfig } from '../src/index.js'

// loadConfig reads `nessie.config.json` from cwd. Point every case at an empty
// directory so the developer's own config file cannot colour the result.
const EMPTY_DIR = mkdtempSync(`${tmpdir()}/nessie-embedding-config-`)

const load = (env: NodeJS.ProcessEnv) =>
  loadConfig({
    argv: [],
    cwd: EMPTY_DIR,
    env: {
      NESSIE_AUTH_SECRET: 'a'.repeat(64),
      NESSIE_DB_URL: 'postgresql://nessie:nessie@127.0.0.1:5432/nessie',
      ...env,
    },
  })

test('embedding config is empty when nothing is set', () => {
  const config = load({
    NESSIE_MODEL_API_KEY: 'lk_test',
    NESSIE_MODEL_BASE_URL: 'https://ledger.unlikeotherai.com/v1/deepseek',
    NESSIE_MODEL_PROVIDER: 'deepseek',
  })

  assert.deepEqual(config.embedding, {})
  assert.equal(config.model.provider, 'deepseek')
})

test('embedding env names the provider, model, and Ledger service segment', () => {
  const config = load({
    NESSIE_EMBEDDING_MODEL: 'jina-embeddings-v3',
    NESSIE_EMBEDDING_PROVIDER: 'openai-compatible',
    NESSIE_EMBEDDING_SERVICE_ID: 'jina',
    NESSIE_MODEL_API_KEY: 'lk_test',
    NESSIE_MODEL_BASE_URL: 'https://ledger.unlikeotherai.com/v1/deepseek',
    NESSIE_MODEL_PROVIDER: 'deepseek',
  })

  assert.deepEqual(config.embedding, {
    modelName: 'jina-embeddings-v3',
    provider: 'openai-compatible',
    serviceId: 'jina',
  })
  // Chat is untouched by the embedding block.
  assert.equal(config.model.provider, 'deepseek')
  assert.equal(config.model.baseUrl, 'https://ledger.unlikeotherai.com/v1/deepseek')
})

test('embedding host and key can be named independently of chat', () => {
  const config = load({
    NESSIE_EMBEDDING_API_KEY: 'embed-key',
    NESSIE_EMBEDDING_BASE_URL: 'https://embeddings.internal.example/v1',
    NESSIE_EMBEDDING_PROVIDER: 'openai-compatible',
    NESSIE_MODEL_API_KEY: 'chat-key',
    NESSIE_MODEL_PROVIDER: 'openai',
  })

  assert.equal(config.embedding.apiKey, 'embed-key')
  assert.equal(config.embedding.baseUrl, 'https://embeddings.internal.example/v1')
  assert.equal(config.model.apiKey, 'chat-key')
})

test('an unknown embedding provider is rejected rather than silently ignored', () => {
  assert.throws(() =>
    load({
      NESSIE_EMBEDDING_PROVIDER: 'jina',
      NESSIE_MODEL_API_KEY: 'lk_test',
      NESSIE_MODEL_PROVIDER: 'deepseek',
    }),
  )
})

test('a service id that is not a single URL segment is rejected', () => {
  assert.throws(() =>
    load({
      NESSIE_EMBEDDING_PROVIDER: 'openai-compatible',
      NESSIE_EMBEDDING_SERVICE_ID: 'jina/embeddings',
      NESSIE_MODEL_API_KEY: 'lk_test',
      NESSIE_MODEL_PROVIDER: 'deepseek',
    }),
  )
})
