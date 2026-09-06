import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerMcpCredentialRoutes } from '../src/routes/mcp/credentials.js'
import { RateLimiter } from '../src/services/rate-limit.js'

/**
 * Minting and deleting a stored MCP credential are privileged mutations that
 * wrote no audit row at all, while creating a secret or connecting an app two
 * routes away did. Both now emit — and the emission records the principal the
 * credential was attached to, never the credential and never its vault ref.
 */

const ORGANIZATION_ID = '55555555-5555-4555-8555-555555555551'
const USER_ID = '55555555-5555-4555-8555-555555555552'
const INSTANCE_ID = '55555555-5555-4555-8555-555555555553'
const CATALOG_ENTRY_ID = '55555555-5555-4555-8555-555555555554'
const SECRET = 'sk-live-do-not-log-this'

const actorContext: AuthorizedActionContext = {
  actor: { actorId: USER_ID, actorType: 'user', roles: ['owner'] },
  actionContext: { requestId: 'credential-audit-test' },
  tenant: { organizationId: ORGANIZATION_ID },
} as AuthorizedActionContext

type AuditRow = {
  action: string
  metadata?: Record<string, unknown> | undefined
  resourceId: string | null
  resourceType: string
}

const makeApp = () => {
  const audited: AuditRow[] = []
  const overrides = [
    {
      id: 'override-1',
      instanceId: INSTANCE_ID,
      principalType: 'user' as const,
      principalId: USER_ID,
      credentialRef: 'secret_ref_1',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ]
  const auditTx = {
    $executeRaw: async () => 0,
    auditLog: {
      findFirst: async () => null,
      create: async ({ data }: { data: AuditRow }) => {
        audited.push(data)
        return data
      },
    },
  }
  const prisma = {
    $transaction: async <T>(callback: (tx: typeof auditTx) => Promise<T>) => callback(auditTx),
    mcpServerInstance: {
      findFirst: async (args: { where: { catalogEntry?: unknown } }) =>
        args.where.catalogEntry
          ? null
          : {
              id: INSTANCE_ID,
              organizationId: ORGANIZATION_ID,
              catalogEntryId: CATALOG_ENTRY_ID,
              scopeType: 'user',
              scopeId: USER_ID,
            },
    },
    mcpCatalogEntry: {
      findFirst: async () => ({
        authMethod: 'api_key',
        authConfig: { method: 'api_key', headerName: 'X-API-Key', valuePrefix: '' },
      }),
    },
    mcpServerCredentialOverride: {
      findMany: async () => overrides,
      findUnique: async () => overrides[0]!,
      upsert: async () => overrides[0]!,
      delete: async () => overrides[0]!,
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerMcpCredentialRoutes(app, {
    prisma,
    config: {
      api: {
        rateLimit: {
          mcpSecretWriteIp: { max: 100, windowMs: 60_000 },
          mcpSecretWriteAccount: { max: 100, windowMs: 60_000 },
        },
      },
    } as never,
    rateLimiter: new RateLimiter(
      {
        $queryRaw: async () => [{ count: 1 }],
        $executeRaw: async () => 0,
        $transaction: async <T>(callback: (tx: typeof auditTx) => Promise<T>) => callback(auditTx),
      } as unknown as PrismaClient,
      { error: () => {} },
    ),
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    mcpSecretStore: { put: async () => 'secret_ref_1' },
    oauthSecretStore: {} as never,
  } as never)
  return { app, audited }
}

test('storing a credential override writes an audit row without the secret', async () => {
  const { app, audited } = makeApp()

  const response = await app.inject({
    method: 'PUT',
    url: `/api/mcp/instances/${INSTANCE_ID}/credentials`,
    payload: { principalType: 'user', principalId: USER_ID, secret: SECRET },
  })
  await app.close()

  assert.equal(response.statusCode, 200)
  assert.equal(audited.length, 1, 'a credential write is audited')
  const entry = audited[0]!
  assert.equal(entry.action, 'mcp.credential.written')
  assert.equal(entry.resourceType, 'mcp_instance')
  assert.equal(entry.resourceId, INSTANCE_ID)
  assert.deepEqual(entry.metadata, {
    overrideId: 'override-1',
    principalType: 'user',
    principalId: USER_ID,
  })
  assert.ok(
    !JSON.stringify(entry).includes(SECRET),
    'the credential itself never enters the audit chain',
  )
})

test('deleting a credential override is audited', async () => {
  const { app, audited } = makeApp()

  const response = await app.inject({
    method: 'DELETE',
    url: `/api/mcp/instances/${INSTANCE_ID}/credentials/user/${USER_ID}`,
  })
  await app.close()

  assert.equal(response.statusCode, 204)
  assert.equal(audited.length, 1)
  assert.equal(audited[0]!.action, 'mcp.credential.deleted')
  assert.deepEqual(audited[0]!.metadata, {
    principalType: 'user',
    principalId: USER_ID,
  })
})
