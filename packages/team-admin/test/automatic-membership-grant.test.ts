/**
 * The grant helper's contract, driven through a fake Prisma and a fake UOA.
 *
 * These cases pin the properties the whole feature rests on: no role is ever
 * sent, an existing member is never touched, the ledger makes replays free, a
 * peer skips instead of double-granting, and UOA refusing the authorizer moves
 * the rule to a state that names its remedy.
 */

import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

process.env.UOA_BASE_URL ??= 'https://uoa.example'
process.env.UOA_DOMAIN ??= 'nessie.test'
process.env.UOA_CONFIG_URL ??= 'https://nessie.test/api/auth/sso/config'
process.env.UOA_JWKS_URL ??= 'https://nessie.test/.well-known/jwks.json'
process.env.UOA_REDIRECT_URL ??= 'https://nessie.test/auth/callback'
process.env.UOA_CONTACT_EMAIL ??= 'ops@nessie.test'
process.env.UOA_CLIENT_SECRET ??= 'test-client-secret'
process.env.UOA_CONFIG_JWT_KID ??= 'test-kid'

const { generateKeyPairSync } = await import('node:crypto')
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
process.env.UOA_CONFIG_JWT_PRIVATE_KEY_B64 ??= Buffer.from(
  privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
).toString('base64')

const { grantAutomaticMembership } = await import('../src/automatic-membership-grant.js')
const { UoaRosterRejectedError, UoaRosterUnavailableError } = await import(
  '../src/uoa-org-roster.js'
)

type GrantRow = {
  ruleId: string
  uoaSub: string
  outcome: string
  source: string
  attempts: number
  leaseExpiresAt: Date | null
  failureReason: string | null
}

type RuleRow = { id: string; healthState: string; healthRevision: number; healthReason: string | null }

const RULE = {
  authorizedByUoaSub: 'admin-sub',
  authorizedTeamId: 'team-external',
  authorizedTokenVersion: 3,
  externalOrgId: 'org-external',
  teamName: 'Engineering',
  externalTeamId: 'team-external',
  id: 'rule-1',
  teamId: 'team-local',
}

let grants: GrantRow[]
let rules: RuleRow[]
/** Every upstream call this test made, so "never sends a role" is provable. */
let addCalls: { team: unknown; input: Record<string, unknown> }[]
let workspaceAccess: { id: string; name: string; hasAccess: boolean }[]
let accessError: Error | null
let addError: Error | null

const key = (ruleId: string, uoaSub: string) => `${ruleId}::${uoaSub}`

const fakePrisma = {
  automaticMembershipGrant: {
    create: async ({ data }: { data: GrantRow }) => {
      if (grants.some((row) => key(row.ruleId, row.uoaSub) === key(data.ruleId, data.uoaSub))) {
        throw Object.assign(new Error('unique violation'), { code: 'P2002' })
      }
      grants.push({ failureReason: null, leaseExpiresAt: null, ...data })
      return data
    },
    findUnique: async ({ where }: { where: { ruleId_uoaSub: { ruleId: string; uoaSub: string } } }) =>
      grants.find((row) =>
        key(row.ruleId, row.uoaSub)
        === key(where.ruleId_uoaSub.ruleId, where.ruleId_uoaSub.uoaSub)) ?? null,
    update: async ({ data, where }: {
      data: Record<string, unknown>
      where: { ruleId_uoaSub: { ruleId: string; uoaSub: string } }
    }) => {
      const row = grants.find((entry) =>
        key(entry.ruleId, entry.uoaSub)
        === key(where.ruleId_uoaSub.ruleId, where.ruleId_uoaSub.uoaSub))
      if (!row) throw new Error('no such grant row')
      Object.assign(row, data)
      return row
    },
    updateMany: async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
      const row = grants.find((entry) =>
        entry.ruleId === where.ruleId && entry.uoaSub === where.uoaSub)
      if (!row) return { count: 0 }
      const allowed = (where.outcome as { in: string[] } | undefined)?.in
      if (allowed && !allowed.includes(row.outcome)) return { count: 0 }
      if (row.leaseExpiresAt && row.leaseExpiresAt > new Date()) return { count: 0 }
      const increment = (data.attempts as { increment?: number } | undefined)?.increment
      Object.assign(row, {
        ...data,
        attempts: increment ? row.attempts + increment : row.attempts,
      })
      return { count: 1 }
    },
  },
  automaticMembershipRule: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      rules.find((entry) => entry.id === where.id) ?? null,
    updateMany: async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
      const row = rules.find((entry) =>
        entry.id === where.id && entry.healthState === where.healthState)
      if (!row) return { count: 0 }
      const increment = (data.healthRevision as { increment?: number } | undefined)?.increment
      Object.assign(row, {
        ...data,
        healthRevision: increment ? row.healthRevision + increment : row.healthRevision,
      })
      return { count: 1 }
    },
  },
} as unknown as Parameters<typeof grantAutomaticMembership>[0]

