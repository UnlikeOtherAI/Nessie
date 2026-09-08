import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PinnedFetch } from '@nessie/runtime'

import { registerOrganizationMembersRoutes } from '../src/routes/organization-members.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-00000000000a'
export const externalOrgId = 'org_acme'
export const externalTeamId = 'team_design'
const uoaPrivateKeyPem = String(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  format: 'pem', type: 'pkcs8',
}))

export const uoaEnv = {
  UOA_BASE_URL: 'https://uoa.test', UOA_CLIENT_SECRET: 'test-client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(uoaPrivateKeyPem).toString('base64'),
  UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt', UOA_DOMAIN: 'nessie.test',
  UOA_JWKS_URL: 'https://nessie.test/.well-known/jwks.json',
  UOA_REDIRECT_URL: 'https://nessie.test/auth/callback',
}

export const withUoaEnv = async (run: () => Promise<void>): Promise<void> => {
  const previous = { ...process.env }
  Object.assign(process.env, uoaEnv)
  try { await run() } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

const makePrisma = (): PrismaClient => ({
  organization: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === organizationId ? { externalOrgId } : null,
  },
  user: { findMany: async () => [] },
}) as unknown as PrismaClient

export const actorContextFor = (roles: string[]): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles },
  tenant: { organizationId, projectId: null, teamId },
  actionContext: {
    requestId: 'req-organization-members',
    uoaIdentity: { organizationId: externalOrgId, subject: 'usr_ada', teamId: externalTeamId, tokenVersion: 7 },
  },
})

export type StubCall = {
  url: string; method: string; hasAccessToken: boolean; subjectAssertion?: string; body?: string
}
type Responder = (call: StubCall) => Response
const stubFetch = (calls: StubCall[], respond: Responder): PinnedFetch =>
  (async (url: URL, init) => {
    const headers = new Headers(init?.headers as HeadersInit)
    const call = {
      url: url.toString(), method: init?.method ?? 'GET', hasAccessToken: headers.has('x-uoa-access-token'),
      subjectAssertion: headers.get('x-uoa-subject-assertion') ?? undefined,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    }
    calls.push(call)
    return respond(call)
  }) as PinnedFetch

export const json = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
})
export const rosterDeps = (calls: StubCall[], respond: Responder, orgRole = 'admin') => ({
  fetchImpl: stubFetch(calls, (call) => new URL(call.url).pathname === '/org/me'
    ? json({ ok: true, org: { org_id: externalOrgId, org_role: orgRole } }) : respond(call)),
  resolveHost: async () => ['93.184.216.34'],
})
export const forbidUpstream = (message: string) => ({
  fetchImpl: (async () => assert.fail(message)) as unknown as PinnedFetch,
  resolveHost: async () => ['93.184.216.34'],
})
export const makeApp = async (
  actorContext: AuthorizedActionContext,
  deps: Parameters<typeof registerOrganizationMembersRoutes>[2],
) => {
  const app = Fastify({ logger: false })
  registerOrganizationMembersRoutes(app, {
    prisma: makePrisma(), requireActorContext: () => actorContext,
  } as unknown as Parameters<typeof registerOrganizationMembersRoutes>[1], deps)
  return app
}
export const base = `https://uoa.test/org/organisations/${externalOrgId}`
export const query = `?domain=nessie.test&config_url=${encodeURIComponent(uoaEnv.UOA_CONFIG_URL)}`
