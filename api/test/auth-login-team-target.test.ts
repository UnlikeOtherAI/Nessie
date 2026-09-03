import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALICE,
  ORG,
  TEAM,
  aliceBearer,
  assertUntouched,
  buildApp,
  recoveryExchange,
  stubAliceExchange,
  type MutationSpy,
} from './auth-login-team-target-fixture.js'

/**
 * Refusal coverage for the account-bound team-switch recovery
 * discriminant on POST /api/auth/session: expectedTeam is valid ONLY as
 * a complete providerId=uoa code exchange accompanied by a current Bearer
 * Nessie session for the same immutable UOA identity. Every refusal runs
 * BEFORE the billing confirm (a POST side effect), before any local mutation,
 * and before Set-Cookie, so a rejected exchange leaves the existing session
 * and refresh family untouched. The UOA upstream and the database are faked;
 * the route registrar is real. Success-path coverage lives in
 * auth-login-team-recovery-success.test.ts.
 */

const EXPECTED = { organizationId: ORG, teamId: TEAM }

test('expectedTeam with a password login is refused before any exchange', async () => {
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/session',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      email: 'alice@example.com',
      expectedTeam: EXPECTED,
      password: 'password-1',
    }),
  })

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'TEAM_IDENTITY_MISMATCH')
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(spy.calls.length, 0)
})

test('expectedTeam with a required code tuple field omitted is refused', async () => {
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer(),
    expectedTeam: EXPECTED,
    omitCodeVerifier: true,
  })

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'TEAM_IDENTITY_MISMATCH')
  assert.equal(spy.calls.length, 0)
})

test('expectedTeam with a non-uoa provider is refused before any exchange', async () => {
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer(),
    expectedTeam: EXPECTED,
    providerId: 'oidc-okta',
  })

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'TEAM_IDENTITY_MISMATCH')
  assert.equal(spy.calls.length, 0)
})

test('expectedTeam without a bearer is refused before the upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, { expectedTeam: EXPECTED })

  assert.equal(response.json().error.code, 'TEAM_IDENTITY_MISMATCH')
  assert.equal(spy.calls.length, 0)
  assertUntouched(response, spy, upstream)
})

test('an invalid bearer is refused before the upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: 'not-a-session-token',
    expectedTeam: EXPECTED,
  })

  assert.equal(response.json().error.code, 'TEAM_IDENTITY_MISMATCH')
  assert.equal(spy.calls.length, 0)
  assertUntouched(response, spy, upstream)
})

test('a revoked bearer (stale tokenVersion) is refused before the upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy, {
    users: [{ ...ALICE, tokenVersion: 2 }],
  })

  const response = await recoveryExchange(app, {
    bearer: aliceBearer(),
    expectedTeam: EXPECTED,
  })

  assert.equal(response.json().error.code, 'TEAM_IDENTITY_MISMATCH')
  assertUntouched(response, spy, upstream)
})

test('a bearer whose exact session was revoked is refused before the upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy, { activeSession: false })

  const response = await recoveryExchange(app, {
    bearer: aliceBearer(),
    expectedTeam: EXPECTED,
  })

  assert.equal(response.json().error.code, 'TEAM_IDENTITY_MISMATCH')
  assertUntouched(response, spy, upstream)
})

test('a local (non-UOA) bearer is refused before the upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ providerType: 'local', uoaIdentity: false }),
    expectedTeam: EXPECTED,
  })

  assert.equal(response.json().error.code, 'TEAM_IDENTITY_MISMATCH')
  assertUntouched(response, spy, upstream)
})

test('a bearer with a different providerId is refused before the upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ providerId: 'oidc-okta' }),
    expectedTeam: EXPECTED,
  })

  assert.equal(response.json().error.code, 'TEAM_IDENTITY_MISMATCH')
  assertUntouched(response, spy, upstream)
})
