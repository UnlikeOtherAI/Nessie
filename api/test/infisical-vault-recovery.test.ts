import assert from 'node:assert/strict'
import test from 'node:test'

import { InfisicalVault } from '../src/services/infisical-vault.js'

test('put repairs a deterministic orphan when Infisical reports an existing secret', async () => {
  const originalFetch = globalThis.fetch
  const methods: string[] = []
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input))
    methods.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    if (url.pathname === '/api/v2/folders') return new Response(null, { status: 200 })
    if (init?.method === 'POST') {
      return Response.json({ message: "Secret 'NESSIE_TEST' already exists" }, { status: 409 })
    }
    return new Response(null, { status: 200 })
  }) as typeof fetch

  try {
    const vault = new InfisicalVault({
      INFISICAL_API_URL: 'https://8.8.8.8',
      INFISICAL_ENVIRONMENT: 'prod',
      INFISICAL_PROJECT_ID: 'vault-project',
      INFISICAL_SERVICE_TOKEN: 'test-service-token',
    })
    const reference = await vault.put({
      name: 'NESSIE_TEST',
      namespace: {
        organizationId: '10000000-0000-4000-8000-000000000001',
        scopeId: '20000000-0000-4000-8000-000000000001',
        scopeType: 'personal',
      },
      value: 'opaque-secret-value',
    })

    assert.match(reference, /NESSIE_TEST$/u)
    assert.deepEqual(methods.slice(-2), [
      'POST /api/v4/secrets/NESSIE_TEST',
      'PATCH /api/v4/secrets/NESSIE_TEST',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
