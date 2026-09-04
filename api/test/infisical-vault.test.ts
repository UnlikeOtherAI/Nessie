import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'
import { registerSecretRoutes } from '../src/routes/secrets.js'
import {
  InfisicalVault,
  InfisicalVaultError,
  infisicalSecretPath,
  type InfisicalSecretNamespace,
} from '../src/services/infisical-vault.js'
const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_ORGANIZATION_ID = '10000000-0000-4000-8000-000000000002'
const USER_ID = '20000000-0000-4000-8000-000000000001'
const OTHER_USER_ID = '20000000-0000-4000-8000-000000000002'
const TEAM_ID = '30000000-0000-4000-8000-000000000001'
const PROJECT_ID = '40000000-0000-4000-8000-000000000001'
const SECRET_ID = '50000000-0000-4000-8000-000000000001'
const OPAQUE_VAULT_NAME = 'NESSIE_SEC_0123456789ABCDEF0123456789ABCDEF'
const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'infisical-vault-route-test' },
  actor: { actorId: USER_ID, actorType: 'user', roles: ['owner'] },
  tenant: { organizationId: ORGANIZATION_ID },
}
type InfisicalEnvironment = Record<
  'INFISICAL_API_URL' | 'INFISICAL_ENVIRONMENT' | 'INFISICAL_PROJECT_ID' | 'INFISICAL_SERVICE_TOKEN' | 'INFISICAL_SERVICE_TOKEN_FILE',
  string | undefined
>

const infisicalEnvironment: InfisicalEnvironment = {
  INFISICAL_API_URL: 'https://8.8.8.8',
  INFISICAL_ENVIRONMENT: 'prod',
  INFISICAL_PROJECT_ID: 'vault-project',
  INFISICAL_SERVICE_TOKEN: 'test-service-token',
  INFISICAL_SERVICE_TOKEN_FILE: undefined,
}
const infisicalEnvironmentKeys = Object.keys(infisicalEnvironment) as Array<keyof InfisicalEnvironment>
type VaultRequest = {
  method: string
  path: string
  payload: Record<string, unknown>
}

const withInfisicalEnvironment = async <T>(
  values: InfisicalEnvironment,
  callback: () => Promise<T>,
): Promise<T> => {
  const originals = new Map(
    infisicalEnvironmentKeys.map((key) => [key, process.env[key]]),
  )
  for (const key of infisicalEnvironmentKeys) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await callback()
  } finally {
    for (const key of infisicalEnvironmentKeys) {
      const value = originals.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const withCapturedFetch = async <T>(
  callback: (requests: VaultRequest[]) => Promise<T>,
  respond: (request: VaultRequest) => Response | Promise<Response> = () => new Response(null, { status: 200 }),
): Promise<T> => {
  const originalFetch = globalThis.fetch
  const requests: VaultRequest[] = []
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof URL
      ? input
      : input instanceof Request
        ? new URL(input.url)
        : new URL(input)
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON vault request body.')
    const request = {
      method: init.method ?? 'GET',
      path: url.pathname,
      payload: JSON.parse(init.body) as Record<string, unknown>,
    }
    requests.push(request)
    return respond(request)
  }) as typeof fetch
  try {
    return await callback(requests)
  } finally {
    globalThis.fetch = originalFetch
  }
}

const expectedFolders = (namespace: InfisicalSecretNamespace) => [
  { environment: 'prod', name: 'nessie', path: '/', projectId: 'vault-project' },
  { environment: 'prod', name: namespace.organizationId, path: '/nessie', projectId: 'vault-project' },
  {
    environment: 'prod',
    name: namespace.scopeType,
    path: `/nessie/${namespace.organizationId}`,
    projectId: 'vault-project',
  },
  {
    environment: 'prod',
    name: namespace.scopeId,
    path: `/nessie/${namespace.organizationId}/${namespace.scopeType}`,
    projectId: 'vault-project',
  },
]

type StoredSecret = {
  captureFingerprint: string | null
  createdAt: Date
  createdById: string
  description: string | null
  expiresAt: Date | null
  id: string
  name: string
  organizationId: string
  provider: string | null
  reference: string
  rotatedAt: Date | null
  scopeId: string
  scopeType: InfisicalSecretNamespace['scopeType']
  status: 'active' | 'revoked'
  updatedAt: Date
  vaultReference: string
}

