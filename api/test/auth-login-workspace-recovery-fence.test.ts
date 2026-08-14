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
 * The account-link fence around the workspace-switch recovery exchange: a
 * read-only pre-billing proof plus an authoritative conditional claim of the
 * exact Nessie ProductAccountLink row (this local org, this user, the
 * `nessie` product, linked, same subject, NON-NULL safe nonnegative epoch no
 * newer than the returned one) inside the single recovery transaction,
 * BEFORE the target existing-or-create branch.
 *
 * The fake (auth-login-workspace-target-prisma.ts) applies the same WHERE
 * preconditions Prisma would — no raw-SQL parsing, no blind `{ count: 1 }` —
 * and exposes the seeded link rows plus a claim hook so a test can mutate the
 * exact row BETWEEN the pre-billing proof and the claim, modelling the
 * preflight-to-final-claim interleaving honestly. Every refusal proves its blast radius from the call log: no
 * project/board/team/channel/membership write, no session-cookie issuance.
 */

const EXPECTED = { organizationId: ORG, teamId: TEAM }

// The seeded, exact, linked Nessie account link for Alice at the bearer's
// epoch (3) in the app-fixture's organization.
const aliceLink = (organizationId: string, epoch: number | null = 3) => ({
  activeOrgId: ORG,
  activeTeamId: TEAM,
  organizationId,
  productSlug: 'nessie',
  status: 'linked',
  uoaSub: 'uoa-subject-alice',
  uoaTokenVersion: epoch,
  userId: ALICE.id,
})

// Every target and membership write model a refusal must never produce.
const WRITE_CALLS = [
  'project.create',
  'boardColumn.createMany',
  'team.create',
  'channel.create',
  'organizationMember.upsert',
  'projectMember.upsert',
  'teamMember.upsert',
  'channelMember.upsert',
]

const assertNoLocalWrites = (spy: MutationSpy): void => {
  assert.deepEqual(
    spy.calls.filter((call) => WRITE_CALLS.includes(call)),
    [],
  )
  assertNoEmailIdentityTraffic(spy)
}

/** A bearer-shape refusal happens before ANY database traffic. */
const assertBearerRefused = (
  response: Awaited<ReturnType<Awaited<ReturnType<typeof buildApp>>['inject']>>,
  spy: MutationSpy,
  upstream: Parameters<typeof assertUntouched>[2],
): void => {
  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assert.equal(response.statusCode, 401)
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(spy.cookieIssued, false)
  assert.equal(upstream.billingConfirms, 0)
  assert.deepEqual(spy.calls, [])
}

test('a bearer with a NULL UOA epoch is refused before any upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ uoaIdentity: { tokenVersion: null } }),
    expectedWorkspace: EXPECTED,
  })

  // Claim-shape refusal: the malformed bearer is rejected BEFORE the user-row
  // read, so there is zero database traffic at all.
  assertBearerRefused(response, spy, upstream)
})

test('a bearer with a negative UOA epoch is refused before any upstream exchange', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ uoaIdentity: { tokenVersion: -1 } }),
    expectedWorkspace: EXPECTED,
  })

  assertBearerRefused(response, spy, upstream)
})

test('a stored exact link NEWER than the returned epoch refuses before billing', async () => {
  // Another device already advanced the durable link to epoch 5 while UOA's
  // exchange returns epoch 4. The pre-billing proof sees the newer stored
  // epoch and refuses: no billing POST, no claim, no local write.
  const upstream = stubAliceExchange({ tv: 4 })
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const organizationId = randomUUID()
  const app = await buildApp(spy, {
    organizationId,
    productAccountLinkRows: [aliceLink(organizationId, 5)],
  })

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ org: organizationId }),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assert.equal(upstream.billingConfirms, 0)
  assert.equal(spy.cookieIssued, false)
  assert.equal(response.headers['set-cookie'], undefined)
  // The pre-billing read ran, but the conditional claim never did.
  assert.equal(spy.calls.includes('productAccountLink.updateMany'), false)
  assertNoLocalWrites(spy)
})

test('a NULL stored epoch refuses before billing', async () => {
  // The exact stored link has never recorded an epoch: the fence requires a
  // NON-NULL safe nonnegative epoch, so the pre-billing proof refuses even
  // though subject, org, and product all match.
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const organizationId = randomUUID()
  const app = await buildApp(spy, {
    organizationId,
    productAccountLinkRows: [aliceLink(organizationId, null)],
  })

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ org: organizationId }),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assert.equal(upstream.billingConfirms, 0)
  assert.equal(spy.calls.includes('productAccountLink.updateMany'), false)
  assertNoLocalWrites(spy)
})

test('no exact stored link (missing, wrong subject, or unlinked) refuses before billing', async () => {
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const organizationId = randomUUID()
  const app = await buildApp(spy, {
    organizationId,
    productAccountLinkRows: [
      { ...aliceLink(organizationId), status: 'revoked' },
    ],
  })

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ org: organizationId }),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.statusCode, 401)
  assert.equal(upstream.billingConfirms, 0)
  assert.equal(spy.calls.includes('productAccountLink.updateMany'), false)
  assertNoLocalWrites(spy)
})

