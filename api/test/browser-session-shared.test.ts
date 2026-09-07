import assert from 'node:assert/strict'
import test from 'node:test'

import {
  browserSessionIsShared,
  viewerMaySeeCloudBrowserSession,
} from '../src/routes/browser-cloud.js'

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

test('an authenticated throwaway session is readable only by its requester', () => {
  const session = {
    agentBrowserId: null,
    authenticated: true,
    durableBrowserAllowed: false,
    requestedByUserId: 'requester',
  }
  assert.equal(viewerMaySeeCloudBrowserSession({ ...session, viewerId: 'requester' }), true)
  assert.equal(viewerMaySeeCloudBrowserSession({ ...session, viewerId: 'thread-member' }), false)
})

test('the durable-browser audience remains the authority for authenticated sessions', () => {
  const session = {
    agentBrowserId: 'browser-1',
    authenticated: true,
    requestedByUserId: 'requester',
    viewerId: 'signer',
  }
  assert.equal(viewerMaySeeCloudBrowserSession({ ...session, durableBrowserAllowed: true }), true)
  assert.equal(viewerMaySeeCloudBrowserSession({ ...session, durableBrowserAllowed: false }), false)
})
