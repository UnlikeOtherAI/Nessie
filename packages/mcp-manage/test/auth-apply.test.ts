import assert from 'node:assert/strict'
import test from 'node:test'

import type { McpTransportConfig } from '@nessie/schemas'

import { applyAuthSecretToTransport, canManageInstanceScope } from '../src/index.js'

const httpTransport: McpTransportConfig = {
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
}

test('bearer auth becomes an Authorization header', () => {
  const applied = applyAuthSecretToTransport(httpTransport, { method: 'bearer' }, 'tok-1')
  assert.equal(
    applied.transport === 'http' ? applied.headers?.Authorization : undefined,
    'Bearer tok-1',
  )
})

test('oauth2 tokens are applied as bearer tokens', () => {
  const applied = applyAuthSecretToTransport(
    httpTransport,
    {
      method: 'oauth2',
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'client',
      clientSecret: 'secret',
      scopes: [],
    },
    'tok-2',
  )
  assert.equal(
    applied.transport === 'http' ? applied.headers?.Authorization : undefined,
    'Bearer tok-2',
  )
})

test('api_key auth uses the configured header name and prefix', () => {
  const applied = applyAuthSecretToTransport(
    httpTransport,
    { method: 'api_key', headerName: 'X-Api-Key', valuePrefix: 'Key ' },
    'k-9',
  )
  assert.equal(
    applied.transport === 'http' ? applied.headers?.['X-Api-Key'] : undefined,
    'Key k-9',
  )
})

test('basic auth encodes the credential as an Authorization header', () => {
  const applied = applyAuthSecretToTransport(
    httpTransport,
    { method: 'basic' },
    'alicia:correct-horse-battery-staple',
  )
  assert.equal(
    applied.transport === 'http' ? applied.headers?.Authorization : undefined,
    'Basic YWxpY2lhOmNvcnJlY3QtaG9yc2UtYmF0dGVyeS1zdGFwbGU=',
  )
})

test('unparseable auth config falls back to bearer semantics', () => {
  const applied = applyAuthSecretToTransport(httpTransport, { nonsense: true }, 'tok-3')
  assert.equal(
    applied.transport === 'http' ? applied.headers?.Authorization : undefined,
    'Bearer tok-3',
  )
})

test('no secret / none method leaves the transport untouched', () => {
  assert.equal(applyAuthSecretToTransport(httpTransport, { method: 'bearer' }, null), httpTransport)
  const noneApplied = applyAuthSecretToTransport(httpTransport, { method: 'none' }, 'tok')
  assert.equal(noneApplied.transport === 'http' ? noneApplied.headers : undefined, undefined)
})

// ─── canManageInstanceScope ─────────────────────────────────────────────────

test('owners manage every scope', () => {
  for (const scopeType of ['user', 'organization', 'project', 'team', 'channel', 'system']) {
    assert.equal(
      canManageInstanceScope({ role: 'owner' }, 'u1', scopeType, 'any'),
      true,
      scopeType,
    )
  }
})

test('admins manage shared scopes plus their own user scope, not system or other users', () => {
  const admin = { role: 'admin' as const }
  assert.equal(canManageInstanceScope(admin, 'u1', 'organization', 'org1'), true)
  assert.equal(canManageInstanceScope(admin, 'u1', 'team', 't1'), true)
  assert.equal(canManageInstanceScope(admin, 'u1', 'channel', 'c1'), true)
  assert.equal(canManageInstanceScope(admin, 'u1', 'project', 'p1'), true)
  assert.equal(canManageInstanceScope(admin, 'u1', 'user', 'u1'), true)
  assert.equal(canManageInstanceScope(admin, 'u1', 'user', 'u2'), false)
  assert.equal(canManageInstanceScope(admin, 'u1', 'system', 'sys'), false)
})

test('members manage only their own user scope', () => {
  const member = { role: 'member' as const }
  assert.equal(canManageInstanceScope(member, 'u1', 'user', 'u1'), true)
  assert.equal(canManageInstanceScope(member, 'u1', 'user', 'u2'), false)
  assert.equal(canManageInstanceScope(member, 'u1', 'organization', 'org1'), false)
  assert.equal(canManageInstanceScope({ role: null }, 'u1', 'user', 'u1'), true)
})
