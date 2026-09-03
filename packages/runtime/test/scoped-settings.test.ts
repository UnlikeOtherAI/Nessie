import assert from 'node:assert/strict'
import test from 'node:test'

import { isLockedAbove, resolveFromRows } from '../src/scoped-settings.js'

const row = (
  scope: 'organization' | 'team' | 'user',
  value: unknown,
  locked = false,
) => ({ locked, scope, value: value as never })

test('the most specific level wins when nothing is locked', () => {
  const resolved = resolveFromRows<string>('calls.provider', [
    row('organization', 'google_meet'),
    row('team', 'jitsi'),
    row('user', 'teams'),
  ])
  assert.equal(resolved.value, 'teams')
  assert.equal(resolved.setAtScope, 'user')
  assert.equal(resolved.lockedAtScope, null)
})

test('a lock stops every level below it from overriding', () => {
  const resolved = resolveFromRows<string>('calls.provider', [
    row('organization', 'google_meet', true),
    row('team', 'jitsi'),
    row('user', 'teams'),
  ])
  assert.equal(resolved.value, 'google_meet')
  assert.equal(resolved.setAtScope, 'organization')
  assert.equal(resolved.lockedAtScope, 'organization')
})

test('a team lock leaves the organisation above it in force but stops the person', () => {
  const resolved = resolveFromRows<string>('calls.provider', [
    row('organization', 'google_meet'),
    row('team', 'jitsi', true),
    row('user', 'teams'),
  ])
  assert.equal(resolved.value, 'jitsi')
  assert.equal(resolved.lockedAtScope, 'team')
})

test('a row with no value locks whatever resolved above it', () => {
  // How a setting whose value lives in its own table — the cloud browser's
  // credential rows — is still governed by this one cascade.
  const resolved = resolveFromRows<string>('browser.connection', [
    row('organization', 'org-connection'),
    row('team', null, true),
    row('user', 'personal-connection'),
  ])
  assert.equal(resolved.value, 'org-connection')
  assert.equal(resolved.setAtScope, 'organization')
  assert.equal(resolved.lockedAtScope, 'team')
})

test('nothing set anywhere resolves to null rather than throwing', () => {
  const resolved = resolveFromRows<string>('calls.provider', [])
  assert.equal(resolved.value, null)
  assert.equal(resolved.setAtScope, null)
  assert.equal(resolved.lockedAtScope, null)
})

test('a level is read-only exactly when a level above it locked the key', () => {
  const orgLocked = resolveFromRows<string>('k', [row('organization', 'v', true)])
  assert.equal(isLockedAbove(orgLocked, 'organization'), false, 'the locking level still edits')
  assert.equal(isLockedAbove(orgLocked, 'team'), true)
  assert.equal(isLockedAbove(orgLocked, 'user'), true)

  const teamLocked = resolveFromRows<string>('k', [row('team', 'v', true)])
  assert.equal(isLockedAbove(teamLocked, 'organization'), false, 'a lock never binds upwards')
  assert.equal(isLockedAbove(teamLocked, 'team'), false)
  assert.equal(isLockedAbove(teamLocked, 'user'), true)
})