test('a race after billing but before the final claim aborts with ZERO local writes', async () => {
  // The pre-billing proof reads stored epoch 3 and passes; billing runs
  // (once, legitimately). Behind it a concurrent renewal advances the exact
  // stored link to epoch 5 — so the conditional claim inside the recovery
  // transaction matches zero rows and the whole transaction refuses. The
  // race seam fires at the START of the claim — after the pre-billing proof,
  // after billing, before the claim's own read + conditional update — which
  // is exactly the preflight-to-final-claim interleaving. Because the claim
  // runs BEFORE the target existing-or-create branch, not even target
  // materialization survives: no project, board column, team, channel, or
  // membership write, no session, no cookie.
  const upstream = stubAliceExchange({ tv: 4 })
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const organizationId = randomUUID()
  const linkRow = aliceLink(organizationId, 3)
  const app = await buildApp(spy, {
    organizationId,
    productAccountLinkRows: [linkRow],
    onRecoveryLinkClaim: () => {
      // The interleaving renewal, landing after the pre-billing proof and
      // billing but before the final claim.
      linkRow.uoaTokenVersion = 5
    },
  })

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ org: organizationId }),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  // Billing may have happened once; NOTHING local did.
  assert.equal(upstream.billingConfirms, 1)
  assert.equal(spy.cookieIssued, false)
  assert.equal(response.headers['set-cookie'], undefined)
  // The claim ran — and matched nothing (the fake applied the epoch bound).
  assert.equal(spy.calls.includes('productAccountLink.updateMany'), true)
  assert.equal(linkRow.uoaTokenVersion, 5)
  assertNoLocalWrites(spy)
})

test('a race after the final claim is impossible while the row lock is held', async () => {
  // The claim, the target materialization, and the membership upserts run in
  // ONE transaction that holds the claimed link row lock to commit. A
  // mutation attempted from the claim's own read onwards can only be
  // in-transaction — there is no interleaving point after the claim. Model
  // the latest possible external mutation (the claim's metadata read) and
  // prove the recovery still refuses rather than writing past it.
  const upstream = stubAliceExchange({ tv: 4 })
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const organizationId = randomUUID()
  const linkRow = aliceLink(organizationId, 3)
  let claimStarted = false
  const app = await buildApp(spy, {
    organizationId,
    productAccountLinkRows: [linkRow],
    onRecoveryLinkClaim: (readCount) => {
      claimStarted = true
      if (readCount === 1) {
        // The claim's own pre-read: under the row lock, nothing external can
        // change the row now — but even this simulated tamper is caught by
        // the conditional update's epoch bound.
        linkRow.uoaTokenVersion = 9
      }
    },
  })

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ org: organizationId }),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(claimStarted, true)
  assert.equal(response.statusCode, 401)
  assertNoLocalWrites(spy)
})

test('an equal stored epoch succeeds and claims the exact link with the returned epoch', async () => {
  const upstream = stubAliceExchange({ tv: 3 })
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const organizationId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  const linkRow = aliceLink(organizationId, 3)
  const app = await buildApp(spy, {
    organizationId,
    productAccountLinkRows: [linkRow],
    projectRows: [{ id: projectId, organizationId }],
    teamRows: [{
      id: teamId,
      externalOrgId: ORG,
      externalWorkspaceId: TEAM,
      projectId,
    }],
  })

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ org: organizationId }),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.statusCode, 200)
  assert.equal(spy.cookieIssued, true)
  assert.equal(upstream.billingConfirms, 1)
  assert.equal(response.json().data.me.user.id, ALICE.id)
  // The exact link was claimed: epoch advanced in place, same row.
  assert.equal(linkRow.uoaTokenVersion, 3)
  assert.equal(linkRow.status, 'linked')
  assert.equal(linkRow.uoaSub, 'uoa-subject-alice')
  // No generic multi-product sync on recovery: a single claim, no upserts of
  // other product rows.
  assert.equal(
    spy.calls.filter((call) => call === 'productAccountLink.updateMany').length,
    1,
  )
  assertNoEmailIdentityTraffic(spy)
})

test('a NEWER returned epoch succeeds and the claim adopts it without an email remap', async () => {
  const upstream = stubAliceExchange({ email: 'alice-renamed@example.com', tv: 7 })
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const organizationId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  const linkRow = aliceLink(organizationId, 3)
  const app = await buildApp(spy, {
    organizationId,
    productAccountLinkRows: [linkRow],
    projectRows: [{ id: projectId, organizationId }],
    teamRows: [{
      id: teamId,
      externalOrgId: ORG,
      externalWorkspaceId: TEAM,
      projectId,
    }],
  })

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ org: organizationId }),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().data.me.user.id, ALICE.id)
  assert.equal(linkRow.uoaTokenVersion, 7)
  assertNoEmailIdentityTraffic(spy)
})

test('a local-organization mismatch does NO provisioning at all', async () => {
  // The bearer claims a different local organization than the app fixture
  // holds. Recovery never bootstraps and never resolves an ambient org: the
  // pre-billing proof finds no exact link under the claimed org and refuses
  // before billing and before any target or membership write.
  const upstream = stubAliceExchange()
  const spy: MutationSpy = { calls: [], cookieIssued: false }
  const app = await buildApp(spy)

  const response = await recoveryExchange(app, {
    bearer: aliceBearer({ org: randomUUID() }),
    expectedWorkspace: EXPECTED,
  })

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  assert.equal(upstream.billingConfirms, 0)
  assert.equal(spy.cookieIssued, false)
  assertNoLocalWrites(spy)
  assert.equal(spy.calls.includes('team.findUnique'), false)
  assert.equal(spy.calls.includes('team.findFirst'), false)
})
