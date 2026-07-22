import assert from 'node:assert/strict'
import test from 'node:test'

import {
  issueSessionToken,
  verifySessionToken,
} from '../src/auth/session.js'

const secret = 'session-uoa-proof-test-secret'
const base = {
  org: '00000000-0000-4000-8000-000000000001',
  proj: '00000000-0000-4000-8000-000000000002',
  providerId: 'uoa',
  providerType: 'uoa' as const,
  roles: ['member'],
  sub: '00000000-0000-4000-8000-000000000003',
  team: '00000000-0000-4000-8000-000000000004',
}
const identity = {
  organizationId: 'uoa-org',
  subject: 'uoa-user',
  teamId: 'uoa-team',
  tokenVersion: 7,
} as const

test('round-trips the exact immutable UOA login proof in a Nessie session', () => {
  const issued = issueSessionToken(
    { ...base, uoaIdentity: identity },
    secret,
    300,
  )
  const verified = verifySessionToken(issued.token, secret)

  assert.equal(verified.ok, true)
  if (!verified.ok) return
  assert.deepEqual(verified.claims.uoaIdentity, identity)
})

test('rejects malformed or non-UOA session proof claims', () => {
  const malformed = issueSessionToken(
    {
      ...base,
      uoaIdentity: { ...identity, tokenVersion: -1 },
    } as never,
    secret,
    300,
  )
  const wrongProvider = issueSessionToken(
    {
      ...base,
      providerId: 'local',
      providerType: 'local-bootstrap',
      uoaIdentity: identity,
    } as never,
    secret,
    300,
  )

  assert.deepEqual(verifySessionToken(malformed.token, secret), {
    code: 'TOKEN_INVALID',
    message: 'Invalid session token',
    ok: false,
  })
  assert.deepEqual(verifySessionToken(wrongProvider.token, secret), {
    code: 'TOKEN_INVALID',
    message: 'Invalid session token',
    ok: false,
  })
})