beforeEach(() => {
  grants = []
  rules = [{ healthReason: null, healthRevision: 0, healthState: 'ok', id: RULE.id }]
  addCalls = []
  workspaceAccess = [{ hasAccess: false, id: 'team-external', name: 'Engineering' }]
  accessError = null
  addError = null
})

// The two UOA calls, injected through the helper's own seam. ESM exports are
// not redefinable, so patching the module would throw — and a real parameter is
// the shape the rest of this package already uses for egress anyway.
const upstream = {
  addTeamMember: async (team: unknown, input: Record<string, unknown>) => {
    addCalls.push({ input, team })
    if (addError) throw addError
  },
  listWorkspaceAccess: async () => {
    if (accessError) throw accessError
    return { items: workspaceAccess, permissions: { changeWorkspaceAccess: true } }
  },
} as unknown as Parameters<typeof grantAutomaticMembership>[5]

const grant = (uoaSub: string, source: 'signin' | 'reconcile' = 'signin') =>
  grantAutomaticMembership(fakePrisma, RULE, uoaSub, source, {}, upstream)

test('a first grant adds the person and records the outcome', async () => {
  const result = await grant('person-1')
  assert.equal(result.outcome, 'granted')
  assert.equal(addCalls.length, 1)
  assert.equal(grants[0]?.outcome, 'granted')
  assert.equal(grants[0]?.leaseExpiresAt, null)
})

test('the upstream add NEVER carries a role', async () => {
  await grant('person-1')
  assert.deepEqual(addCalls[0]?.input, { uoaSub: 'person-1' })
  assert.equal('teamRole' in (addCalls[0]?.input ?? {}), false)
})

test('an existing member is skipped, so a team owner is never demoted', async () => {
  workspaceAccess = [{ hasAccess: true, id: 'team-external', name: 'Engineering' }]
  const result = await grant('owner-sub', 'reconcile')
  assert.equal(result.outcome, 'skipped_existing')
  assert.equal(addCalls.length, 0, 'no upstream write at all for an existing member')
})

test('a team the rule points at that UOA does not offer is skipped, not failed', async () => {
  workspaceAccess = [{ hasAccess: false, id: 'some-other-team', name: 'Other' }]
  const result = await grant('person-1')
  assert.equal(result.outcome, 'skipped_no_such_team')
  assert.equal(addCalls.length, 0)
})

test('replaying a completed grant makes no second upstream call', async () => {
  await grant('person-1')
  const replay = await grant('person-1', 'reconcile')
  assert.equal(replay.outcome, 'granted')
  assert.equal(addCalls.length, 1, 'the ledger, not the queue, is the idempotency mechanism')
})

test('a peer holding a fresh lease is skipped rather than double-granting', async () => {
  grants.push({
    attempts: 1,
    failureReason: null,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    outcome: 'attempted',
    ruleId: RULE.id,
    source: 'reconcile',
    uoaSub: 'person-1',
  })
  const result = await grant('person-1')
  assert.equal(result.outcome, 'in_flight')
  assert.equal(addCalls.length, 0)
})

test('an expired lease is retryable', async () => {
  grants.push({
    attempts: 1,
    failureReason: 'earlier outage',
    leaseExpiresAt: new Date(Date.now() - 1000),
    outcome: 'attempted',
    ruleId: RULE.id,
    source: 'signin',
    uoaSub: 'person-1',
  })
  const result = await grant('person-1')
  assert.equal(result.outcome, 'granted')
  assert.equal(addCalls.length, 1)
})

