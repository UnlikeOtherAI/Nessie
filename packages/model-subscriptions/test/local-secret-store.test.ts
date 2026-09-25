import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import { createSubscriptionSecretStoreFromEnv } from '../src/secret-store.js'

test('local embedded API and worker share explicitly enabled temporary credentials', async () => {
  const env = { NESSIE_MODE: 'local', NESSIE_LOCAL_SUBSCRIPTIONS_MEMORY: '1' }
  const api = createSubscriptionSecretStoreFromEnv(env)
  const worker = createSubscriptionSecretStoreFromEnv(env)
  assert.ok(api)
  assert.ok(worker)
  const name = randomUUID()
  await api.write({ name, bundle: { accessToken: 'local-test-credential' } })
  assert.equal((await worker.read(name)).accessToken, 'local-test-credential')
  await api.remove(name)
  await assert.rejects(worker.read(name))
})

test('temporary credentials require explicit local mode and never override the vault', () => {
  assert.equal(createSubscriptionSecretStoreFromEnv({ NESSIE_MODE: 'local' }), null)
  for (const mode of [undefined, 'production', 'cloud']) {
    assert.equal(createSubscriptionSecretStoreFromEnv({
      NESSIE_MODE: mode, NESSIE_LOCAL_SUBSCRIPTIONS_MEMORY: '1',
    }), null)
  }
  const env = {
    NESSIE_MODE: 'local', NESSIE_LOCAL_SUBSCRIPTIONS_MEMORY: '1',
    NESSIE_SUBSCRIPTION_VAULT_API_URL: 'https://vault.example.com',
    NESSIE_SUBSCRIPTION_VAULT_PROJECT_ID: 'test-project', NESSIE_SUBSCRIPTION_VAULT_TOKEN: 'test-token',
  }
  assert.notEqual(createSubscriptionSecretStoreFromEnv(env), createSubscriptionSecretStoreFromEnv(env))
})
