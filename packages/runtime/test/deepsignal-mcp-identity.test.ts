import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  createDeepSignalMcpIdentityServiceFromEnv,
  DeepSignalMcpIdentityError,
} from '../src/deepsignal-mcp-identity.js'
import type { LedgerAttribution } from '../src/ledger.js'
import {
  deriveSecretKey,
  encryptWithKey,
} from '../src/secret-crypto.js'

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = keys.privateKey.export({
  format: 'pem',
  type: 'pkcs8',
}).toString()
const appKey = `dsk_${'n'.repeat(32)}`

const env = (
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
  DEEPSIGNAL_MCP_APP_KEY: appKey,
  NESSIE_MODE: 'selfHosted',
  UOA_BASE_URL: 'https://authentication.unlikeotherai.com',
  UOA_CLIENT_SECRET: 'uoa-client-secret',
  UOA_CONFIG_JWT_KID: 'nessie-test',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64:
    Buffer.from(privateKeyPem).toString('base64'),
  UOA_CONFIG_URL: 'https://api.nessie.works/api/auth/sso/config',
  UOA_DOMAIN: 'api.nessie.works',
  ...overrides,
})

const attribution: LedgerAttribution = {
  actorId: '00000000-0000-4000-8000-000000000009',
  actorType: 'user',
  agentId: '00000000-0000-4000-8000-000000000008',
  agentKind: 'shared',
  channelId: '00000000-0000-4000-8000-000000000004',
  correlationId: 'correlation-1',
  organizationId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  requestId: 'request-1',
  runId: '00000000-0000-4000-8000-000000000007',
  teamId: '00000000-0000-4000-8000-000000000003',
  threadId: '00000000-0000-4000-8000-000000000005',
  userId: '00000000-0000-4000-8000-000000000009',
}

const claimsOf = (token: string): Record<string, unknown> => {
  const payload = token.split('.')[1]
  assert.ok(payload)
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as
    Record<string, unknown>
}

const verifyNessieSignature = (token: string): boolean => {
  const [header, payload, signature] = token.split('.')
  assert.ok(header && payload && signature)
  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    keys.publicKey,
    Buffer.from(signature, 'base64url'),
  )
}

const delegationToken = (): string => {
  const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_300 }))
    .toString('base64url')
  return `header.${payload}.signature`
}

const linkedPrisma = (onLookup?: (productSlug: string) => void) => ({
  productAccountLink: {
    findUnique: async (args: {
      where: {
        organizationId_userId_productSlug: { productSlug: string }
      }
    }) => {
      onLookup?.(
        args.where.organizationId_userId_productSlug.productSlug,
      )
      return {
        activeOrgId: 'uoa-org',
        activeTeamId: 'uoa-team',
        status: 'linked',
        uoaSub: 'uoa-user',
      }
    },
  },
  productWebhookSecret: {
    findMany: async () => [],
  },
})

test('hosted modes fail at startup without a valid dedicated dsk key', () => {
  assert.throws(
    () =>
      createDeepSignalMcpIdentityServiceFromEnv(
        linkedPrisma() as never,
        env({ DEEPSIGNAL_MCP_APP_KEY: undefined }),
      ),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_APP_KEY_REQUIRED',
  )
  assert.throws(
    () =>
      createDeepSignalMcpIdentityServiceFromEnv(
        linkedPrisma() as never,
        env({ DEEPSIGNAL_MCP_APP_KEY: 'dsk_short' }),
      ),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_APP_KEY_INVALID',
  )
})

