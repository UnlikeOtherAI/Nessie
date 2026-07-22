import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import type { LedgerAttribution } from '../src/ledger.js'

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = keys.privateKey.export({
  format: 'pem',
  type: 'pkcs8',
}).toString()

export const appKey = `dsk_${'n'.repeat(32)}`

export const env = (
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

export const attribution: LedgerAttribution = {
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
  uoaIdentity: {
    organizationId: 'uoa-org',
    subject: 'uoa-user',
    teamId: 'uoa-team',
    tokenVersion: 7,
  },
}

export const claimsOf = (token: string): Record<string, unknown> => {
  const payload = token.split('.')[1]
  assert.ok(payload)
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as
    Record<string, unknown>
}

export const verifyNessieSignature = (token: string): boolean => {
  const [header, payload, signature] = token.split('.')
  assert.ok(header && payload && signature)
  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    keys.publicKey,
    Buffer.from(signature, 'base64url'),
  )
}

export const delegationToken = (tokenVersion: number | undefined = 7): string => {
  const payload = Buffer.from(JSON.stringify({
    exp: 2_000_000_300,
    ...(tokenVersion === undefined ? {} : { tv: tokenVersion }),
  }))
    .toString('base64url')
  return `header.${payload}.signature`
}

export const linkedPrisma = (
  onLookup?: (productSlug: string) => void,
) => ({
  channel: {
    findFirst: async () => ({
      dmKey:
        `extagent:deepsignal:${attribution.organizationId}:${attribution.userId}:uoa-team`,
    }),
  },
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
        uoaTokenVersion: 7,
      }
    },
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
})
