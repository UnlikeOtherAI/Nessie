import assert from 'node:assert/strict'
import test from 'node:test'

import { agentBrowserLoginStatus } from '@nessie/browser-cloud'

import {
  browserDisclosureScope,
  mayUseSignedInBrowser,
} from '../src/run/browser-cloud/browser-tools.js'

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
 * A legacy team jar that carries a human login has no proof that every team
 * member consented. It is quarantined until reset; only an unsigned team jar
 * remains usable for ordinary shared automation.
 */
test('a human-signed shared team jar is quarantined for every team member', () => {
  const alice = agentBrowserLoginStatus({ loginCount: 3, principalUserId: null })
  const bob = agentBrowserLoginStatus({ loginCount: 3, principalUserId: null })
  assert.equal(alice.kind, 'legacy_team_human')
  assert.equal(alice.permitsSensitiveUse, false)
  assert.deepEqual(alice, bob, 'the quarantine is structural, not caller-specific')
  assert.equal(agentBrowserLoginStatus({ loginCount: 0, principalUserId: null }).permitsSensitiveUse, true)
})

/**
 * The hand-over is the point of the sign-in flow, and it has to work on a run
 * with no live turn behind it — the person pressed Done and may already have
 * walked away. It is answered by provenance rather than by claiming
 * `interactive`, which also decides delegated identity, agent handoff, app
 * setup and whether the budget treats a run as a human: four doors that a
 * button press must not open.
 */
test('a hand-back lets the agent pick that browser back up with no live turn', () => {
  assert.equal(
    mayUseSignedInBrowser({
      handedBackByUserId: PERSON,
      interactive: false,
      loginCount: 1,
      principalUserId: PERSON,
    }),
    true,
  )
})

test('a hand-back that has aged out is no longer a key', () => {
  // `handedBackByUserId` is already null by the time it reaches here once the
  // grace window has passed — resolved on the browser row, so no caller has to
  // know the rule.
  assert.equal(
    mayUseSignedInBrowser({
      handedBackByUserId: null,
      interactive: false,
      loginCount: 1,
      principalUserId: PERSON,
    }),
    false,
  )
})

test('a hand-back by somebody else does not open a person’s own jar', () => {
  assert.equal(
    mayUseSignedInBrowser({
      handedBackByUserId: COLLEAGUE,
      interactive: false,
      loginCount: 1,
      principalUserId: PERSON,
    }),
    false,
  )
})

test('without provenance an automated run is still refused', () => {
  assert.equal(
    mayUseSignedInBrowser({
      handedBackByUserId: null,
      interactive: false,
      loginCount: 1,
      originatingUserId: PERSON,
      principalUserId: PERSON,
    }),
    false,
    'the schedule protection must not have moved',
  )
})

test('a browser read with a personal jar stays in that person’s disclosure basis', () => {
  assert.deepEqual(
    browserDisclosureScope('agent-1', PERSON),
    { scopeId: PERSON, scopeType: 'user' },
  )
  assert.deepEqual(
    browserDisclosureScope('agent-1', null),
    { scopeId: 'agent-1', scopeType: 'agent' },
  )
})
