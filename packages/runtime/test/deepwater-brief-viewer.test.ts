import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isDeepWaterRunVisible,
  type DeepWaterRunVisibilityInput,
} from '../src/deepwater-brief-viewer.js'
import type { DisclosureViewer } from '../src/disclosure-predicate.js'
import { computeReplyBasis } from '../src/disclosure-reply-basis.js'

const ORG = 'org-1'
const REQUESTER = 'user-requester'
const MEMBER = 'user-member'
const PROJECT_P = 'project-p'
const PROJECT_Q = 'project-q'

const originInQ = {
  chain: { organizationId: ORG, projectId: PROJECT_Q, teamId: 'team-q', channelId: 'channel-q' },
  boundAgentIds: ['agent-bound'],
}

const user = (userId: string, scopes: Array<[string, string]>): DisclosureViewer => ({
  kind: 'user',
  userId,
  scopes: scopes.map(([scopeType, scopeId]) => ({ scopeType, scopeId })),
})

const input = (overrides: Partial<DeepWaterRunVisibilityInput> = {}): DeepWaterRunVisibilityInput => ({
  run: {
    requestedByUserId: REQUESTER,
    originKind: 'agent',
    status: 'running',
    sourceScopes: [{ scopeType: 'project', scopeId: PROJECT_P }],
  },
  viewerUserId: MEMBER,
  viewer: user(MEMBER, [['organization', ORG], ['project', PROJECT_Q]]),
  originThreadReachable: true,
  originDestination: originInQ,
  ...overrides,
})

test('a run built from project P is withheld from a project-Q room member outside P', () => {
  assert.equal(isDeepWaterRunVisible(input()), false)
  assert.equal(
    isDeepWaterRunVisible(input({
      viewer: user(MEMBER, [['organization', ORG], ['project', PROJECT_Q], ['project', PROJECT_P]]),
    })),
    true,
  )
})

test('what the origin room already implies is never privileged there', () => {
  // Sources in the origin's own project, channel or bound agent restrict nothing.
  const run = {
    ...input().run,
    sourceScopes: [
      { scopeType: 'project', scopeId: PROJECT_Q },
      { scopeType: 'channel', scopeId: 'channel-q' },
      { scopeType: 'agent', scopeId: 'agent-bound' },
    ],
  }
  assert.deepEqual(computeReplyBasis(run.sourceScopes, originInQ.chain, originInQ.boundAgentIds), [])
  assert.equal(isDeepWaterRunVisible(input({ run, viewer: user(MEMBER, [['organization', ORG]]) })), true)
})

test('the requester keeps portable reach after leaving the origin room', () => {
  const requester = user(REQUESTER, [['organization', ORG], ['project', PROJECT_P]])
  assert.equal(
    isDeepWaterRunVisible(input({ viewerUserId: REQUESTER, viewer: requester, originThreadReachable: false })),
    true,
  )
  assert.equal(
    isDeepWaterRunVisible(input({ viewerUserId: REQUESTER, viewer: requester, originDestination: null })),
    true,
  )
})

test('a requester removed from the private channel the brief was built from loses it', () => {
  const run = { ...input().run, sourceScopes: [{ scopeType: 'channel', scopeId: 'private-c' }] }
  const removed = user(REQUESTER, [['organization', ORG]])
  assert.equal(
    isDeepWaterRunVisible(input({ run, viewerUserId: REQUESTER, viewer: removed, originThreadReachable: false })),
    false,
  )
})

test('nobody but the requester sees a person\'s brief before it is launched', () => {
  const personBrief = { ...input().run, originKind: 'person' as const, sourceScopes: [] }
  const member = user(MEMBER, [['organization', ORG]])
  for (const status of ['queued', 'drafting'] as const) {
    assert.equal(isDeepWaterRunVisible(input({ run: { ...personBrief, status }, viewer: member })), false)
    assert.equal(
      isDeepWaterRunVisible(input({
        run: { ...personBrief, status }, viewerUserId: REQUESTER, viewer: user(REQUESTER, []),
      })),
      true,
    )
  }
  assert.equal(isDeepWaterRunVisible(input({ run: { ...personBrief, status: 'running' }, viewer: member })), true)
  // An agent's brief is visible in its thread while it is being agreed.
  assert.equal(
    isDeepWaterRunVisible(input({ run: { ...personBrief, originKind: 'agent', status: 'drafting' }, viewer: member })),
    true,
  )
})

test('someone who cannot open the origin thread never sees another person\'s run', () => {
  const run = { ...input().run, sourceScopes: [] }
  assert.equal(isDeepWaterRunVisible(input({ run, originThreadReachable: false })), false)
})

test('a viewer whose live entitlement was revoked sees nothing, even their own run', () => {
  assert.equal(
    isDeepWaterRunVisible(input({ run: { ...input().run, sourceScopes: [] }, viewerUserId: REQUESTER, viewer: { kind: 'denied' } })),
    false,
  )
})
