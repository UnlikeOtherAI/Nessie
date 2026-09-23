import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isDeepWaterPersonBriefUnlaunched,
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

const IDENTITY = { subject: 'uoa|requester', organizationId: 'uoa-org', teamId: 'uoa-team', tokenVersion: 1 }
const LAUNCHED_AT = new Date('2026-09-23T09:00:00.000Z')

const input = (overrides: Partial<DeepWaterRunVisibilityInput> = {}): DeepWaterRunVisibilityInput => ({
  run: {
    requestedByUserId: REQUESTER,
    originKind: 'agent',
    uoaIdentity: IDENTITY,
    launchedAt: LAUNCHED_AT,
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
  const personBrief = { ...input().run, originKind: 'person' as const, launchedAt: null, sourceScopes: [] }
  const member = user(MEMBER, [['organization', ORG]])
  assert.equal(isDeepWaterPersonBriefUnlaunched(personBrief), true)
  assert.equal(isDeepWaterRunVisible(input({ run: personBrief, viewer: member })), false)
  assert.equal(
    isDeepWaterRunVisible(input({ run: personBrief, viewerUserId: REQUESTER, viewer: user(REQUESTER, []) })),
    true,
  )
  assert.equal(isDeepWaterRunVisible(input({ run: { ...personBrief, launchedAt: LAUNCHED_AT }, viewer: member })), true)
  // An agent's brief is visible in its thread while it is being agreed.
  assert.equal(isDeepWaterRunVisible(input({ run: { ...personBrief, originKind: 'agent' }, viewer: member })), true)
})

test('a person\'s brief that ended without a launch stays theirs alone', () => {
  // Cancelled, reaped (failed/start_unconfirmed) or refused (failed/scope_rejected)
  // before launch: its status says it ended, but the room was never shown it,
  // so its topic never reaches the room through the list, detail, card or files.
  const ended = { ...input().run, originKind: 'person' as const, launchedAt: null, sourceScopes: [] }
  const member = user(MEMBER, [['organization', ORG]])
  assert.equal(isDeepWaterRunVisible(input({ run: ended, viewer: member })), false)
  assert.equal(isDeepWaterRunVisible(input({ run: ended, viewerUserId: REQUESTER, viewer: user(REQUESTER, []) })), true)
})

test('a launcher run was never a brief: its room sees it as before', () => {
  const launcher = { ...input().run, originKind: 'person' as const, uoaIdentity: null, launchedAt: null, sourceScopes: [] }
  assert.equal(isDeepWaterPersonBriefUnlaunched(launcher), false)
  assert.equal(isDeepWaterRunVisible(input({ run: launcher, viewer: user(MEMBER, [['organization', ORG]]) })), true)
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
