import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PrismaClient } from '@prisma/client'

const FIXTURE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const UOA_BASE_URL = 'https://1.1.1.1'
const UOA_DOMAIN = 'nessie.multi-instance.test'
const UOA_ORGANIZATION_ID = 'uoa-multi-instance-organization'
const UOA_SUBJECT = 'uoa-multi-instance-owner'
const UOA_TEAM_ID = 'uoa-multi-instance-team'
const UOA_TOKEN_VERSION = 1

type SmokeUoaPrisma = Pick<PrismaClient, 'organization' | 'productAccountLink' | 'team'>

type BoundOwner = {
  id: string
  tokenVersion: number
}

/**
 * A bounded UOA `/org/me` contract fixture for the self-hosted smoke.
 * Its preload validates every product-signed assertion before answering.
 */
export const createSmokeUoaFixture = (config: { authSecret: string; repoRoot: string }) => {
  const signingKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyPem = String(signingKeyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  const identity = {
    organizationId: UOA_ORGANIZATION_ID,
    subject: UOA_SUBJECT,
    teamId: UOA_TEAM_ID,
    tokenVersion: UOA_TOKEN_VERSION,
  }
  const environment = {
    DEEPSIGNAL_MCP_APP_KEY: `dsk_${randomUUID().replaceAll('-', '')}`,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(resolve(FIXTURE_DIRECTORY, 'uoa-org-me-fixture.mjs')).href}`,
    ].filter((value): value is string => Boolean(value)).join(' '),
    SMOKE_UOA_BASE_URL: UOA_BASE_URL,
    SMOKE_UOA_DOMAIN: UOA_DOMAIN,
    SMOKE_UOA_ORGANIZATION_ID: UOA_ORGANIZATION_ID,
    SMOKE_UOA_PUBLIC_KEY_B64: Buffer.from(String(
      signingKeyPair.publicKey.export({ format: 'pem', type: 'spki' }),
    )).toString('base64'),
    SMOKE_UOA_SUBJECT: UOA_SUBJECT,
    SMOKE_UOA_TEAM_ID: UOA_TEAM_ID,
    SMOKE_UOA_TOKEN_VERSION: String(UOA_TOKEN_VERSION),
    UOA_BASE_URL,
    UOA_CLIENT_SECRET: randomUUID(),
    UOA_CONFIG_JWT_KID: 'multi-instance-smoke',
    UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(privateKeyPem).toString('base64'),
    UOA_CONFIG_URL: `https://${UOA_DOMAIN}/uoa/config`,
    UOA_DOMAIN,
    UOA_JWKS_URL: `https://${UOA_DOMAIN}/.well-known/jwks.json`,
    UOA_REDIRECT_URL: `https://${UOA_DOMAIN}/auth/callback`,
  }

  const bindOwner = async (input: {
    bootstrapToken: string
    organizationId: string
    owner: BoundOwner
    prisma: SmokeUoaPrisma
    projectId: string
    teamId: string | null
  }): Promise<string> => {
    if (!input.teamId) throw new Error('bootstrap general channel has no team')
    await Promise.all([
      input.prisma.organization.update({
        data: { externalOrgId: UOA_ORGANIZATION_ID }, where: { id: input.organizationId },
      }),
      input.prisma.team.update({
        data: { externalOrgId: UOA_ORGANIZATION_ID, externalTeamId: UOA_TEAM_ID },
        where: { id: input.teamId },
      }),
      input.prisma.productAccountLink.upsert({
        create: {
          activeOrgId: UOA_ORGANIZATION_ID,
          activeTeamId: UOA_TEAM_ID,
          externalAccountId: UOA_SUBJECT,
          organizationId: input.organizationId,
          productSlug: 'nessie',
          status: 'linked',
          uoaSub: UOA_SUBJECT,
          uoaTokenVersion: UOA_TOKEN_VERSION,
          userId: input.owner.id,
        },
        update: {
          activeOrgId: UOA_ORGANIZATION_ID,
          activeTeamId: UOA_TEAM_ID,
          status: 'linked',
          uoaSub: UOA_SUBJECT,
          uoaTokenVersion: UOA_TOKEN_VERSION,
        },
        where: {
          organizationId_userId_productSlug: {
            organizationId: input.organizationId, productSlug: 'nessie', userId: input.owner.id,
          },
        },
      }),
    ])
    const claims = JSON.parse(Buffer.from(input.bootstrapToken.split('.')[1]!, 'base64url').toString('utf8')) as {
      sid?: string
    }
    if (!claims.sid) throw new Error('bootstrap issued a token without a session id')
    const { issueSessionToken } = await import(pathToFileURL(
      resolve(config.repoRoot, 'api', 'dist', 'auth', 'session.js'),
    ).href)
    return issueSessionToken({
      org: input.organizationId,
      proj: input.projectId,
      providerId: 'uoa',
      providerType: 'uoa',
      roles: ['owner'],
      sub: input.owner.id,
      team: input.teamId,
      tv: input.owner.tokenVersion,
      uoaIdentity: identity,
    }, config.authSecret, 60 * 60, claims.sid).token
  }

  return { bindOwner, environment, identity }
}
