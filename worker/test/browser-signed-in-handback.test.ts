import assert from 'node:assert/strict'
import test from 'node:test'

import { mayUseSignedInBrowser } from '../src/run/browser-cloud/browser-tools.js'

const PERSON = 'user-1'
const COLLEAGUE = 'user-2'

test('a browser nobody has signed in is open to any run, schedules included', () => {
  assert.equal(
    mayUseSignedInBrowser({ loginCount: 0, interactive: false, principalUserId: null }),
    true,
  )
})

/**
 * The bug this exists for. Pressing "Done" after driving the browser writes a
 * synthetic login, so `loginCount > 0` from then on. The old gate then read
 * `run.principalUserId` — the *binding's* principal, null in every ordinary
 * Personal Assistant conversation — and refused the agent its own browser for
 * good. The hand-over is meant to be a loop: the person signs in, hands back,
 * and the agent carries on.
 */
test('after a person signs in and hands back, their next turn can use it again', () => {
  assert.equal(
    mayUseSignedInBrowser({
      interactive: true,
      loginCount: 1,
      originatingUserId: PERSON,
      principalUserId: PERSON,
    }),
    true,
  )
})

test('a schedule may not act inside a signed-in browser', () => {
  assert.equal(
    mayUseSignedInBrowser({
      interactive: false,
      loginCount: 1,
      originatingUserId: PERSON,
      principalUserId: PERSON,
    }),
    false,
    'automation must not reach a session somebody signed in',
  )
  // `interactive` absent is automation too: the flag is set only on a live turn.
  assert.equal(
    mayUseSignedInBrowser({ loginCount: 1, originatingUserId: PERSON, principalUserId: PERSON }),
    false,
  )
})

test('a colleague may not drive a jar somebody else signed in', () => {
  assert.equal(
    mayUseSignedInBrowser({
      interactive: true,
      loginCount: 1,
      originatingUserId: COLLEAGUE,
      principalUserId: PERSON,
    }),
    false,
  )
})

/**
 * A team agent's browser is one jar shared with everyone who can reach the
 * agent — deliberately, and the sharing banner says so. Reaching the agent at
 * all is the authorization; the live-turn requirement is what still holds.
 */
test('a shared team jar is usable by anyone whose turn it is', () => {
  assert.equal(
    mayUseSignedInBrowser({
      interactive: true,
      loginCount: 3,
      originatingUserId: COLLEAGUE,
      principalUserId: null,
    }),
    true,
  )
  assert.equal(
    mayUseSignedInBrowser({ interactive: false, loginCount: 3, principalUserId: null }),
    false,
    'but never on a schedule',
  )
})
