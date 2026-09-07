import assert from 'node:assert/strict'
import test from 'node:test'

import {
  browserSessionIsShared,
  viewerMaySeeCloudBrowserSession,
} from '../src/routes/browser-cloud.js'

const unsignedAgentRun = {
  agentBrowserId: 'browser-1',
  agentBrowserPrincipalUserId: null,
  authenticated: false,
  controlClaimedAt: null,
  controlledByUserId: null,
  durableBrowserAllowed: false,
  requestedByUserId: 'requester',
  runId: 'run-1',
}

test('a team agent’s one jar is shared', () => {
  assert.equal(browserSessionIsShared({ agentVisibility: 'team', principalUserId: null }), true)
})

test('a per-principal browser is nobody else’s, however visible the agent', () => {
  assert.equal(browserSessionIsShared({ agentVisibility: 'team', principalUserId: 'user-1' }), false)
})

test('a private agent’s browser reaches only its owner', () => {
  assert.equal(browserSessionIsShared({ agentVisibility: 'private', principalUserId: null }), false)
})

test('an unsigned public agent run remains observable to an entitled team viewer', () => {
  assert.equal(viewerMaySeeCloudBrowserSession({ ...unsignedAgentRun, viewerId: 'thread-member' }), true)
})

test('a current human control lease is private to its holder', () => {
  const claimedAt = new Date()
  assert.equal(viewerMaySeeCloudBrowserSession({
    ...unsignedAgentRun,
    controlClaimedAt: claimedAt,
    controlledByUserId: 'controller',
    viewerId: 'controller',
  }), true)
  assert.equal(viewerMaySeeCloudBrowserSession({
    ...unsignedAgentRun,
    controlClaimedAt: claimedAt,
    controlledByUserId: 'controller',
    viewerId: 'thread-member',
  }), false)
})

test('a resumed browser is requester-only before and after login handback', () => {
  const session = { ...unsignedAgentRun, runId: null }
  assert.equal(viewerMaySeeCloudBrowserSession({ ...session, viewerId: 'requester' }), true)
  assert.equal(viewerMaySeeCloudBrowserSession({ ...session, viewerId: 'thread-member' }), false)
})

test('an unsigned per-principal jar never opens to a colleague', () => {
  const session = { ...unsignedAgentRun, agentBrowserPrincipalUserId: 'owner' }
  assert.equal(viewerMaySeeCloudBrowserSession({ ...session, viewerId: 'owner' }), true)
  assert.equal(viewerMaySeeCloudBrowserSession({ ...session, viewerId: 'thread-member' }), false)
})

test('the durable-browser audience remains the authority after authentication', () => {
  const session = { ...unsignedAgentRun, authenticated: true, durableBrowserAllowed: true }
  assert.equal(viewerMaySeeCloudBrowserSession({ ...session, viewerId: 'signer' }), true)
  assert.equal(viewerMaySeeCloudBrowserSession({ ...session, durableBrowserAllowed: false, viewerId: 'thread-member' }), false)
})

test('a temporary grant remains private to its owner after the run adopts it', () => {
  const personalAccessGrant = { expiresAt: new Date(Date.now() + 60_000), status: 'active', userId: 'owner' }
  assert.equal(viewerMaySeeCloudBrowserSession({
    ...unsignedAgentRun,
    authenticated: true,
    personalAccessGrant,
    viewerId: 'owner',
  }), true)
  assert.equal(viewerMaySeeCloudBrowserSession({
    ...unsignedAgentRun,
    authenticated: true,
    personalAccessGrant,
    viewerId: 'thread-member',
  }), false)
})

test('a revoked or expired temporary grant cannot leave a browser doorway behind', () => {
  assert.equal(viewerMaySeeCloudBrowserSession({
    ...unsignedAgentRun,
    personalAccessGrant: { expiresAt: new Date(Date.now() + 60_000), status: 'revoked', userId: 'owner' },
    viewerId: 'owner',
  }), false)
  assert.equal(viewerMaySeeCloudBrowserSession({
    ...unsignedAgentRun,
    personalAccessGrant: { expiresAt: new Date(Date.now() - 1), status: 'active', userId: 'owner' },
    viewerId: 'owner',
  }), false)
})
