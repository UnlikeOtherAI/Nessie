import assert from 'node:assert/strict'
import test from 'node:test'

import { browserSessionIsShared } from '../src/routes/browser-cloud.js'

/**
 * The viewer prints this answer as a sentence above a sign-in box, so it is
 * worth more than an inline expression. It was previously read off the agent's
 * visibility, which is a statement about who can talk to the agent and says
 * nothing about whose cookies it keeps.
 */
test('a team agent’s one jar is shared', () => {
  assert.equal(
    browserSessionIsShared({ agentVisibility: 'team', principalUserId: null }),
    true,
  )
})

test('a per-principal browser is nobody else’s, however visible the agent', () => {
  // The Personal Assistant: one agent row per organisation, one context per
  // person. Telling its driver their sign-in is shared is simply false.
  assert.equal(
    browserSessionIsShared({ agentVisibility: 'team', principalUserId: 'user-1' }),
    false,
  )
})

test('a private agent’s browser reaches only its owner', () => {
  assert.equal(
    browserSessionIsShared({ agentVisibility: 'private', principalUserId: null }),
    false,
  )
})

test('a session with no durable browser keeps nothing to share', () => {
  // `principalUserId` absent rather than null: there is no browser row at all.
  assert.equal(browserSessionIsShared({ agentVisibility: 'team' }), false)
  assert.equal(
    browserSessionIsShared({ agentVisibility: 'team', principalUserId: undefined }),
    false,
  )
})
