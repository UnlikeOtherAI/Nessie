import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { PinnedFetch, UoaDelegatedIdentitySettings } from '@nessie/runtime'
import { executorPairingAuthority } from '../src/services/executor-pairing-identity.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const localTeamId = '00000000-0000-4000-8000-000000000003'
const projectId = '00000000-0000-4000-8000-000000000004'
const settings: UoaDelegatedIdentitySettings = {
  authBaseUrl: 'https://uoa.test', clientSecret: 'test secret', configUrl: 'https://nessie.test/uoa/config.jwt',
  kid: 'test', sourceDomain: 'nessie.test',
  privateKeyPem: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
}
const input = {
  organizationId, userId,
  identity: { organizationId: 'org-live', teamId: 'team-live', subject: 'subject-live', tokenVersion: 3 },
}
const fake = () => ({
  organization: { findUnique: async () => ({ id: organizationId, externalOrgId: 'org-live', name: 'Stale name' }) },
  productAccountLink: { findUnique: async () => ({ status: 'linked', uoaSub: 'subject-live', uoaTokenVersion: 3 }) },
  team: { findMany: async () => [{ id: localTeamId, externalTeamId: 'team-live' }] },
  project: { findMany: async () => [{ id: projectId, teamId: localTeamId }] },
} as unknown as PrismaClient)
const payload = (role = 'member', teams = ['team-live']) => ({ org: {
  org_id: 'org-live', org_role: role, teams,
  team_directory: [
    { orgId: 'org-live', teamId: 'team-live', name: 'Live team', orgName: 'Live organisation' },
    { orgId: 'org-live', teamId: 'team-withdrawn', name: 'Withdrawn', orgName: 'Live organisation' },
    { orgId: 'org-other', teamId: 'team-other', name: 'Other organisation', orgName: 'Other organisation' },
  ],
} })
const deps = (body: unknown) => ({ settings, resolveHost: async () => ['93.184.216.34'],
  fetchImpl: (async () => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as PinnedFetch,
})

test('pairing uses live UOA names, membership and role, and explicit product team links', async () => {
  const result = await executorPairingAuthority(fake(), input, deps(payload()))
  assert.deepEqual(result.options.organization, { id: organizationId, name: 'Live organisation' })
  assert.deepEqual(result.options.teams, [{ id: 'team-live', name: 'Live team', projectIds: [projectId] }])
  assert.equal(result.options.scopes.includes('organization'), false)
  const manager = await executorPairingAuthority(fake(), input, deps(payload('owner')))
  assert.equal(manager.options.scopes.includes('organization'), true)
})

test('pairing refuses missing identity, epoch mismatch, foreign org and withdrawn team membership', async () => {
  await assert.rejects(executorPairingAuthority(fake(), { organizationId, userId }, deps(payload())), /unavailable/)
  await assert.rejects(executorPairingAuthority(fake(), {
    ...input, identity: { ...input.identity, tokenVersion: 2 },
  }, deps(payload())), /unavailable/)
  await assert.rejects(executorPairingAuthority(fake(), input, deps({ org: {
    ...payload().org, org_id: 'foreign',
  } })), /unavailable/)
  await assert.rejects(executorPairingAuthority(fake(), input, deps(payload('member', []))), /unavailable/)
})

test('pairing team options omit projects the person cannot administer', async () => {
  const prisma = fake()
  prisma.project.findMany = (async (args: { where: { members?: unknown } }) =>
    args.where.members ? [] : [{ id: projectId, teamId: localTeamId }]) as typeof prisma.project.findMany
  const result = await executorPairingAuthority(prisma, input, deps(payload()))
  assert.deepEqual(result.options.teams, [{ id: 'team-live', name: 'Live team', projectIds: [] }])
  assert.deepEqual(result.options.scopes, ['private'])
})
