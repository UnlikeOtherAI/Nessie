import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  createLedgerIdentityService,
  LedgerIdentityError,
  loadLedgerIdentitySettings,
  type LedgerIdentitySettings,
} from '../src/ledger-identity.js'
import {
  attributionFromActorContext,
  type LedgerAttribution,
} from '../src/ledger.js'
import { completeLedgerAttribution } from '../src/ledger-attribution.js'

const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = keyPair.privateKey.export({
  format: 'pem',
  type: 'pkcs8',
}).toString()

const settings: LedgerIdentitySettings = {
  authBaseUrl: 'https://authentication.unlikeotherai.com',
  clientSecret: 'client-secret',
  configUrl: 'https://api.nessie.works/api/auth/sso/config',
  kid: 'nessie-test',
  ledgerAudience: 'https://ledger.unlikeotherai.com',
  privateKeyPem,
  sourceDomain: 'api.nessie.works',
}

const attribution: LedgerAttribution = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  teamId: '00000000-0000-4000-8000-000000000003',
  channelId: '00000000-0000-4000-8000-000000000004',
  threadId: '00000000-0000-4000-8000-000000000005',
  taskId: '00000000-0000-4000-8000-000000000006',
  runId: '00000000-0000-4000-8000-000000000007',
  agentId: '00000000-0000-4000-8000-000000000008',
  agentKind: 'personal_assistant',
  userId: '00000000-0000-4000-8000-000000000009',
  actorId: '00000000-0000-4000-8000-000000000008',
  actorType: 'agent',
  requestId: 'request-1',
  correlationId: 'correlation-1',
}

const decodeClaims = (token: string): Record<string, unknown> => {
  const payload = token.split('.')[1]
  assert.ok(payload)
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as
    Record<string, unknown>
}

const verifySignature = (token: string): boolean => {
  const [header, payload, signature] = token.split('.')
  assert.ok(header && payload && signature)
  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    keyPair.publicKey,
    Buffer.from(signature, 'base64url'),
  )
}

const delegationToken = (): string => {
  const claims = Buffer.from(JSON.stringify({ exp: 2_000_000_300 }))
    .toString('base64url')
  return `header.${claims}.signature`
}

test('signs Nessie context and exchanges a cached UOA delegation', async () => {
  const exchanges: Array<{ body: Record<string, unknown>; init: RequestInit; url: string }> = []
  const prisma = {
    productAccountLink: {
      findUnique: async () => ({
        activeOrgId: 'uoa-org',
        activeTeamId: 'uoa-team',
        status: 'linked',
        uoaSub: 'uoa-user',
      }),
    },
  }
  const service = createLedgerIdentityService({
    prisma: prisma as never,
    settings,
    now: () => 2_000_000_000_000,
    fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
      exchanges.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        init: init ?? {},
        url: input.toString(),
      })
      return new Response(JSON.stringify({
        access_token: delegationToken(),
        expires_in: 300,
      }))
    }) as typeof fetch,
  })

  const first = await service.requestHeaders(attribution, {
    requireUoaIdentity: true,
    toolCallId: 'tool-call-1',
  })
  const second = await service.requestHeaders(attribution, {
    requireUoaIdentity: true,
    toolCallId: 'tool-call-2',
  })

  assert.equal(exchanges.length, 1)
  assert.equal(first['X-UOA-Delegation'], delegationToken())
  assert.equal(second['X-UOA-Delegation'], delegationToken())

  const exchange = exchanges[0]!
  assert.equal(
    exchange.url,
    'https://authentication.unlikeotherai.com/auth/token'
      + '?config_url=https%3A%2F%2Fapi.nessie.works%2Fapi%2Fauth%2Fsso%2Fconfig',
  )
  assert.equal(exchange.body.grant_type, 'urn:ietf:params:oauth:grant-type:token-exchange')
  assert.equal(exchange.body.product, 'nessie')
  assert.equal(exchange.body.scope, 'ai.invoke')
  assert.equal(exchange.body.subject_token_type, 'urn:ietf:params:oauth:token-type:jwt')
  assert.equal(exchange.body.resource, settings.ledgerAudience)
  assert.equal('client_id' in exchange.body, false)
  assert.match(
    String(new Headers(exchange.init.headers).get('authorization')),
    /^Bearer [a-f0-9]{64}$/,
  )

  const assertion = String(exchange.body.subject_token)
  assert.equal(verifySignature(assertion), true)
  assert.deepEqual(decodeClaims(assertion), {
    iss: 'api.nessie.works',
    aud: 'https://authentication.unlikeotherai.com/auth/token',
    sub: 'uoa-user',
    source_domain: 'api.nessie.works',
    active: { orgId: 'uoa-org', teamId: 'uoa-team' },
    iat: 2_000_000_000,
    exp: 2_000_000_060,
    jti: decodeClaims(assertion).jti,
  })

  const context = first['X-Nessie-Context']
  assert.ok(context)
  assert.equal(verifySignature(context), true)
  assert.deepEqual(decodeClaims(context), {
    iss: 'https://api.nessie.works',
    aud: settings.ledgerAudience,
    sub: 'uoa-user',
    source_domain: 'api.nessie.works',
    user_id: attribution.userId,
    organization_id: attribution.organizationId,
    org_id: attribution.organizationId,
    project_id: attribution.projectId,
    team_id: attribution.teamId,
    channel_id: attribution.channelId,
    thread_id: attribution.threadId,
    task_id: attribution.taskId,
    run_id: attribution.runId,
    agent_id: attribution.agentId,
    agent_kind: attribution.agentKind,
    system_component: null,
    actor_id: attribution.actorId,
    request_id: attribution.requestId,
    correlation_id: attribution.correlationId,
    tool_call_id: 'tool-call-1',
    iat: 2_000_000_000,
    exp: 2_000_000_300,
    jti: decodeClaims(context).jti,
  })
})

