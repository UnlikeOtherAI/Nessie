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
} from './auth-login-workspace-target-fixture.js'

/**
 * Refusal coverage for the account-bound workspace-switch recovery
 * discriminant on POST /api/auth/session: expectedWorkspace is valid ONLY as
 * a complete providerId=uoa code exchange accompanied by a current Bearer
 * Nessie session for the same immutable UOA identity. Every refusal runs
 * BEFORE the billing confirm (a POST side effect), before any local mutation,
 * and before Set-Cookie, so a rejected exchange leaves the existing session
 * and refresh family untouched. The UOA upstream and the database are faked;
 * the route registrar is real. Success-path coverage lives in
 * auth-login-workspace-recovery-success.test.ts.
 */

const EXPECTED = { organizationId: ORG, teamId: TEAM }

test('expectedWorkspace with a password login is refused before any exchange', async () => {
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/session',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      email: 'alice@example.com',
      expectedWorkspace: EXPECTED,
      password: 'password-1',
    }),
  })

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(spy.calls.length, 0)
})

test('expectedWorkspace with a required code tuple field omitted is refused', async () => {
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer(),
    expectedWorkspace: EXPECTED,
    omitCodeVerifier: true,
  })

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assert.equal(spy.calls.length, 0)
})

test('expectedWorkspace with a non-uoa provider is refused before any exchange', async () => {
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer(),
    expectedWorkspace: EXPECTED,
    providerId: 'oidc-okta',
  })

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assert.equal(spy.calls.length, 0)
})

test('expectedWorkspace without a bearer is refused before the upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, { expectedWorkspace: EXPECTED })

  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assert.equal(spy.calls.length, 0)
  assertUntouched(response, spy, upstream)
})

test('an invalid bearer is refused before the upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: 'not-a-session-token',
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
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
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assertUntouched(response, spy, upstream)
})

test('a local (non-UOA) bearer is refused before the upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ providerType: 'local', uoaIdentity: false }),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assertUntouched(response, spy, upstream)
})

test('a bearer with a different providerId is refused before the upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ providerId: 'oidc-okta' }),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assertUntouched(response, spy, upstream)
})
