import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  ALICE,
  ORG,
  TEAM,
  aliceBearer,
  assertNoEmailIdentityTraffic,
  assertUntouched,
  buildApp,
  recoveryExchange,
  stubAliceExchange,
  type MutationSpy,
} from './auth-login-workspace-target-fixture.js'

/**
 * Success-and-discriminant coverage for the account-bound workspace-switch
 * recovery login: after the bearer and the exchanged UOA identity match on
 * the immutable subject, the renewed session is issued for the bearer's EXACT
 * local user — never a user resolved by the (possibly changed) email — and
 * every refusal still runs before the billing confirm. The email-remap
 * mismatch expectation is deliberately gone: identity is the UOA subject.
 */

const EXPECTED = { organizationId: ORG, teamId: TEAM }

test('Alice reauthorizing as Bob on the SAME target is an identity mismatch', async () => {
  const upstream = stubAliceExchange({ email: 'bob@example.com', subject: 'uoa-subject-bob' })
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer(),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assertUntouched(response, spy, upstream)
})

test('a wrong organization target is refused BEFORE the billing confirm', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer(),
    expectedWorkspace: { organizationId: 'uoa-org-b', teamId: TEAM },
  })

  assert.equal(response.json().error.code, 'WORKSPACE_TARGET_MISMATCH')
  assertUntouched(response, spy, upstream)
})

test('a wrong team within the same organization is refused BEFORE the billing confirm', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer(),
    expectedWorkspace: { organizationId: ORG, teamId: 'uoa-team-b' },
  })

  assert.equal(response.json().error.code, 'WORKSPACE_TARGET_MISMATCH')
  assertUntouched(response, spy, upstream)
})

test('same subject and target with a REGRESSED epoch is refused BEFORE any effect', async () => {
  // The bearer proves epoch 3 while UOA returns epoch 2: the returned session
  // is stale proof, refused as an identity mismatch even though the subject,
  // organization, and team all match exactly.
  const upstream = stubAliceExchange({ tv: 2 })
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer(),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assertUntouched(response, spy, upstream)
})

test('same subject with a newer epoch and an email colliding with another local user succeeds', async () => {
  // The exchanged email belongs to a DIFFERENT local user: an email lookup
  // would resolve (and hijack) that principal. The subject match is the
  // identity, so the session must come back for Alice's exact local UUID.
  const upstream = stubAliceExchange({ email: 'alice-alias@example.com', tv: 4 })
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const organizationId = randomUUID()
  const projectId = randomUUID()
  const app = await buildApp(spy, {
    organizationId,
    // The exact, linked Nessie account link the recovery fence claims: this
    // org, Alice, the nessie product, linked, bearer epoch 3 <= returned 4.
    productAccountLinkRows: [{
      activeOrgId: ORG,
      activeTeamId: TEAM,
      organizationId,
      productSlug: 'nessie',
      status: 'linked',
      uoaSub: 'uoa-subject-alice',
      uoaTokenVersion: 3,
      userId: ALICE.id,
    }],
    projectRows: [{ id: projectId, organizationId }],
    teamRows: [
      {
        id: randomUUID(),
        externalOrgId: ORG,
        externalWorkspaceId: TEAM,
        projectId,
      },
    ],
    users: [
      ALICE,
      { email: 'alice-alias@example.com', id: randomUUID(), tokenVersion: 1 },
    ],
  })

  const response = await recoveryExchange(app, {
    // The bearer's local organization claim IS the recovery's org scope: it
    // must be the seeded organization holding the exact link.
    bearer: aliceBearer({ org: organizationId }),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.statusCode, 200)
  assert.equal(spy.cookieIssued, true)
  assert.equal(upstream.billingConfirms, 1)
  const payload = response.json().data
  assert.equal(payload.token.length > 0, true)
  assert.equal(payload.me.user.id, ALICE.id)
  assertNoEmailIdentityTraffic(spy)
})
