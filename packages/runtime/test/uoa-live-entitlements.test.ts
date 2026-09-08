import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  resolveLiveEntitlements,
  type UoaLiveEntitlementsPrisma,
} from '../src/uoa-live-entitlements.js'

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs1' }).toString()

const settings = {
  authBaseUrl: 'https://uoa.example.test',
  clientSecret: 'secret',
  configUrl: 'https://nessie.example.test/config',
  kid: 'kid-1',
  privateKeyPem,
  sourceDomain: 'nessie.example.test',
}

const identity = {
  organizationId: 'uoa-org',
  subject: 'subject-1',
  teamId: 'uoa-team-a',
  tokenVersion: 4,
}

const prisma = (input: {
  externalOrgId?: string | null
  link?: Record<string, unknown> | null
  missingOrganization?: boolean
  teamIds?: string[]
} = {}): UoaLiveEntitlementsPrisma => ({
  organization: { findUnique: async () => input.missingOrganization
    ? null
    : ({ externalOrgId: input.externalOrgId === undefined ? 'uoa-org' : input.externalOrgId }) },
  organizationMember: { findFirst: async () => ({ id: 'member-1' }) },
  productAccountLink: { findUnique: async () => input.link ?? {
    activeOrgId: 'uoa-org',
    activeTeamId: 'uoa-team-a',
    status: 'linked',
    uoaSub: 'subject-1',
    uoaTokenVersion: 4,
  } },
  team: { findMany: async () => (input.teamIds ?? ['team-a']).map((id) => ({ id })) },
} as unknown as UoaLiveEntitlementsPrisma)

const response = (org: Record<string, unknown>) => async () => new Response(JSON.stringify({
  org,
  team_directory: [{ team_id: 'directory-only' }],
}), { status: 200 })

const deps = (fetchImpl: typeof fetch) => ({
  fetchImpl: fetchImpl as never,
  resolveHost: async () => ['8.8.8.8'] as never,
  settings,
})

test('maps only active /org/me teams to existing local references without writes', async () => {
  const resolved = await resolveLiveEntitlements(prisma(), {
    organizationId: 'local-org', uoaIdentity: identity, userId: 'user-1',
  }, deps(response({ org_id: 'uoa-org', org_role: 'member', teams: ['uoa-team-a'] })))

  assert.deepEqual(resolved, {
    kind: 'uoa', organizationId: 'local-org', organizationRole: 'member',
    teamIds: ['team-a'], userId: 'user-1',
  })
})

test('wrong UOA organization and absent local binding fail closed', async () => {
  const wrongOrg = await resolveLiveEntitlements(prisma(), {
    organizationId: 'local-org', uoaIdentity: identity, userId: 'user-1',
  }, deps(response({ org_id: 'other-org', org_role: 'owner', teams: ['uoa-team-a'] })))
  const absent = await resolveLiveEntitlements(prisma({ missingOrganization: true }), {
    organizationId: 'missing-org', uoaIdentity: identity, userId: 'user-1',
  }, deps(response({ org_id: 'uoa-org', org_role: 'owner', teams: ['uoa-team-a'] })))

  assert.deepEqual(wrongOrg, { kind: 'denied' })
  assert.deepEqual(absent, { kind: 'denied' })
})

test('a supplied mismatched session cannot fall back to a stored background identity', async () => {
  let calls = 0
  const resolved = await resolveLiveEntitlements(prisma(), {
    allowStoredIdentity: true,
    organizationId: 'local-org',
    uoaIdentity: { ...identity, subject: 'wrong-subject' },
    userId: 'user-1',
  }, deps(async () => {
    calls += 1
    return new Response('{}', { status: 200 })
  }))

  assert.deepEqual(resolved, { kind: 'denied' })
  assert.equal(calls, 0)
})

test('an intentional background recheck uses its exact stable link and fresh response', async () => {
  const resolved = await resolveLiveEntitlements(prisma(), {
    allowStoredIdentity: true, organizationId: 'local-org', userId: 'user-1',
  }, deps(response({ org_id: 'uoa-org', org_role: 'member', teams: ['uoa-team-a'] })))

  assert.equal(resolved.kind, 'uoa')
  assert.deepEqual(resolved.kind === 'uoa' ? resolved.teamIds : [], ['team-a'])
})

test('an unbound organization is local only when the deployment has no UOA mode', async () => {
  const local = await resolveLiveEntitlements(prisma({ externalOrgId: null }), {
    organizationId: 'local-org', userId: 'user-1',
  }, { settings: null, uoaConfigured: false })
  const partialUoa = await resolveLiveEntitlements(prisma({ externalOrgId: null }), {
    organizationId: 'local-org', userId: 'user-1',
  }, { settings: null, uoaConfigured: true })

  assert.deepEqual(local, { kind: 'local', organizationId: 'local-org', userId: 'user-1' })
  assert.deepEqual(partialUoa, { kind: 'denied' })
})
