import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerMcpCredentialRoutes } from '../src/routes/mcp/credentials.js'
import { RateLimiter } from '../src/services/rate-limit.js'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const INSTANCE_ID = '33333333-3333-4333-8333-333333333333'

const actorContext: AuthorizedActionContext = {
  actor: { actorId: USER_ID, actorType: 'user', roles: ['owner'] },
  actionContext: { requestId: 'credential-route-test' },
  tenant: { organizationId: ORGANIZATION_ID },
}

test('credential route stores plaintext once and never exposes its opaque ref', async () => {
  const storedSecrets: string[] = []
  const overrides: Array<{
    id: string
    instanceId: string
    principalType: 'user'
    principalId: string
    credentialRef: string
    createdAt: Date
    updatedAt: Date
  }> = []
  let authMethod: 'api_key' | 'oauth2' = 'api_key'
  let authConfig: unknown = { method: 'api_key', headerName: 'X-API-Key', valuePrefix: '' }
  const prisma = {
    mcpServerInstance: {
      findFirst: async (args: { where: { catalogEntry?: unknown } }) =>
        args.where.catalogEntry
          ? null
          : {
              id: INSTANCE_ID,
              organizationId: ORGANIZATION_ID,
              catalogEntryId: '44444444-4444-4444-8444-444444444444',
              scopeType: 'user',
              scopeId: USER_ID,
            },
    },
    mcpCatalogEntry: { findFirst: async () => ({ authMethod, authConfig }) },
    mcpServerCredentialOverride: {
      findMany: async () => overrides,
      upsert: async (args: {
        create: {
          instanceId: string
          principalType: 'user'
          principalId: string
          credentialRef: string
        }
      }) => {
        const row = {
          id: 'override-1',
          ...args.create,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        overrides.splice(0, overrides.length, row)
        return row
      },
    },
  } as unknown as PrismaClient

  // Secret writes pass through the brute-force guard before touching prisma:
  // fake the limiter store (always under the limit) and the audit hash-chain
  // reads the lockout path would need.
  const rateLimitTx = {
    $executeRaw: async () => 0,
    auditLog: {
      create: async () => ({}),
      findFirst: async () => null,
    },
  }
  const rateLimiter = new RateLimiter(
    {
      $queryRaw: async () => [{ count: 1 }],
      $executeRaw: async () => 0,
      $transaction: async <T>(callback: (tx: typeof rateLimitTx) => Promise<T>) =>
        callback(rateLimitTx),
    } as unknown as PrismaClient,
    { error: () => {} },
  )
  const config = {
    api: {
      rateLimit: {
        mcpSecretWriteIp: { max: 100, windowMs: 60_000 },
        mcpSecretWriteAccount: { max: 100, windowMs: 60_000 },
      },
    },
  }

  const app = Fastify()
  registerMcpCredentialRoutes(app, {
    mcpSecretStore: {
      put: async ({ accessToken }) => {
        storedSecrets.push(accessToken)
        return 'secret_mcp_server_minted'
      },
    },
    oauthSecretStore: {} as never,
    prisma,
    config,
    rateLimiter,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    secretResolver: {} as never,
  })
  await app.ready()

  try {
    const rejected = await app.inject({
      method: 'PUT',
      url: `/api/mcp/instances/${INSTANCE_ID}/credentials`,
      payload: {
        principalType: 'user',
        principalId: USER_ID,
        credentialRef: 'NESSIE_AUTH_SECRET',
      },
    })
    assert.equal(rejected.statusCode, 400, rejected.body)
    assert.equal(storedSecrets.length, 0)

    const plaintext = 'caller-api-key'
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/mcp/instances/${INSTANCE_ID}/credentials`,
      payload: {
        principalType: 'user',
        principalId: USER_ID,
        secret: plaintext,
      },
    })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.deepEqual(storedSecrets, [plaintext])
    assert.equal(saved.body.includes(plaintext), false)
    assert.equal(saved.body.includes('secret_mcp_server_minted'), false)
    assert.equal('credentialRef' in saved.json().data, false)

    // The low-level route must validate the full auth contract before an API
    // key can be assigned to a shared principal. A method label alone cannot
    // turn a malformed or mismatched legacy row into a shared credential.
    authConfig = { method: 'bearer' }
    const invalidApiKeyForAgent = await app.inject({
      method: 'PUT',
      url: `/api/mcp/instances/${INSTANCE_ID}/credentials`,
      payload: {
        principalType: 'agent',
        principalId: '55555555-5555-4555-8555-555555555555',
        secret: 'mistyped-api-key',
      },
    })
    assert.equal(invalidApiKeyForAgent.statusCode, 403, invalidApiKeyForAgent.body)
    assert.equal(
      invalidApiKeyForAgent.json().error.code,
      'MCP_SHARED_CREDENTIAL_AUTH_FORBIDDEN',
    )
    assert.deepEqual(storedSecrets, [plaintext])

    // A raw OAuth token cannot be assigned to a shared principal by an owner;
    // OAuth completion is user-bound and the generic route has the same fence.
    authMethod = 'oauth2'
    authConfig = { method: 'oauth2' }
    const oauthForAgent = await app.inject({
      method: 'PUT',
      url: `/api/mcp/instances/${INSTANCE_ID}/credentials`,
      payload: {
        principalType: 'agent',
        principalId: '55555555-5555-4555-8555-555555555555',
        secret: 'personal-oauth-token',
      },
    })
    assert.equal(oauthForAgent.statusCode, 403, oauthForAgent.body)
    assert.equal(
      oauthForAgent.json().error.code,
      'MCP_PERSONAL_CREDENTIAL_PRINCIPAL_FORBIDDEN',
    )
    assert.deepEqual(storedSecrets, [plaintext])

    const listed = await app.inject({
      method: 'GET',
      url: `/api/mcp/instances/${INSTANCE_ID}/credentials`,
    })
    assert.equal(listed.statusCode, 200, listed.body)
    assert.equal(listed.body.includes('secret_mcp_server_minted'), false)
    assert.equal('credentialRef' in listed.json().data[0], false)
  } finally {
    await app.close()
  }
})
