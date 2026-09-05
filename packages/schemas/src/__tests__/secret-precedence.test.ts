import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeSecretPrecedence,
  findSecretLockAbove,
  resolveSecretChain,
  type SecretPrecedenceInput,
} from '../secret-precedence.js'

const context = { projectId: 'project-1', teamId: 'team-1', userId: 'user-1' }

const secret = (over: Partial<SecretPrecedenceInput> & { reference: string }): SecretPrecedenceInput => ({
  locked: false,
  name: 'STRIPE_API_KEY',
  scopeId: 'org-1',
  scopeType: 'organization',
  status: 'active',
  ...over,
})

const organization = secret({ reference: 'sec_org' })
const team = secret({ reference: 'sec_team', scopeId: 'team-1', scopeType: 'team' })
const project = secret({ reference: 'sec_project', scopeId: 'project-1', scopeType: 'project' })
const personal = secret({ reference: 'sec_personal', scopeId: 'user-1', scopeType: 'personal' })

const byReference = (rows: ReturnType<typeof computeSecretPrecedence>) =>
  new Map(rows.map((row) => [row.reference, row]))

test('the narrowest scope wins, in the containment order the team model states', () => {
  const rows = byReference(computeSecretPrecedence([organization, team, project, personal], context))

  assert.equal(rows.get('sec_personal')?.isEffective, true)
  assert.equal(rows.get('sec_project')?.overriddenBy?.scopeType, 'personal')
  assert.equal(rows.get('sec_team')?.overriddenBy?.scopeType, 'personal')
  assert.equal(rows.get('sec_org')?.overriddenBy?.scopeType, 'personal')
})

test('organisation is the base, and a team beats it', () => {
  const rows = byReference(computeSecretPrecedence([organization, team], context))

  assert.equal(rows.get('sec_team')?.isEffective, true)
  assert.deepEqual(rows.get('sec_org')?.overriddenBy, {
    reference: 'sec_team',
    scopeType: 'team',
  })
})

test('a lock stops the walk: the locking level wins and everything below is pinned', () => {
  const locked = { ...organization, locked: true }
  const rows = byReference(computeSecretPrecedence([locked, team, personal], context))

  assert.equal(rows.get('sec_org')?.isEffective, true)
  // The reason a locked-out row does not apply is the lock, not an override —
  // the table says "Locked by organisation" rather than naming a winner below.
  assert.deepEqual(rows.get('sec_team')?.lockedBy, {
    reference: 'sec_org',
    scopeType: 'organization',
  })
  assert.equal(rows.get('sec_team')?.overriddenBy, null)
  assert.deepEqual(rows.get('sec_personal')?.lockedBy, {
    reference: 'sec_org',
    scopeType: 'organization',
  })
})

test('a team lock binds the person but never the organisation above it', () => {
  const lockedTeam = { ...team, locked: true }
  const rows = byReference(computeSecretPrecedence([organization, lockedTeam, personal], context))

  assert.equal(rows.get('sec_team')?.isEffective, true)
  assert.deepEqual(rows.get('sec_personal')?.lockedBy, {
    reference: 'sec_team',
    scopeType: 'team',
  })
  // The organisation row is simply overridden — a lock below is not a lock on it.
  assert.equal(rows.get('sec_org')?.lockedBy, null)
  assert.deepEqual(rows.get('sec_org')?.overriddenBy, {
    reference: 'sec_team',
    scopeType: 'team',
  })
})

test('a level never locks itself out', () => {
  const lockedTeam = { ...team, locked: true }
  const rows = byReference(computeSecretPrecedence([lockedTeam], context))

  assert.equal(rows.get('sec_team')?.isEffective, true)
  assert.equal(rows.get('sec_team')?.lockedBy, null)
})

test('another team\'s secret is in nobody else\'s chain', () => {
  const otherTeam = secret({ reference: 'sec_other', scopeId: 'team-9', scopeType: 'team' })
  const rows = byReference(computeSecretPrecedence([organization, otherTeam], context))

  assert.equal(rows.get('sec_org')?.isEffective, true)
  assert.deepEqual(rows.get('sec_other'), {
    ...otherTeam,
    isEffective: false,
    lockedBy: null,
    overriddenBy: null,
  })
})

test('a revoked row neither applies nor overrides, and a locked revoked row pins nothing', () => {
  const revokedPersonal = { ...personal, status: 'revoked' as const }
  const revokedLockedOrg = { ...organization, locked: true, status: 'revoked' as const }
  const rows = byReference(computeSecretPrecedence([revokedLockedOrg, team, revokedPersonal], context))

  assert.equal(rows.get('sec_team')?.isEffective, true)
  assert.deepEqual(rows.get('sec_personal'), {
    ...revokedPersonal,
    isEffective: false,
    lockedBy: null,
    overriddenBy: null,
  })
  assert.equal(rows.get('sec_org')?.isEffective, false)
})

test('two names resolve independently', () => {
  const otherName = secret({ name: 'OPENAI_API_KEY', reference: 'sec_other_name' })
  const rows = byReference(computeSecretPrecedence([organization, personal, otherName], context))

  assert.equal(rows.get('sec_personal')?.isEffective, true)
  assert.equal(rows.get('sec_other_name')?.isEffective, true)
})

test('resolveSecretChain reports the level that stopped the walk', () => {
  const locked = { ...team, locked: true }

  assert.deepEqual(resolveSecretChain('STRIPE_API_KEY', [organization, locked, personal], context), {
    lockedAtScope: 'team',
    winner: locked,
  })
  assert.deepEqual(resolveSecretChain('STRIPE_API_KEY', [organization], context), {
    lockedAtScope: null,
    winner: organization,
  })
  assert.deepEqual(resolveSecretChain('NOTHING_HERE', [organization], context), {
    lockedAtScope: null,
    winner: null,
  })
})

test('findSecretLockAbove names the broadest lock, and only strictly above', () => {
  const lockedOrg = { ...organization, locked: true }
  const lockedTeam = { ...team, locked: true }

  assert.equal(
    findSecretLockAbove({ name: 'STRIPE_API_KEY', scopeType: 'personal' }, [lockedOrg, lockedTeam]),
    lockedOrg,
  )
  assert.equal(
    findSecretLockAbove({ name: 'STRIPE_API_KEY', scopeType: 'team' }, [lockedTeam]),
    null,
  )
  assert.equal(
    findSecretLockAbove({ name: 'STRIPE_API_KEY', scopeType: 'organization' }, [lockedOrg]),
    null,
  )
  // An unlocked broader secret is an override, not a refusal.
  assert.equal(
    findSecretLockAbove({ name: 'STRIPE_API_KEY', scopeType: 'personal' }, [organization]),
    null,
  )
  // A revoked lock holds nothing.
  assert.equal(
    findSecretLockAbove({ name: 'STRIPE_API_KEY', scopeType: 'personal' }, [
      { ...lockedOrg, status: 'revoked' },
    ]),
    null,
  )
})
