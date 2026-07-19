import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerMcpCredentialRoutes } from '../src/routes/mcp/credentials.js'

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
  const prisma = {
    mcpServerInstance: {
      findFirst: async (args: { where: { catalogEntry?: unknown } }) =>
        args.where.catalogEntry
          ? null
          : {
              id: INSTANCE_ID,
              organizationId: ORGANIZATION_ID,
              scopeType: 'user',
              scopeId: USER_ID,
            },
    },
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