test('a transport failure releases the lease so the next sign-in retries', async () => {
  addError = new UoaRosterUnavailableError('upstream down')
  const result = await grant('person-1')
  assert.equal(result.outcome, 'failed')
  assert.equal(grants[0]?.outcome, 'attempted')
  assert.equal(grants[0]?.leaseExpiresAt, null, 'released, not burned')

  addError = null
  const retry = await grant('person-1')
  assert.equal(retry.outcome, 'granted')
})

test('UOA refusing the authorizer moves the rule to needs_reauthorization, once', async () => {
  accessError = new UoaRosterRejectedError('[uoa] no role', 403, 'INSUFFICIENT_ORG_ROLE')
  const first = await grant('person-1')
  assert.equal(first.outcome, 'unauthorized')
  assert.equal(rules[0]?.healthState, 'needs_reauthorization')
  assert.equal(rules[0]?.healthRevision, 1)

  // A long reconciliation must not re-alert on every subsequent person.
  const second = await grant('person-2', 'reconcile')
  assert.equal(second.outcome, 'unauthorized')
  assert.equal(rules[0]?.healthRevision, 1, 'exactly once per transition')
})

test('a 401 is treated as authorization loss, not a transport fault', async () => {
  accessError = new UoaRosterRejectedError('[uoa] expired', 401)
  const result = await grant('person-1')
  assert.equal(result.outcome, 'unauthorized')
  assert.equal(rules[0]?.healthState, 'needs_reauthorization')
})

test('a 404 from UOA is a plain failure, not an authorization loss', async () => {
  accessError = new UoaRosterRejectedError('[uoa] gone', 404)
  const result = await grant('person-1')
  assert.equal(result.outcome, 'failed')
  assert.equal(rules[0]?.healthState, 'ok')
})

test('a team UOA does not offer stays retryable rather than burning the person', async () => {
  workspaceAccess = [{ hasAccess: false, id: 'some-other-team', name: 'Other' }]
  const first = await grant('person-1')
  assert.equal(first.outcome, 'skipped_no_such_team')
  // Not terminal: the pre-read answers within the authorizer's own authority
  // and drops incomplete rows, so a temporary scope reduction must not cost
  // this person the rule forever.
  assert.equal(grants[0]?.outcome, 'attempted')
  assert.equal(grants[0]?.leaseExpiresAt, null)

  workspaceAccess = [{ hasAccess: false, id: 'team-external', name: 'Engineering' }]
  const retry = await grant('person-1')
  assert.equal(retry.outcome, 'granted')
})

test('the health transition is reported to the caller exactly once', async () => {
  accessError = new UoaRosterRejectedError('[uoa] no role', 403)
  const first = await grant('person-1')
  assert.equal(first.outcome, 'unauthorized')
  assert.deepEqual(first.healthTransition, { healthRevision: 1 })

  // A long reconciliation hitting the same refusal must not alert per person.
  const second = await grant('person-2', 'reconcile')
  assert.equal(second.outcome, 'unauthorized')
  assert.equal(second.healthTransition, undefined)
})

test('every upstream request is paced, not just one per grant', async () => {
  let paced = 0
  await grantAutomaticMembership(
    fakePrisma, RULE, 'person-1', 'signin', {},
    { ...upstream, pace: async () => { paced += 1 } } as typeof upstream,
  )
  // The per-subject pre-read and the add are two requests, so pacing once per
  // grant would let through twice the intended rate.
  assert.equal(paced, 2)
})

test('a non-unique database fault is not mistaken for a peer holding the lease', async () => {
  const brokenPrisma = {
    ...(fakePrisma as unknown as Record<string, unknown>),
    automaticMembershipGrant: {
      ...(fakePrisma as unknown as { automaticMembershipGrant: Record<string, unknown> })
        .automaticMembershipGrant,
      create: async () => { throw Object.assign(new Error('connection lost'), { code: 'P1001' }) },
      findUnique: async () => null,
    },
  } as unknown as typeof fakePrisma
  await assert.rejects(
    grantAutomaticMembership(brokenPrisma, RULE, 'person-1', 'signin', {}, upstream),
    /connection lost/,
  )
})
