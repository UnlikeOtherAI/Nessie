import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MCP_CATALOG_ERROR_CODES,
  McpCatalogError,
  ensureAuthConfigMatchesMethod,
} from '../src/services/mcp-catalog.js'

test('ensureAuthConfigMatchesMethod returns parsed config when method matches', () => {
  const result = ensureAuthConfigMatchesMethod('api_key', {
    method: 'api_key',
    headerName: 'X-API-Key',
    valuePrefix: '',
  })
  assert.equal(result.method, 'api_key')
  if (result.method === 'api_key') {
    assert.equal(result.headerName, 'X-API-Key')
  }
})

test('ensureAuthConfigMatchesMethod parses oauth2 with defaulted scopes', () => {
  const result = ensureAuthConfigMatchesMethod('oauth2', {
    method: 'oauth2',
    authorizationUrl: 'https://example.com/auth',
    tokenUrl: 'https://example.com/token',
  })
  assert.equal(result.method, 'oauth2')
  if (result.method === 'oauth2') {
    assert.deepEqual(result.scopes, [])
  }
})

test('ensureAuthConfigMatchesMethod rejects shape mismatch', () => {
  let thrown: unknown
  try {
    ensureAuthConfigMatchesMethod('api_key', { method: 'api_key' })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpCatalogError)
  assert.equal((thrown as McpCatalogError).code, MCP_CATALOG_ERROR_CODES.AUTH_CONFIG_INVALID)
})

test('ensureAuthConfigMatchesMethod rejects method mismatch', () => {
  let thrown: unknown
  try {
    ensureAuthConfigMatchesMethod('bearer', { method: 'none' })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpCatalogError)
  assert.equal((thrown as McpCatalogError).code, MCP_CATALOG_ERROR_CODES.AUTH_METHOD_MISMATCH)
})

test('ensureAuthConfigMatchesMethod rejects entirely bogus payloads', () => {
  let thrown: unknown
  try {
    ensureAuthConfigMatchesMethod('none', { method: 'magic' })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpCatalogError)
  assert.equal((thrown as McpCatalogError).code, MCP_CATALOG_ERROR_CODES.AUTH_CONFIG_INVALID)
})