test('requires a linked SSO subject for DeepWater', async () => {
  const service = createLedgerIdentityService({
    prisma: {
      productAccountLink: { findUnique: async () => null },
    } as never,
    settings,
  })

  await assert.rejects(
    service.requestHeaders(attribution, { requireUoaIdentity: true }),
    (error: unknown) =>
      error instanceof LedgerIdentityError
      && error.code === 'LEDGER_UOA_IDENTITY_REQUIRED',
  )
})

test('fails closed before signing when required Ledger attribution is absent', async () => {
  const service = createLedgerIdentityService({
    prisma: {
      productAccountLink: { findUnique: async () => null },
    } as never,
    settings,
  })

  await assert.rejects(
    service.requestHeaders({
      organizationId: attribution.organizationId,
      actorId: attribution.actorId,
      actorType: attribution.actorType,
    }),
    /user_id, team_id, agent_id, run_id attribution/,
  )
})

test('system completion produces stable named agent/run UUIDs', () => {
  const partial: LedgerAttribution = {
    agentKind: 'system',
    organizationId: attribution.organizationId,
    userId: attribution.userId,
    teamId: attribution.teamId,
    actorId: attribution.userId!,
    actorType: 'user',
    requestId: 'request-system-1',
    systemComponent: 'knowledge-summary',
    toolCallId: 'knowledge-summary:request-system-1',
  }
  const first = completeLedgerAttribution(partial)
  const second = completeLedgerAttribution(partial)

  assert.equal(first.agentId, '4f663a34-4b0e-5d1d-aaef-1711bff9a37c')
  assert.equal(first.runId, '67bb4365-ee60-5e6c-b314-efae2de758d3')
  assert.equal(first.agentId, second.agentId)
  assert.equal(first.runId, second.runId)
  assert.equal(first.agentKind, 'system')
  assert.equal(first.systemComponent, 'knowledge-summary')
  assert.equal(first.toolCallId, 'knowledge-summary:request-system-1')

  const changedRequest = completeLedgerAttribution({
    ...partial,
    requestId: 'request-system-2',
  })
  const changedComponent = completeLedgerAttribution({
    ...partial,
    systemComponent: 'memory-consolidation',
  })
  const changedTeam = completeLedgerAttribution({
    ...partial,
    teamId: '00000000-0000-4000-8000-00000000000a',
  })
  const changedUser = completeLedgerAttribution({
    ...partial,
    userId: '00000000-0000-4000-8000-00000000000b',
  })

  assert.equal(changedRequest.agentId, first.agentId)
  assert.notEqual(changedRequest.runId, first.runId)
  assert.notEqual(changedComponent.agentId, first.agentId)
  assert.notEqual(changedComponent.runId, first.runId)
  assert.notEqual(changedTeam.runId, first.runId)
  assert.notEqual(changedUser.runId, first.runId)
})

