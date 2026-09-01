import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { resolveInstanceMcpTransport } from '../src/mcp-instance-call.js'

test('an auth-requiring MCP instance has no callable transport without a resolved secret', async () => {
  let secretLookups = 0
  const prisma = {
    mcpServerInstance: {
      findUnique: async () => ({
        id: 'instance-1',
        credentialRef: 'secret_missing',
        scopeType: 'user',
        scopeId: 'user-1',
        transportConfig: {},
        lifecycleState: 'active',
        catalogEntry: {
          authMethod: 'oauth2',
          authConfig: { method: 'oauth2' },
          defaultTransportConfig: { transport: 'http', url: 'https://example.test/mcp' },
        },
      }),
    },
    mcpServerCredentialOverride: { findUnique: async () => null },
  } as unknown as PrismaClient

  const resolved = await resolveInstanceMcpTransport(
    prisma,
    'instance-1',
    { userId: 'user-1' },
    {
      resolve: async () => {
        secretLookups += 1
        return null
      },
    },
  )

  assert.equal(resolved, null)
  assert.equal(secretLookups, 1)
})

test('a credential-free MCP instance remains callable without a secret', async () => {
  const prisma = {
    mcpServerInstance: {
      findUnique: async () => ({
        id: 'instance-1',
        credentialRef: null,
        scopeType: 'user',
        scopeId: 'user-1',
        transportConfig: {},
        lifecycleState: 'active',
        catalogEntry: {
          authMethod: 'none',
          authConfig: { method: 'none' },
          defaultTransportConfig: { transport: 'http', url: 'https://example.test/mcp' },
        },
      }),
    },
    mcpServerCredentialOverride: { findUnique: async () => null },
  } as unknown as PrismaClient

  const resolved = await resolveInstanceMcpTransport(
    prisma,
    'instance-1',
    { userId: 'user-1' },
    { resolve: async () => null },
  )

  assert.deepEqual(resolved?.transport, {
    transport: 'http',
    url: 'https://example.test/mcp',
  })
})

test('a pending OAuth instance preserves its lifecycle for the sign-in surface', async () => {
  const prisma = {
    mcpServerInstance: {
      findUnique: async () => ({
        id: 'instance-1',
        credentialRef: null,
        scopeType: 'user',
        scopeId: 'user-1',
        transportConfig: {},
        lifecycleState: 'pending_setup',
        catalogEntry: {
          authMethod: 'oauth2',
          authConfig: { method: 'oauth2' },
          defaultTransportConfig: { transport: 'http', url: 'https://example.test/mcp' },
        },
      }),
    },
    mcpServerCredentialOverride: { findUnique: async () => null },
  } as unknown as PrismaClient

  const resolved = await resolveInstanceMcpTransport(
    prisma,
    'instance-1',
    { userId: 'user-1' },
    { resolve: async () => null },
  )

  assert.equal(resolved?.lifecycleState, 'pending_setup')
  assert.equal(resolved?.authMethod, 'oauth2')
})
