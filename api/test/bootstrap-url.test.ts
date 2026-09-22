import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildAdminBootstrapUrl, resolveAdminPort } from '../src/lib/server-context.js'

describe('admin bootstrap URL', () => {
  it('defaults to port 5455', () => {
    delete process.env.NESSIE_ADMIN_PORT
    assert.equal(resolveAdminPort(), 5455)
    assert.equal(buildAdminBootstrapUrl('abc'), 'http://localhost:5455/bootstrap?token=abc')
  })

  it('honours NESSIE_ADMIN_PORT', () => {
    process.env.NESSIE_ADMIN_PORT = '6001'
    try {
      assert.equal(resolveAdminPort(), 6001)
      assert.equal(buildAdminBootstrapUrl('abc'), 'http://localhost:6001/bootstrap?token=abc')
    } finally {
      delete process.env.NESSIE_ADMIN_PORT
    }
  })
})
