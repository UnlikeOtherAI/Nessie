import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  MCP_CREDENTIAL_ERROR_CODES,
  McpCredentialError,
  storeInstanceSecret,
} from '../src/index.js'

const instance = {
  id: 'instance-1',
  scopeId: 'channel-1',
  scopeType: 'channel' as const,
}

test('only an API key may become a shared instance credential', async () => {
  let stored = 0
  const prisma = {
    mcpServerInstance: { update: async () => ({}) },
  } as unknown as PrismaClient

  await assert.rejects(
    storeInstanceSecret(prisma, {
      put: async () => {
        stored += 1
        return 'secret_should_not_exist'
      },
    }, {
      access: { role: 'owner' },
      authMethod: 'oauth2',
      instance,
      secret: 'oauth-access-token',
      shared: true,
      userId: 'user-1',
    }),
    (error: unknown) =>
      error instanceof McpCredentialError
      && error.code === MCP_CREDENTIAL_ERROR_CODES.SHARED_CREDENTIAL_AUTH_FORBIDDEN,
  )
  assert.equal(stored, 0)
})

test('an authorized manager may deliberately share an API key', async () => {
  const writes: unknown[] = []
  const prisma = {
    mcpServerInstance: {
      update: async (write: unknown) => {
        writes.push(write)
        return {}
      },
    },
  } as unknown as PrismaClient

  const result = await storeInstanceSecret(prisma, {
    put: async () => 'secret_shared_key',
  }, {
    access: { role: 'owner' },
    authMethod: 'api_key',
    instance,
    secret: 'team-api-key',
    shared: true,
    userId: 'user-1',
  })

  assert.equal(result.placement, 'shared_default')
  assert.deepEqual(writes, [{
    data: { credentialRef: 'secret_shared_key' },
    where: { id: 'instance-1' },
  }])
})
