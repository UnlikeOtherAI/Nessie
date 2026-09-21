import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { AuthorizedActionContextSchema } from '@nessie/schemas'
import { captureChannelPolicyAuthorizer, resolveChannelPolicyAuthorizer } from '../src/channel-policy-authority.js'

const USER = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const CHANNEL = '33333333-3333-4333-8333-333333333333'
const TEAM = '44444444-4444-4444-8444-444444444444'
const OTHER = '55555555-5555-4555-8555-555555555555'
const identity = { organizationId: 'external-org', subject: 'authorizer', teamId: 'external-team', tokenVersion: 3 }
const source = AuthorizedActionContextSchema.parse({
  actor: { actorType: 'user', actorId: USER, roles: ['owner'] }, tenant: { organizationId: ORG, teamId: TEAM },
  actionContext: { requestId: 'capture', uoaIdentity: identity, sessionId: 'transient' },
  approval: { approvalId: 'one-action-proof' }, verification: { challengeId: 'once', proof: 'transient' },
})
const scope = { channelId: CHANNEL, organizationId: ORG }
const captured = () => captureChannelPolicyAuthorizer(source, { ...scope, userId: USER })
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
const settings = {
  authBaseUrl: 'https://uoa.example.test', clientSecret: 'test-only', configUrl: 'https://nessie.example.test/config',
  kid: 'test', privateKeyPem: key.privateKey.export({ format: 'pem', type: 'pkcs1' }).toString(),
  sourceDomain: 'nessie.example.test',
}
const makePrisma = (input: {
  active?: boolean; binding?: boolean; channelMember?: boolean; local?: boolean; tokenVersion?: number
} = {}) => ({
  organization: { findUnique: async () => ({ externalOrgId: input.local ? null : 'external-org' }) },
  organizationMember: {
    findFirst: async () => input.active === false ? null : { id: 'member' },
    findUnique: async () => ({ role: 'member', deactivatedAt: input.active === false ? new Date() : null }),
  },
  productAccountLink: { findUnique: async () => ({
    status: 'linked', uoaSub: 'authorizer', uoaTokenVersion: input.tokenVersion ?? 3,
  }) },
  team: {
    findMany: async () => [{ id: TEAM }],
    findFirst: async () => ({ externalOrgId: 'external-org', externalTeamId: 'external-team' }),
  },
  channel: { findUnique: async () => ({
    id: CHANNEL, organizationId: ORG, type: 'standard', systemChannelType: null, archivedAt: null, deletedAt: null,
    visibility: 'protected',
  }) },
  channelMember: { findUnique: async () => input.channelMember === false ? null : { role: 'member' } },
  agentBinding: { findFirst: async () => input.binding === false ? null : { id: 'binding' } },
}) as unknown as Parameters<typeof resolveChannelPolicyAuthorizer>[0]
const deps = (role = 'member', status = 200) => ({
  settings, uoaConfigured: true,
  resolveHost: async () => ['8.8.8.8'] as never,
  fetchImpl: (async () => new Response(JSON.stringify({
    org: { org_id: 'external-org', org_role: role, teams: ['external-team'] },
  }), { status })) as never,
})

test('capture pins the human and UOA team while removing one-shot authorization proofs', () => {
  const context = captured()
  assert.equal(context.actor.actorId, USER)
  assert.deepEqual(context.actionContext.uoaIdentity, identity)
  assert.equal(context.tenant.teamId, TEAM)
  assert.equal(context.approval, undefined)
  assert.equal(context.verification, undefined)
  assert.equal(context.actionContext.sessionId, undefined)
  assert.equal(context.actor.roles, undefined)
  assert.throws(() => captureChannelPolicyAuthorizer(source, { ...scope, userId: OTHER }), /authenticated human/)
})

test('a fresh UOA role replaces captured admin roles and preserves per-run fields', async () => {
  const authorizer = captured()
  authorizer.actionContext.threadId = CHANNEL as never
  const resolved = await resolveChannelPolicyAuthorizer(makePrisma(), { ...scope, authorizer }, deps())
  assert.deepEqual(resolved.actor.roles, ['member'])
  assert.equal(resolved.actionContext.threadId, CHANNEL)
  assert.equal(resolved.actor.actorId, USER)
  await assert.rejects(resolveChannelPolicyAuthorizer(makePrisma({ channelMember: false }), {
    ...scope, authorizer,
  }, deps()), /can no longer manage/)
})

test('credential epoch changes, missing capture and UOA unavailability all refuse work', async () => {
  await assert.rejects(resolveChannelPolicyAuthorizer(makePrisma({ tokenVersion: 4 }), {
    ...scope, authorizer: captured(),
  }, deps()), /lost access/)
  await assert.rejects(resolveChannelPolicyAuthorizer(makePrisma(), {
    ...scope, authorizer: null,
  }, deps()), /saved again/)
  await assert.rejects(resolveChannelPolicyAuthorizer(makePrisma(), {
    ...scope, authorizer: captured(),
  }, deps('member', 503)), /unavailable/)
})

test('management alone never grants a policy authorizer the protected channel content', async () => {
  await assert.rejects(resolveChannelPolicyAuthorizer(makePrisma({ channelMember: false }), {
    ...scope, authorizer: captured(), target: { agentId: OTHER },
  }, deps('admin')), /cannot read this channel/)
})

test('local deactivation, cross-channel replay, removed binding and another PA principal refuse work', async () => {
  await assert.rejects(resolveChannelPolicyAuthorizer(makePrisma({ local: true, active: false }), {
    ...scope, authorizer: captured(),
  }, { settings: null, uoaConfigured: false }), /lost access/)
  await assert.rejects(resolveChannelPolicyAuthorizer(makePrisma(), {
    ...scope, channelId: OTHER, authorizer: captured(),
  }, deps()), /does not match/)
  await assert.rejects(resolveChannelPolicyAuthorizer(makePrisma({ binding: false }), {
    ...scope, authorizer: captured(), target: { agentId: OTHER },
  }, deps()), /no longer in this channel/)
  await assert.rejects(resolveChannelPolicyAuthorizer(makePrisma(), {
    ...scope, authorizer: captured(), target: { agentId: OTHER, principalUserId: OTHER },
  }, deps()), /another person/)
})