test('actor attribution only clears the action agent for named system work', () => {
  const actorContext = {
    actor: {
      actorId: attribution.userId!,
      actorType: 'user',
    },
    tenant: {
      organizationId: attribution.organizationId,
    },
    actionContext: {
      agentId: attribution.agentId!,
      requestId: 'request-team-fallback',
      teamId: attribution.teamId!,
    },
  } as never
  const ordinary = attributionFromActorContext(actorContext)
  const unlabelledNull = attributionFromActorContext(actorContext, {
    agentId: null,
  })
  const system = attributionFromActorContext(actorContext, {
    agentId: null,
    agentKind: 'system',
    systemComponent: 'memory-consolidation',
  })

  assert.equal(ordinary.teamId, attribution.teamId)
  assert.equal(ordinary.agentId, attribution.agentId)
  assert.equal(unlabelledNull.agentId, attribution.agentId)
  assert.equal(system.agentId, null)
  assert.equal(system.agentKind, 'system')
})

test('uses attribution tool-call identity when no explicit override is supplied', async () => {
  const service = createLedgerIdentityService({
    prisma: {
      productAccountLink: { findUnique: async () => null },
    } as never,
    settings,
    now: () => 2_000_000_000_000,
  })

  const headers = await service.requestHeaders({
    ...attribution,
    toolCallId: 'memory-consolidation:source-run:capture',
  })
  const context = headers['X-Nessie-Context']
  assert.ok(context)
  assert.equal(
    decodeClaims(context).tool_call_id,
    'memory-consolidation:source-run:capture',
  )
})

test('omits absent active workspace claims while still delegating the stable UOA user', async () => {
  let assertionClaims: Record<string, unknown> | null = null
  const service = createLedgerIdentityService({
    prisma: {
      productAccountLink: {
        findUnique: async () => ({
          activeOrgId: null,
          activeTeamId: null,
          status: 'linked',
          uoaSub: 'uoa-user',
        }),
      },
    } as never,
    settings,
    fetchImpl: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { subject_token: string }
      assertionClaims = decodeClaims(body.subject_token)
      return new Response(JSON.stringify({
        access_token: delegationToken(),
        expires_in: 300,
      }))
    }) as typeof fetch,
    now: () => 2_000_000_000_000,
  })

  const headers = await service.requestHeaders(
    attribution,
    { requireUoaIdentity: true },
  )
  assert.equal(headers['X-UOA-Delegation'], delegationToken())
  assert.ok(assertionClaims)
  assert.equal('active' in assertionClaims, false)
})

test('does not delegate a revoked product link', async () => {
  const service = createLedgerIdentityService({
    prisma: {
      productAccountLink: {
        findUnique: async () => ({
          activeOrgId: 'uoa-org',
          activeTeamId: 'uoa-team',
          status: 'revoked',
          uoaSub: 'uoa-user',
        }),
      },
    } as never,
    settings,
  })

  await assert.rejects(
    service.requestHeaders(attribution, { requireUoaIdentity: true }),
    (error: unknown) =>
      error instanceof LedgerIdentityError
      && error.code === 'LEDGER_UOA_IDENTITY_REQUIRED',
  )
})

test('requests and caches the exact billing.read delegation separately', async () => {
  const scopes: unknown[] = []
  const service = createLedgerIdentityService({
    prisma: {
      productAccountLink: {
        findUnique: async () => ({
          activeOrgId: 'uoa-org',
          activeTeamId: 'uoa-team',
          status: 'linked',
          uoaSub: 'uoa-user',
        }),
      },
    } as never,
    settings,
    fetchImpl: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      scopes.push(body.scope)
      return new Response(JSON.stringify({
        access_token: delegationToken(),
        expires_in: 300,
      }))
    }) as typeof fetch,
    now: () => 2_000_000_000_000,
  })

  await service.requestHeaders(attribution, {
    delegationScope: 'billing.read',
    requireUoaIdentity: true,
  })
  await service.requestHeaders(attribution, {
    delegationScope: 'billing.read',
    requireUoaIdentity: true,
  })
  await service.requestHeaders(attribution, {
    delegationScope: 'ai.invoke',
    requireUoaIdentity: true,
  })

  assert.deepEqual(scopes, ['billing.read', 'ai.invoke'])
})

test('loads existing UOA signing settings without introducing a client id', () => {
  const loaded = loadLedgerIdentitySettings({
    UOA_DOMAIN: settings.sourceDomain,
    UOA_CONFIG_URL: settings.configUrl,
    UOA_CONFIG_JWT_KID: settings.kid,
    UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(privateKeyPem).toString('base64'),
    UOA_CLIENT_SECRET: settings.clientSecret,
  })
  assert.equal(loaded?.ledgerAudience, settings.ledgerAudience)
  assert.equal('clientId' in (loaded ?? {}), false)
})
