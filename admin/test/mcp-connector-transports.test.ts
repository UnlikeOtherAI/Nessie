import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describeTransport,
  isOfferableTransport,
  OFFERABLE_TRANSPORTS,
} from '../src/components/features/mcp-app-store/connector-transports.js'
import { buildTransportConfig } from '../src/components/features/mcp-app-store/add-server-wizard-config.js'
import { validateTransportStep } from '../src/components/features/mcp-app-store/add-server-wizard-validation.js'

test('the wizard never offers a transport the server refuses', () => {
  // stdio is rejected by createCatalogEntry; ws saves and installs but dies at
  // the first probe because @nessie/mcp-client has no ws transport.
  assert.deepEqual([...OFFERABLE_TRANSPORTS], ['http', 'sse'])
  assert.equal(isOfferableTransport('stdio'), false)
  assert.equal(isOfferableTransport('ws'), false)
  assert.equal(isOfferableTransport('http'), true)
  assert.equal(isOfferableTransport('sse'), true)
})

test('every offered transport is described by the decision it drives', () => {
  for (const transport of OFFERABLE_TRANSPORTS) {
    const description = describeTransport(transport)
    assert.ok(description.length > transport.length, `${transport} needs a real label`)
  }
  assert.notEqual(describeTransport('http'), describeTransport('sse'))
})

test('buildTransportConfig emits the chosen remote transport with a trimmed url', () => {
  assert.deepEqual(buildTransportConfig('http', { url: '  https://example.com/mcp  ' }), {
    transport: 'http',
    url: 'https://example.com/mcp',
  })
  assert.deepEqual(buildTransportConfig('sse', { url: 'https://example.com/mcp/sse' }), {
    transport: 'sse',
    url: 'https://example.com/mcp/sse',
  })
})

test('transport validation requires an http(s) endpoint', () => {
  assert.deepEqual(validateTransportStep({ url: '' }), { url: 'URL is required' })
  assert.deepEqual(validateTransportStep({ url: 'not a url' }), { url: 'Invalid URL' })
  assert.deepEqual(validateTransportStep({ url: 'wss://example.com/mcp' }), {
    url: 'URL must use http:// or https:// scheme',
  })
  assert.deepEqual(validateTransportStep({ url: 'https://example.com/mcp' }), {})
})