test('DeepSignal rejects reuse of every configured secret-bearing credential', () => {
  const reservedNames = [
    'LEDGER_PROXY_TOKEN',
    'LEDGER_BILLING_READ_APP_KEY_NESSIE',
    'NESSIE_MODEL_API_KEY',
    'UOA_CLIENT_SECRET',
    'NESSIE_AUTH_SECRET',
    'UOA_CONFIG_JWT_PRIVATE_KEY_B64',
    'DEEPSIGNAL_WEBHOOK_SIGNING_SECRET',
    'NESSIE_DB_PASSWORD',
    'DATABASE_URL',
    'SMTP_PASSWORD',
    'ADMIN_API_TOKEN',
    'NESSIE_GITHUB_TOKEN',
    'NESSIE_STORAGE_SECRET_ACCESS_KEY',
    'SERPER_API_KEY',
    'GATEWAY_API_KEY',
    'PUSH_APNS_P8',
    'PUSH_FCM_SERVICE_ACCOUNT',
  ]
  for (const name of reservedNames) {
    assert.throws(
      () =>
        createDeepSignalMcpIdentityServiceFromEnv(
          linkedPrisma() as never,
          env({ [name]: appKey }),
        ),
      (error: unknown) =>
        error instanceof DeepSignalMcpIdentityError
        && error.code === 'DEEPSIGNAL_MCP_APP_KEY_REUSED',
      name,
    )
  }
})

test('credential separation decodes URL userinfo and plural key collections', () => {
  const reusedShapes: NodeJS.ProcessEnv[] = [
    {
      DATABASE_URL:
        `postgresql://nessie:${encodeURIComponent(appKey)}@db.internal/nessie`,
    },
    {
      REDIS_URL:
        `redis://:${encodeURIComponent(appKey)}@redis.internal:6379/0`,
    },
    {
      ADMIN_API_KEYS: `unrelated-key, ${appKey}`,
    },
    {
      EMAIL_TOKENS: JSON.stringify(['unrelated-token', appKey]),
    },
  ]
  for (const reuse of reusedShapes) {
    assert.throws(
      () =>
        createDeepSignalMcpIdentityServiceFromEnv(
          linkedPrisma() as never,
          env(reuse),
        ),
      (error: unknown) =>
        error instanceof DeepSignalMcpIdentityError
        && error.code === 'DEEPSIGNAL_MCP_APP_KEY_REUSED',
      JSON.stringify(reuse),
    )
  }
})

test('startup validation rejects app-key reuse with an existing encrypted webhook secret', async () => {
  const authSecret = 'nessie-auth-secret'
  const encrypted = encryptWithKey(deriveSecretKey(authSecret), appKey)
  const prisma = {
    ...linkedPrisma(),
    productWebhookSecret: {
      findMany: async () => [encrypted],
    },
  }
  const service = createDeepSignalMcpIdentityServiceFromEnv(
    prisma as never,
    env({ NESSIE_AUTH_SECRET: authSecret }),
  )
  assert.ok(service)
  await assert.rejects(
    service.validateStoredCredentialSeparation(),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_APP_KEY_REUSED',
  )
})

test('hosted modes fail when UOA signing/exchange identity is incomplete', () => {
  assert.throws(
    () =>
      createDeepSignalMcpIdentityServiceFromEnv(
        linkedPrisma() as never,
        env({ UOA_CLIENT_SECRET: undefined }),
      ),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_IDENTITY_UNCONFIGURED',
  )
  assert.equal(
    createDeepSignalMcpIdentityServiceFromEnv(
      linkedPrisma() as never,
      { NESSIE_MODE: 'local' },
    ),
    null,
  )
})

