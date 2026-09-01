import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  createLedgerIdentityService,
  LedgerIdentityError,
  type LedgerIdentitySettings,
} from '../src/ledger-identity.js'
import type { LedgerAttribution } from '../src/ledger.js'

const privateKeyPem = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
}).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

const settings: LedgerIdentitySettings = {
  authBaseUrl: 'https://authentication.unlikeotherai.com',
  clientSecret: 'client-secret',
  configUrl: 'https://api.nessie.works/api/auth/sso/config',
  kid: 'nessie-test',
  ledgerAudience: 'https://ledger.unlikeotherai.com',
  privateKeyPem,
  sourceDomain: 'api.nessie.works',
}

const attribution = {
  actorId: '00000000-0000-4000-8000-000000000008',
  actorType: 'agent',
  agentId: '00000000-0000-4000-8000-000000000008',
  organizationId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000007',
  teamId: '00000000-0000-4000-8000-000000000003',
  userId: '00000000-0000-4000-8000-000000000009',
  uoaIdentity: {
    organizationId: 'uoa-org',
    subject: 'uoa-user',
    teamId: 'uoa-team',
    tokenVersion: 7,
  },
} satisfies LedgerAttribution

const delegationToken = (tokenVersion: number | null = 7): string => {
  const payload = Buffer.from(JSON.stringify({
    exp: 2_000_000_300,
    ...(tokenVersion === null ? {} : { tv: tokenVersion }),
  })).toString('base64url')
  return `header.${payload}.signature`
}

const linkedPrisma = (tokenVersion = 7) => ({
  productAccountLink: {
    findUnique: async () => ({
      activeOrgId: 'uoa-org',
      activeTeamId: 'uoa-team',
      status: 'linked',
      uoaSub: 'uoa-user',
      uoaTokenVersion: tokenVersion,
    }),
  },
  team: {
    findFirst: async () => ({
      externalOrgId: 'uoa-org',
      externalWorkspaceId: 'uoa-team',
    }),
  },
})

test('requests and caches each exact delegation scope separately', async () => {
  const scopes: unknown[] = []
  const service = createLedgerIdentityService({
    prisma: linkedPrisma() as never,
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

test('does not rebind an old session from a newer mutable link', async () => {
  const service = createLedgerIdentityService({
    prisma: linkedPrisma(8) as never,
    settings,
  })
  await assert.rejects(
    service.requestHeaders(attribution, { requireUoaIdentity: true }),
    (error: unknown) =>
      error instanceof LedgerIdentityError
      && error.code === 'LEDGER_UOA_IDENTITY_REQUIRED',
  )
})

test('rejects a returned delegation with a missing or different epoch', async () => {
  for (const tokenVersion of [null, 8]) {
    const service = createLedgerIdentityService({
      prisma: linkedPrisma() as never,
      settings,
      fetchImpl: (async () => new Response(JSON.stringify({
        access_token: delegationToken(tokenVersion),
        expires_in: 300,
      }))) as typeof fetch,
    })
    await assert.rejects(
      service.requestHeaders(attribution, { requireUoaIdentity: true }),
      (error: unknown) =>
        error instanceof LedgerIdentityError
        && error.code === 'LEDGER_UOA_TOKEN_EXCHANGE_FAILED',
    )
  }
})
