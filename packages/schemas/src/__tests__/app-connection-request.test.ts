import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AppConnectRequestToolInputSchema,
  AppSetupCardPresenterSchema,
  AppSetupCardSchema,
} from '../app-connection-request.js'

const id = '8f3a5a00-0e64-4d10-a517-0d0b69c1d101'

test('app setup message metadata is only an opaque request pointer', () => {
  assert.deepEqual(AppSetupCardSchema.parse({
    card: { kind: 'app_connect_request', requestId: id, schemaVersion: 1 },
  }), {
    card: { kind: 'app_connect_request', requestId: id, schemaVersion: 1 },
  })

  assert.equal(AppSetupCardSchema.safeParse({
    card: {
      authorizationUrl: 'https://provider.example/authorize',
      kind: 'app_connect_request',
      requestId: id,
      schemaVersion: 1,
    },
  }).success, false)
})

test('app setup request input is bounded and only accepts catalogue ids', () => {
  assert.equal(AppConnectRequestToolInputSchema.safeParse({
    candidateCatalogEntryIds: [id, id, id, id],
    reason: 'Connect Linear.',
  }).success, false)
  assert.equal(AppConnectRequestToolInputSchema.safeParse({
    candidateCatalogEntryIds: [id],
    endpoint: 'https://connector.example/mcp',
    reason: 'Connect Linear.',
  }).success, false)
})

test('app setup presenter never carries account, instance or authorization fields', () => {
  const card = {
    action: 'begin',
    agent: { id, name: 'KiloResearcher' },
    candidates: [{
      authMethod: 'oauth2',
      capabilityCount: 67,
      catalogEntryId: id,
      displayName: 'Linear',
      iconUrl: '/api/attachments/linear-icon',
      shortDescription: 'Project planning and issue tracking.',
      trustLevel: 'verified',
    }],
    detail: null,
    expiresAt: '2026-09-02T12:00:00.000Z',
    failureCode: null,
    requestId: id,
    scope: { label: 'Only you', scopeType: 'user' },
    selectedCatalogEntryId: null,
    status: 'offered',
  }

  assert.equal(AppSetupCardPresenterSchema.safeParse(card).success, true)
  assert.equal(AppSetupCardPresenterSchema.safeParse({
    ...card,
    authorizationUrl: 'https://provider.example/authorize',
  }).success, false)
  assert.equal(AppSetupCardPresenterSchema.safeParse({
    ...card,
    mcpInstanceId: id,
  }).success, false)
})