test('mints exact DeepSignal delegation and fresh signed request provenance', async () => {
  const exchanges: Array<Record<string, unknown>> = []
  const lookedUpProducts: string[] = []
  const service = createDeepSignalMcpIdentityServiceFromEnv(
    linkedPrisma((slug) => lookedUpProducts.push(slug)) as never,
    env(),
    {
      now: () => 2_000_000_000_000,
      fetchImpl: (async (_input, init) => {
        exchanges.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        )
        return new Response(JSON.stringify({
          access_token: delegationToken(),
          expires_in: 300,
        }))
      }) as typeof fetch,
    },
  )
  assert.ok(service)
  assert.equal(service.credentialRef, 'DEEPSIGNAL_MCP_APP_KEY')

  const first = await service.requestHeaders(attribution, {
    audience: 'https://api.deepsignal.live/mcp',
    toolCallId: 'request-1:chat',
  })
  const second = await service.requestHeaders(attribution, {
    audience: 'https://api.deepsignal.live/mcp',
    toolCallId: 'request-1:conversation_history',
  })

  assert.deepEqual(lookedUpProducts, ['deepsignal', 'deepsignal'])
  assert.equal(exchanges.length, 1)
  assert.equal('Authorization' in first, false)
  assert.equal(first['X-UOA-Delegation'], delegationToken())
  assert.equal(second['X-UOA-Delegation'], delegationToken())
  assert.deepEqual(
    {
      product: exchanges[0]?.product,
      resource: exchanges[0]?.resource,
      scope: exchanges[0]?.scope,
    },
    {
      product: 'nessie',
      resource: 'https://api.deepsignal.live',
      scope: 'ai.invoke',
    },
  )

  const subjectAssertion = String(exchanges[0]?.subject_token)
  assert.equal(verifyNessieSignature(subjectAssertion), true)
  assert.deepEqual(claimsOf(subjectAssertion).active, {
    orgId: 'uoa-org',
    teamId: 'uoa-team',
  })

  const firstContext = first['X-Nessie-Context']
  const secondContext = second['X-Nessie-Context']
  assert.ok(firstContext && secondContext)
  assert.equal(verifyNessieSignature(firstContext), true)
  const firstClaims = claimsOf(firstContext)
  const secondClaims = claimsOf(secondContext)
  assert.equal(firstClaims.aud, 'https://api.deepsignal.live')
  assert.equal(firstClaims.sub, 'uoa-user')
  assert.equal(firstClaims.user_id, attribution.userId)
  assert.equal(firstClaims.organization_id, attribution.organizationId)
  assert.equal(firstClaims.team_id, attribution.teamId)
  assert.equal(firstClaims.agent_id, attribution.agentId)
  assert.equal(firstClaims.run_id, attribution.runId)
  assert.equal(firstClaims.request_id, attribution.requestId)
  assert.equal(firstClaims.tool_call_id, 'request-1:chat')
  assert.equal(firstClaims.exp, 2_000_000_300)
  assert.notEqual(firstClaims.jti, secondClaims.jti)
  assert.equal(
    secondClaims.tool_call_id,
    'request-1:conversation_history',
  )
})

test('fails before exchange when active UOA workspace or provenance is absent', async () => {
  const noWorkspace = {
    productAccountLink: {
      findUnique: async () => ({
        activeOrgId: null,
        activeTeamId: null,
        status: 'linked',
        uoaSub: 'uoa-user',
      }),
    },
  }
  const service = createDeepSignalMcpIdentityServiceFromEnv(
    noWorkspace as never,
    env(),
  )
  assert.ok(service)

  await assert.rejects(
    service.requestHeaders(attribution, {
      audience: 'https://api.deepsignal.live',
      toolCallId: 'request-1:chat',
    }),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_UOA_IDENTITY_REQUIRED',
  )
  await assert.rejects(
    service.requestHeaders(
      { ...attribution, requestId: null },
      {
        audience: 'https://api.deepsignal.live',
        toolCallId: 'request-1:chat',
      },
    ),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_PROVENANCE_REQUIRED',
  )
})

test('refuses to sign a DeepSignal app-key call for any other origin', async () => {
  let exchangeCount = 0
  const service = createDeepSignalMcpIdentityServiceFromEnv(
    linkedPrisma() as never,
    env(),
    {
      fetchImpl: (async () => {
        exchangeCount += 1
        throw new Error('exchange must not run')
      }) as typeof fetch,
    },
  )
  assert.ok(service)

  await assert.rejects(
    service.requestHeaders(attribution, {
      audience: 'https://attacker.invalid/mcp',
      toolCallId: 'request-1:chat',
    }),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_ORIGIN_INVALID',
  )
  assert.equal(exchangeCount, 0)
})
