import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerMcpInstanceRoutes } from '../src/routes/mcp/instances.js'

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const CATALOG_ID = '22222222-2222-4222-8222-222222222222'
const ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333'
const USER_ID = '44444444-4444-4444-8444-444444444444'

const actorContext: AuthorizedActionContext = {
  actor: {
    actorId: USER_ID,
    actorType: 'user',
    roles: ['owner'],
  },
  actionContext: { requestId: 'managed-route-test' },
  tenant: { organizationId: ORGANIZATION_ID },
}

test('generic lifecycle routes return 409 for managed DeepWater without mutations', async () => {
  const mutationCalls = {
    delete: 0,
    transaction: 0,
    update: 0,
  }
  const prisma = {
    mcpCatalogEntry: {
      findFirst: async () => ({
        integratedProducts: [{ slug: 'deep-water' }],
        name: 'deep-water',
        organizationId: null,
        visibility: 'public',
      }),
    },
    mcpServerInstance: {
      delete: async () => {
        mutationCalls.delete += 1
        return {}
      },
      findFirst: async () => ({
        catalogEntryId: CATALOG_ID,
        id: INSTANCE_ID,
        organizationId: ORGANIZATION_ID,
        scopeId: ORGANIZATION_ID,
        scopeType: 'organization',
      }),
      update: async () => {
        mutationCalls.update += 1
        return {}
      },
    },
    $transaction: async () => {
      mutationCalls.transaction += 1
      return {}
    },
  } as unknown as PrismaClient
  const app = Fastify()
  registerMcpInstanceRoutes(app, {
    mcpSecretStore: {} as never,
    oauthSecretStore: {} as never,
    prisma,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    secretResolver: {} as never,
  })
  await app.ready()

  try {
    const requests = [
      { method: 'POST' as const, url: `/api/mcp/instances/${INSTANCE_ID}/test` },
      { method: 'POST' as const, url: `/api/mcp/instances/${INSTANCE_ID}/refresh` },
      { method: 'POST' as const, url: `/api/mcp/instances/${INSTANCE_ID}/healthcheck` },
      { method: 'DELETE' as const, url: `/api/mcp/instances/${INSTANCE_ID}` },
    ]

    for (const request of requests) {
      const response = await app.inject(request)
      assert.equal(response.statusCode, 409, response.body)
      assert.equal(
        response.json().error.code,
        'MCP_INSTANCE_MANAGED_BY_INTEGRATION',
      )
    }
    assert.deepEqual(mutationCalls, {
      delete: 0,
      transaction: 0,
      update: 0,
    })
  } finally {
    await app.close()
  }
})

test('public instance creation rejects every caller-supplied credential ref before lookup', async () => {
  let secretStoreCalls = 0
  let resolverCalls = 0
  const app = Fastify()
  registerMcpInstanceRoutes(app, {
    mcpSecretStore: {
      put: async () => {
        secretStoreCalls += 1
        return 'secret_should_not_exist'
      },
    },
    oauthSecretStore: {} as never,
    prisma: {} as PrismaClient,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    secretResolver: {
      resolve: async () => {
        resolverCalls += 1
        return 'must-not-resolve'
      },
    },
  })
  await app.ready()

  try {
    for (const credentialRef of [
      'DEEPSIGNAL_MCP_APP_KEY',
      'NESSIE_AUTH_SECRET',
      'ARBITRARY_FUTURE_SECRET',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/mcp/instances',
        payload: {
          catalogEntryId: CATALOG_ID,
          credentialRef,
          scopeType: 'user',
          scopeId: USER_ID,
        },
      })
      assert.equal(response.statusCode, 400, response.body)
      assert.equal(response.json().error.code, 'VALIDATION_ERROR')
    }
    assert.equal(secretStoreCalls, 0)
    assert.equal(resolverCalls, 0)
  } finally {
    await app.close()
  }
})
