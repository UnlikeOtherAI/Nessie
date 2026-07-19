import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDeepSignalMcpIdentityServiceFromEnv,
  DeepSignalMcpIdentityError,
} from '../src/deepsignal-mcp-identity.js'
import {
  deriveSecretKey,
  encryptWithKey,
} from '../src/secret-crypto.js'
import {
  appKey,
  attribution,
  claimsOf,
  delegationToken,
  env,
  linkedPrisma,
  verifyNessieSignature,
} from './deepsignal-mcp-identity-fixture.js'

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
    channel: linkedPrisma().channel,
    productAccountLink: {
      findUnique: async () => ({
        activeOrgId: null,
        activeTeamId: null,
        status: 'linked',
        uoaSub: 'uoa-user',
      }),
    },
    productTeamEnablement: {
      findUnique: async () => ({
        enabled: true,
        externalOrgId: 'uoa-org',
        externalTeamId: 'uoa-team',
      }),
    },
    productWebhookSecret: {
      findMany: async () => [],
    },
    team: {
      findFirst: async () => ({
        externalOrgId: 'uoa-org',
        externalWorkspaceId: 'uoa-team',
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

test('blocks disabled or mismatched originating teams before UOA exchange', async () => {
  let exchanges = 0
  const request = {
    audience: 'https://api.deepsignal.live',
    toolCallId: 'request-1:chat',
  }
  const disabled = createDeepSignalMcpIdentityServiceFromEnv(
    {
      ...linkedPrisma(),
      productTeamEnablement: {
        findUnique: async () => ({
          enabled: false,
          externalOrgId: 'uoa-org',
          externalTeamId: 'uoa-team',
        }),
      },
    } as never,
    env(),
    {
      fetchImpl: (async () => {
        exchanges += 1
        throw new Error('must not exchange')
      }) as typeof fetch,
    },
  )
  assert.ok(disabled)
  await assert.rejects(
    disabled.requestHeaders(attribution, request),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_TEAM_NOT_ENABLED',
  )

  const mismatched = createDeepSignalMcpIdentityServiceFromEnv(
    {
      ...linkedPrisma(),
      team: {
        findFirst: async () => ({
          externalOrgId: 'other-org',
          externalWorkspaceId: 'other-team',
        }),
      },
      productTeamEnablement: {
        findUnique: async () => ({
          enabled: true,
          externalOrgId: 'other-org',
          externalTeamId: 'other-team',
        }),
      },
      channel: {
        findFirst: async () => ({
          dmKey:
            `extagent:deepsignal:${attribution.organizationId}:${attribution.userId}:other-team`,
        }),
      },
    } as never,
    env(),
    {
      fetchImpl: (async () => {
        exchanges += 1
        throw new Error('must not exchange')
      }) as typeof fetch,
    },
  )
  assert.ok(mismatched)
  await assert.rejects(
    mismatched.requestHeaders(attribution, request),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_UOA_IDENTITY_REQUIRED',
  )

  const staleEnablement = createDeepSignalMcpIdentityServiceFromEnv(
    {
      ...linkedPrisma(),
      productTeamEnablement: {
        findUnique: async () => ({
          enabled: true,
          externalOrgId: 'uoa-org',
          externalTeamId: 'previous-uoa-team',
        }),
      },
    } as never,
    env(),
    {
      fetchImpl: (async () => {
        exchanges += 1
        throw new Error('must not exchange')
      }) as typeof fetch,
    },
  )
  assert.ok(staleEnablement)
  await assert.rejects(
    staleEnablement.requestHeaders(attribution, request),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_TEAM_NOT_ENABLED',
  )

  let checkedMembership = false
  const removedMember = createDeepSignalMcpIdentityServiceFromEnv(
    {
      ...linkedPrisma(),
      team: {
        findFirst: async (args: {
          where: { members?: { some: { userId: string } } }
        }) => {
          checkedMembership =
            args.where.members?.some.userId === attribution.userId
          return null
        },
      },
    } as never,
    env(),
    {
      fetchImpl: (async () => {
        exchanges += 1
        throw new Error('must not exchange')
      }) as typeof fetch,
    },
  )
  assert.ok(removedMember)
  await assert.rejects(
    removedMember.requestHeaders(attribution, request),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_TEAM_NOT_ENABLED',
  )
  assert.equal(checkedMembership, true)

  const legacyChannel = createDeepSignalMcpIdentityServiceFromEnv(
    {
      ...linkedPrisma(),
      channel: {
        findFirst: async () => ({
          dmKey:
            `extagent:deepsignal:${attribution.organizationId}:${attribution.userId}`,
        }),
      },
    } as never,
    env(),
    {
      fetchImpl: (async () => {
        exchanges += 1
        throw new Error('must not exchange')
      }) as typeof fetch,
    },
  )
  assert.ok(legacyChannel)
  await assert.rejects(
    legacyChannel.requestHeaders(attribution, request),
    (error: unknown) =>
      error instanceof DeepSignalMcpIdentityError
      && error.code === 'DEEPSIGNAL_MCP_CHANNEL_WORKSPACE_MISMATCH',
  )
  assert.equal(exchanges, 0)
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
