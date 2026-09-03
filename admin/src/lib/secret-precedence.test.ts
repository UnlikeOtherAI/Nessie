import assert from 'node:assert/strict'
import test from 'node:test'

import { computeSecretPrecedence } from './secret-precedence.js'
import type { SecretRecord } from '../facades/secrets/hooks'

const CONTEXT = { userId: 'user-1', teamId: 'team-1', projectId: 'project-1' }

const secret = (overrides: Partial<SecretRecord>): SecretRecord => ({
  reference: 'sec_default',
  name: 'API_KEY',
  description: null,
  provider: null,
  scopeType: 'organization',
  scopeId: 'org-1',
  rotatedAt: null,
  expiresAt: null,
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
})

test('an org secret is effective alone', () => {
  const org = secret({ reference: 'sec_org', scopeType: 'organization', scopeId: 'org-1' })
  const results = computeSecretPrecedence([org], CONTEXT)
  const byRef = new Map(results.map((row) => [row.reference, row]))
  assert.equal(byRef.get('sec_org')?.isEffective, true)
  assert.equal(byRef.get('sec_org')?.overriddenBy, null)
})

test('a team secret in the viewer\'s own team overrides the org one', () => {
  const org = secret({ reference: 'sec_org', scopeType: 'organization', scopeId: 'org-1' })
  const team = secret({ reference: 'sec_team', scopeType: 'team', scopeId: 'team-1' })
  const results = computeSecretPrecedence([org, team], CONTEXT)
  const byRef = new Map(results.map((row) => [row.reference, row]))
  assert.equal(byRef.get('sec_org')?.isEffective, false)
  assert.deepEqual(byRef.get('sec_org')?.overriddenBy, { scopeType: 'team', reference: 'sec_team' })
  assert.equal(byRef.get('sec_team')?.isEffective, true)
  assert.equal(byRef.get('sec_team')?.overriddenBy, null)
})

test('personal beats project beats team beats organization, in the viewer\'s own chain', () => {
  const org = secret({ reference: 'sec_org', scopeType: 'organization', scopeId: 'org-1' })
  const team = secret({ reference: 'sec_team', scopeType: 'team', scopeId: 'team-1' })
  const project = secret({ reference: 'sec_project', scopeType: 'project', scopeId: 'project-1' })
  const personal = secret({ reference: 'sec_personal', scopeType: 'personal', scopeId: 'user-1' })
  const results = computeSecretPrecedence([org, team, project, personal], CONTEXT)
  const byRef = new Map(results.map((row) => [row.reference, row]))
  assert.equal(byRef.get('sec_personal')?.isEffective, true)
  assert.deepEqual(byRef.get('sec_project')?.overriddenBy, { scopeType: 'personal', reference: 'sec_personal' })
  assert.deepEqual(byRef.get('sec_team')?.overriddenBy, { scopeType: 'personal', reference: 'sec_personal' })
  assert.deepEqual(byRef.get('sec_org')?.overriddenBy, { scopeType: 'personal', reference: 'sec_personal' })
})

test('a same-named secret in a DIFFERENT team never overrides or is overridden', () => {
  const ownTeam = secret({ reference: 'sec_own_team', scopeType: 'team', scopeId: 'team-1' })
  const otherTeam = secret({ reference: 'sec_other_team', scopeType: 'team', scopeId: 'team-99' })
  const results = computeSecretPrecedence([ownTeam, otherTeam], CONTEXT)
  const byRef = new Map(results.map((row) => [row.reference, row]))
  assert.equal(byRef.get('sec_own_team')?.isEffective, true)
  assert.equal(byRef.get('sec_other_team')?.isEffective, false)
  assert.equal(byRef.get('sec_other_team')?.overriddenBy, null)
})

test('a same-named personal secret belonging to someone else never enters the viewer\'s chain', () => {
  const own = secret({ reference: 'sec_own', scopeType: 'personal', scopeId: 'user-1' })
  const someoneElse = secret({ reference: 'sec_other', scopeType: 'personal', scopeId: 'user-2' })
  const results = computeSecretPrecedence([own, someoneElse], CONTEXT)
  const byRef = new Map(results.map((row) => [row.reference, row]))
  assert.equal(byRef.get('sec_own')?.isEffective, true)
  assert.equal(byRef.get('sec_other')?.isEffective, false)
  assert.equal(byRef.get('sec_other')?.overriddenBy, null)
})

test('a revoked secret is never effective and never named as an overrider', () => {
  const revokedTeam = secret({
    reference: 'sec_team_revoked',
    scopeType: 'team',
    scopeId: 'team-1',
    status: 'revoked',
  })
  const org = secret({ reference: 'sec_org', scopeType: 'organization', scopeId: 'org-1' })
  const results = computeSecretPrecedence([revokedTeam, org], CONTEXT)
  const byRef = new Map(results.map((row) => [row.reference, row]))
  assert.equal(byRef.get('sec_team_revoked')?.isEffective, false)
  assert.equal(byRef.get('sec_team_revoked')?.overriddenBy, null)
  // The revoked team row does not shadow the org row — org wins by default.
  assert.equal(byRef.get('sec_org')?.isEffective, true)
})

test('an expired secret is never effective either', () => {
  const expiredPersonal = secret({
    reference: 'sec_personal_expired',
    scopeType: 'personal',
    scopeId: 'user-1',
    status: 'expired',
  })
  const org = secret({ reference: 'sec_org', scopeType: 'organization', scopeId: 'org-1' })
  const results = computeSecretPrecedence([expiredPersonal, org], CONTEXT)
  const byRef = new Map(results.map((row) => [row.reference, row]))
  assert.equal(byRef.get('sec_personal_expired')?.isEffective, false)
  assert.equal(byRef.get('sec_org')?.isEffective, true)
})

test('distinct names never interact', () => {
  const apiKey = secret({ reference: 'sec_api', name: 'API_KEY', scopeType: 'organization', scopeId: 'org-1' })
  const dbUrl = secret({ reference: 'sec_db', name: 'DATABASE_URL', scopeType: 'team', scopeId: 'team-1' })
  const results = computeSecretPrecedence([apiKey, dbUrl], CONTEXT)
  assert.ok(results.every((row) => row.isEffective))
})