const makeSecretRouteApp = () => {
  let stored: StoredSecret | null = null
  const secret = {
      create: async ({ data }: { data: Omit<StoredSecret, 'createdAt' | 'id' | 'rotatedAt' | 'status' | 'updatedAt'> }) => {
        const now = new Date('2026-08-31T12:00:00.000Z')
        stored = {
          ...data,
          captureFingerprint: data.captureFingerprint ?? null,
          createdAt: now,
          description: data.description ?? null,
          expiresAt: data.expiresAt ?? null,
          id: SECRET_ID,
          provider: data.provider ?? null,
          rotatedAt: null,
          status: 'active',
          updatedAt: now,
        }
        return stored
      },
      findFirst: async ({ where }: { where: { organizationId: string; reference: string } }) =>
        stored?.organizationId === where.organizationId && stored.reference === where.reference
          ? stored
          : null,
      findUnique: async ({ where }: { where: { reference: string } }) => stored?.reference === where.reference ? stored : null,
      update: async ({
        data,
        where,
      }: {
        data: Partial<Pick<StoredSecret, 'rotatedAt' | 'status'>>
        where: { id: string }
      }) => {
        assert.equal(where.id, SECRET_ID)
        assert.ok(stored)
        stored = { ...stored, ...data, updatedAt: new Date('2026-08-31T12:01:00.000Z') }
        return stored
      },
  }
  const transactionClient = {
    $executeRaw: async () => 0,
    auditLog: { create: async () => ({}), findFirst: async () => null },
    secret,
  }
  const prisma = {
    $transaction: async <T>(callback: (tx: typeof transactionClient) => Promise<T>) =>
      callback(transactionClient),
    secret,
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerSecretRoutes(app, {
    authSecret: 'infisical-route-test-secret',
    prisma,
    requireActorContext: () => actorContext,
  } as unknown as Parameters<typeof registerSecretRoutes>[1])

  return { app, stored: () => stored }
}

test('Infisical paths partition every secret scope by stable IDs', () => {
  const namespaces: InfisicalSecretNamespace[] = [
    { organizationId: ORGANIZATION_ID, scopeId: USER_ID, scopeType: 'personal' },
    { organizationId: ORGANIZATION_ID, scopeId: TEAM_ID, scopeType: 'team' },
    { organizationId: ORGANIZATION_ID, scopeId: PROJECT_ID, scopeType: 'project' },
    { organizationId: ORGANIZATION_ID, scopeId: ORGANIZATION_ID, scopeType: 'team' },
  ]

  assert.deepEqual(
    namespaces.map(infisicalSecretPath),
    [
      `/nessie/${ORGANIZATION_ID}/personal/${USER_ID}`,
      `/nessie/${ORGANIZATION_ID}/team/${TEAM_ID}`,
      `/nessie/${ORGANIZATION_ID}/project/${PROJECT_ID}`,
      `/nessie/${ORGANIZATION_ID}/team/${ORGANIZATION_ID}`,
    ],
  )
})

test('the same opaque vault name is isolated across namespaces', async () => {
  await withCapturedFetch(async (requests) => {
    const vault = new InfisicalVault(infisicalEnvironment)
    const firstNamespace: InfisicalSecretNamespace = {
      organizationId: ORGANIZATION_ID,
      scopeId: USER_ID,
      scopeType: 'personal',
    }
    const secondNamespace: InfisicalSecretNamespace = {
      organizationId: OTHER_ORGANIZATION_ID,
      scopeId: OTHER_USER_ID,
      scopeType: 'personal',
    }
    await vault.put({
      name: OPAQUE_VAULT_NAME,
      namespace: firstNamespace,
      value: 'first-secret-value',
    })
    await vault.put({
      name: OPAQUE_VAULT_NAME,
      namespace: secondNamespace,
      value: 'second-secret-value',
    })

    assert.deepEqual(
      requests.map((request) => request.path === '/api/v2/folders'
        ? { method: request.method, path: request.path, payload: request.payload }
        : { method: request.method, path: request.path, secretPath: request.payload['secretPath'] }),
      [
        ...expectedFolders(firstNamespace).map((payload) => ({
          method: 'POST', path: '/api/v2/folders', payload,
        })),
        {
          method: 'POST',
          path: `/api/v4/secrets/${OPAQUE_VAULT_NAME}`,
          secretPath: infisicalSecretPath(firstNamespace),
        },
        ...expectedFolders(secondNamespace).map((payload) => ({
          method: 'POST', path: '/api/v2/folders', payload,
        })),
        {
          method: 'POST',
          path: `/api/v4/secrets/${OPAQUE_VAULT_NAME}`,
          secretPath: infisicalSecretPath(secondNamespace),
        },
      ],
    )
  })
})

test('concurrent first writes tolerate exact folder conflicts but not other folder failures', async () => {
  const namespace: InfisicalSecretNamespace = {
    organizationId: ORGANIZATION_ID,
    scopeId: USER_ID,
    scopeType: 'personal',
  }
  await withCapturedFetch(async (requests) => {
    const vault = new InfisicalVault(infisicalEnvironment)
    await Promise.all([
      vault.put({ name: `${OPAQUE_VAULT_NAME}_ONE`, namespace, value: 'first-secret-value' }),
      vault.put({ name: `${OPAQUE_VAULT_NAME}_TWO`, namespace, value: 'second-secret-value' }),
    ])

    const folderRequests = requests.filter((request) => request.path === '/api/v2/folders')
    assert.equal(folderRequests.length, 8)
    assert.equal(requests.filter((request) => request.path.startsWith('/api/v4/secrets/')).length, 2)
  }, (request) => request.path === '/api/v2/folders'
    ? Response.json({
      message: `Folder with name '${String(request.payload['name'])}' already exists in path '${String(request.payload['path'])}'`,
    }, { status: 400 })
    : new Response(null, { status: 200 }))

  await withCapturedFetch(async (requests) => {
    const vault = new InfisicalVault(infisicalEnvironment)
    await assert.rejects(
      vault.put({ name: OPAQUE_VAULT_NAME, namespace, value: 'must-not-be-written' }),
      (error: unknown) => error instanceof InfisicalVaultError && error.code === 'UNAVAILABLE',
    )
    assert.deepEqual(requests.map((request) => request.path), ['/api/v2/folders'])
  }, () => Response.json({ message: 'A different bad request' }, { status: 400 }))

  await withCapturedFetch(async (requests) => {
    const vault = new InfisicalVault(infisicalEnvironment)
    await assert.rejects(
      vault.put({ name: OPAQUE_VAULT_NAME, namespace, value: 'must-not-be-written' }),
      (error: unknown) => error instanceof InfisicalVaultError && error.code === 'UNAVAILABLE',
    )
    assert.deepEqual(requests.map((request) => request.path), ['/api/v2/folders'])
  }, () => new Response(null, { status: 403 }))
})

test('POST /api/secrets translates an Infisical constructor error into SECRETS_NOT_CONFIGURED', async () => {
  const { app } = makeSecretRouteApp()
  try {
    await withInfisicalEnvironment({
      INFISICAL_API_URL: undefined,
      INFISICAL_ENVIRONMENT: undefined,
      INFISICAL_PROJECT_ID: undefined,
      INFISICAL_SERVICE_TOKEN: undefined,
      INFISICAL_SERVICE_TOKEN_FILE: undefined,
    }, async () => {
      const secretValue = 'must-not-appear-in-the-response'
      const response = await app.inject({
        method: 'POST',
        payload: { name: 'API_TOKEN', scopeType: 'personal', value: secretValue },
        url: '/api/secrets',
      })

      assert.equal(response.statusCode, 503, response.body)
      assert.deepEqual(response.json().error, {
        code: 'SECRETS_NOT_CONFIGURED',
        message: 'Secrets are not configured for this deployment.',
      })
      assert.equal(response.body.includes(secretValue), false)
    })
  } finally {
    await app.close()
  }
})

test('POST /api/secrets refuses to duplicate the raw value into durable metadata', async () => {
  const { app, stored } = makeSecretRouteApp()
  try {
    const secretValue = 'opaque-credential-value'
    const response = await app.inject({
      method: 'POST',
      payload: {
        description: `Copied value: ${secretValue}`,
        name: 'API_TOKEN',
        scopeType: 'personal',
        value: secretValue,
      },
      url: '/api/secrets',
    })

    assert.equal(response.statusCode, 422, response.body)
    assert.equal(response.json().error.code, 'SECRET_METADATA_REJECTED')
    assert.equal(response.body.includes(secretValue), false)
    assert.equal(stored(), null)
  } finally {
    await app.close()
  }
})

test('POST /api/secrets compares trimmed values before accepting metadata', async () => {
  const { app, stored } = makeSecretRouteApp()
  try {
    const response = await app.inject({
      method: 'POST',
      payload: { name: 'SHORT_PASSWORD', provider: 'hunter2', scopeType: 'personal', value: ' hunter2 ' },
      url: '/api/secrets',
    })

    assert.equal(response.statusCode, 422, response.body)
    assert.equal(response.json().error.code, 'SECRET_METADATA_REJECTED')
    assert.equal(stored(), null)
  } finally {
    await app.close()
  }
})

test('POST /api/secrets translates a vault transport failure without exposing its secret', async () => {
  const { app } = makeSecretRouteApp()
  try {
    await withInfisicalEnvironment(infisicalEnvironment, async () => {
      await withCapturedFetch(async () => {
        const secretValue = 'must-not-appear-after-a-transport-failure'
        const response = await app.inject({
          method: 'POST',
          payload: { name: 'API_TOKEN', scopeType: 'personal', value: secretValue },
          url: '/api/secrets',
        })

        assert.equal(response.statusCode, 502, response.body)
        assert.deepEqual(response.json().error, {
          code: 'VAULT_UNAVAILABLE',
          message: 'The vault could not complete this operation.',
        })
        assert.equal(response.body.includes(secretValue), false)
      }, async () => {
        throw new Error('simulated DNS/TLS failure')
      })
    })
  } finally {
    await app.close()
  }
})

test('create, rotate, and revoke use one namespace and persist its exact vault reference', async () => {
  const { app, stored } = makeSecretRouteApp()
  try {
    await withInfisicalEnvironment(infisicalEnvironment, async () => {
      await withCapturedFetch(async (requests) => {
        const initialValue = 'initial-secret-value'
        const created = await app.inject({
          method: 'POST',
          payload: { name: 'API_TOKEN', scopeType: 'personal', value: initialValue },
          url: '/api/secrets',
        })
        assert.equal(created.statusCode, 201, created.body)
        assert.equal(created.body.includes(initialValue), false)

        const reference = created.json().data.reference as string
        assert.match(reference, /^sec_[0-9a-f]{32}$/)
        const expectedPath = `/nessie/${ORGANIZATION_ID}/personal/${USER_ID}`
        assert.equal(
          stored()?.vaultReference,
          `infisical://vault-project/prod${expectedPath}/NESSIE_${reference.slice(4).toUpperCase()}`,
        )
        assert.equal(created.body.includes(stored()?.vaultReference ?? ''), false)

        const rotatedValue = 'rotated-secret-value'
        const rotated = await app.inject({
          method: 'POST',
          payload: { value: rotatedValue },
          url: `/api/secrets/${reference}/rotate`,
        })
        assert.equal(rotated.statusCode, 200, rotated.body)
        assert.equal(rotated.body.includes(rotatedValue), false)

        const revoked = await app.inject({
          method: 'POST',
          payload: {},
          url: `/api/secrets/${reference}/revoke`,
        })
        assert.equal(revoked.statusCode, 200, revoked.body)

        assert.deepEqual(
          requests.map((request) => request.path),
          [
            '/api/v2/folders',
            '/api/v2/folders',
            '/api/v2/folders',
            '/api/v2/folders',
            `/api/v4/secrets/NESSIE_${reference.slice(4).toUpperCase()}`,
            `/api/v4/secrets/NESSIE_${reference.slice(4).toUpperCase()}`,
            `/api/v4/secrets/NESSIE_${reference.slice(4).toUpperCase()}`,
          ],
        )
        assert.deepEqual(
          requests.slice(0, 4).map((request) => request.payload),
          expectedFolders({ organizationId: ORGANIZATION_ID, scopeId: USER_ID, scopeType: 'personal' }),
        )
        assert.deepEqual(
          requests.slice(4).map((request) => ({
            method: request.method,
            path: request.payload['secretPath'],
          })),
          [
            { method: 'POST', path: expectedPath },
            { method: 'PATCH', path: expectedPath },
            { method: 'DELETE', path: expectedPath },
          ],
        )
      })
    })
  } finally {
    await app.close()
  }
})

test('a retried capture id returns the first secret without writing the vault twice', async () => {
  const { app } = makeSecretRouteApp()
  try {
    await withInfisicalEnvironment(infisicalEnvironment, async () => {
      await withCapturedFetch(async (requests) => {
        const request = {
          headers: { 'idempotency-key': 'capture-request-123' }, method: 'POST' as const,
          payload: {
            name: 'RETRY_TOKEN',
            scopeType: 'personal',
            value: 'initial-secret-value',
          },
          url: '/api/secrets',
        }
        const first = await app.inject(request)
        const retry = await app.inject(request)
        const conflict = await app.inject({
          ...request, payload: { ...request.payload, value: 'changed-secret-value' },
        })

        assert.equal(first.statusCode, 201, first.body)
        assert.equal(retry.statusCode, 200, retry.body)
        assert.equal(conflict.statusCode, 409, conflict.body)
        assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT')
        assert.equal(first.json().data.reference, retry.json().data.reference)
        assert.equal(requests.filter((entry) => entry.path.startsWith('/api/v4/secrets/')).length, 1)
      })
    })
  } finally {
    await app.close()
  }
})
