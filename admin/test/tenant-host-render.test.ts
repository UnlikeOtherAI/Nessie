import assert from 'node:assert/strict'
import test from 'node:test'

import { tenantHostRender, type TenantHostRender } from '../src/layouts/tenant/tenant-host-render.js'

/** A team address, signed in, everything answered, session on the right team. */
const settled = {
  hostKind: 'team' as const,
  hostResolved: true,
  recovering: false,
  sessionState: 'authenticated' as const,
  signedIn: true,
  switchState: 'idle' as const,
  teamAnswered: true,
  teamFailed: false,
  teamKnown: true,
}

const renderOf = (facts: Partial<typeof settled>): TenantHostRender =>
  tenantHostRender({ ...settled, ...facts })

test('a settled team address renders the app', () => {
  assert.equal(renderOf({}), 'app')
})

/**
 * The defect: "I was taken to the correct URL, but I was still on the
 * UnlikeOtherAI organisation."
 *
 * Every state below used to fall through to `children`, mounting the app —
 * and its channel, project and search queries — in whatever team the previous
 * page left behind, under a URL naming a different one. None of them may.
 */
test('a team address never renders the app before it agrees with the session', () => {
  const mustNotBeApp: Array<[string, Partial<typeof settled>]> = [
    ['the switch onto this team is in flight', { switchState: 'switching' }],
    ['the switch was refused', { switchState: 'failed' }],
    ['/api/hosts/team failed', { teamFailed: true }],
    ['/api/hosts/team has not answered', { teamAnswered: false, teamKnown: false }],
    ['it answered with no team: UOA unreachable, or no longer federated', { teamKnown: false }],
    ['a bearer exists but /me has not answered yet', { sessionState: 'loading' }],
  ]
  for (const [because, facts] of mustNotBeApp) {
    assert.notEqual(renderOf(facts), 'app', because)
  }
})

test('an unverifiable address refuses; an undecided one waits', () => {
  assert.equal(renderOf({ switchState: 'failed' }), 'unavailable')
  assert.equal(renderOf({ teamFailed: true }), 'unavailable')
  assert.equal(renderOf({ teamKnown: false }), 'unavailable')
  assert.equal(renderOf({ switchState: 'switching' }), 'waiting')
  assert.equal(renderOf({ teamAnswered: false, teamKnown: false }), 'waiting')
  assert.equal(renderOf({ sessionState: 'loading' }), 'waiting')
})

test('signed out on a team address shows the tenant door, not the product', () => {
  assert.equal(
    renderOf({ sessionState: 'unauthenticated', signedIn: false, teamAnswered: false, teamKnown: false }),
    'sign-in',
  )
})

/**
 * First-run setup owns the screen. Holding it would be a blank page with no
 * way out on an install that has no organisation to switch into yet.
 */
test('the bootstrap flow is never held or branded', () => {
  assert.equal(
    renderOf({ sessionState: 'bootstrap', teamAnswered: false, teamKnown: false }),
    'app',
  )
})

test('an ordinary host and an organisation portal are unaffected', () => {
  assert.equal(renderOf({ hostKind: null, teamAnswered: false, teamKnown: false }), 'app')
  assert.equal(renderOf({ hostKind: 'organisation' }), 'portal')
  // A deployment with no tenant base domain answers `kind: null` for every
  // hostname, so nothing above ever runs there.
  assert.equal(
    renderOf({ hostKind: null, sessionState: 'loading', signedIn: false, teamAnswered: false, teamKnown: false }),
    'app',
  )
})

test('nothing of the tenant is drawn while a native shell leaves, or before the host resolves', () => {
  assert.equal(renderOf({ recovering: true }), 'recovering')
  assert.equal(renderOf({ hostResolved: false, hostKind: null }), 'resolving')
})
