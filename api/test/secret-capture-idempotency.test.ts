import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureFingerprintForValue,
  secretMatchesCaptureRequest,
} from '../src/routes/secret-capture-idempotency.js'

const authSecret = 'capture-fingerprint-test-secret'
const value = 'opaque-secret-value'
const stored = {
  captureFingerprint: captureFingerprintForValue(authSecret, value),
  createdById: '00000000-0000-4000-8000-000000000001',
  description: null,
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  name: 'SERVICE_SECRET',
  organizationId: '00000000-0000-4000-8000-000000000002',
  provider: null,
  scopeId: '00000000-0000-4000-8000-000000000001',
  scopeType: 'personal',
}
const request = {
  expiresAt: '2030-01-01T00:00:00Z',
  name: 'SERVICE_SECRET',
  scopeType: 'personal',
  value,
}
const context = {
  actorId: stored.createdById,
  authSecret,
  organizationId: stored.organizationId,
  scopeId: stored.scopeId,
}

test('capture matching canonicalizes timestamps and binds the raw value with a keyed HMAC', () => {
  assert.equal(secretMatchesCaptureRequest(stored, request, context), true)
  assert.equal(
    secretMatchesCaptureRequest(stored, { ...request, value: 'different-secret-value' }, context),
    false,
  )
})
