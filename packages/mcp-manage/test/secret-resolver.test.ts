import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EnvSecretResolver,
  MCP_OPERATOR_ENV_SECRET_REFS,
} from '../src/secret-resolver.js'

test('environment resolver exposes only exact operator-provisioned integration refs', async () => {
  const resolver = new EnvSecretResolver({
    DEEPSIGNAL_MCP_APP_KEY: 'deep-signal-key',
    LEDGER_PROXY_TOKEN: 'ledger-key',
    NESSIE_AUTH_SECRET: 'auth-secret',
    ARBITRARY_FUTURE_SECRET: 'future-secret',
  })

  assert.deepEqual(
    [...MCP_OPERATOR_ENV_SECRET_REFS],
    ['DEEPSIGNAL_MCP_APP_KEY', 'LEDGER_PROXY_TOKEN'],
  )
  assert.equal(
    await resolver.resolve('DEEPSIGNAL_MCP_APP_KEY'),
    'deep-signal-key',
  )
  assert.equal(await resolver.resolve('LEDGER_PROXY_TOKEN'), 'ledger-key')
  assert.equal(await resolver.resolve('NESSIE_AUTH_SECRET'), null)
  assert.equal(await resolver.resolve('ARBITRARY_FUTURE_SECRET'), null)
  assert.equal(await resolver.resolve('DEEPSIGNAL_MCP_APP_KEY_SUFFIX'), null)
})
