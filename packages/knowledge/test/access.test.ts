import assert from 'node:assert/strict'
import test from 'node:test'

import { canReadSpace, canWriteSpace, type SpaceViewer, type SpaceViewerAgentScopes } from '../src/access.js'

const projectId = '00000000-0000-4000-8000-000000000001'
const otherProjectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const otherTeamId = '00000000-0000-4000-8000-000000000004'
const channelId = '00000000-0000-4000-8000-000000000005'
const otherChannelId = '00000000-0000-4000-8000-000000000006'
const agentId = '00000000-0000-4000-8000-000000000007'
const otherAgentId = '00000000-0000-4000-8000-000000000008'

type SpaceFacts = Parameters<typeof canReadSpace>[0]

const space = (overrides: Partial<SpaceFacts> = {}): SpaceFacts => ({
  visibility: 'project',
  writeRestricted: false,
  projectId,
  teamId: null,
  channelId: null,
  createdBy: 'user-1',
  memberUserIds: [],
  memberAgentIds: [],
  sensitivityTier: 'normal',
  privateToAgentId: null,
  ...overrides,
})

const agentScopes = (overrides: Partial<SpaceViewerAgentScopes> = {}): SpaceViewerAgentScopes => ({
  id: agentId,
  orgBound: false,
  channelIds: new Set(),
  teamIds: new Set(),
  projectIds: new Set(),
  memberSpaceIds: new Set(),
  ...overrides,
})

const agentViewer = (overrides: Partial<SpaceViewerAgentScopes> = {}): SpaceViewer => ({
  bypass: false,
  userId: null,
  projectIds: new Set(),
  agent: agentScopes(overrides),
})

test('canReadSpace denies an agent everything on a restricted space, even with an explicit grant', () => {
  const restricted = space({
    sensitivityTier: 'restricted',
    privateToAgentId: agentId,
    createdBy: agentId,
    memberAgentIds: [agentId],
    visibility: 'organization',
  })
  assert.equal(canReadSpace(restricted, agentViewer({ orgBound: true })), false)
})

test('canReadSpace grants an agent access to its own private-to-agent space', () => {
  const s = space({ visibility: 'private', privateToAgentId: agentId })
  assert.equal(canReadSpace(s, agentViewer()), true)
  assert.equal(canReadSpace(s, agentViewer({ id: otherAgentId })), false)
})

test('canReadSpace grants the agent creator access regardless of visibility', () => {
  const s = space({ visibility: 'private', createdBy: agentId })
  assert.equal(canReadSpace(s, agentViewer()), true)
})

test('canReadSpace grants an agent access via an explicit KnowledgeSpaceMember grant', () => {
  const s = space({ visibility: 'private', memberAgentIds: [agentId] })
  assert.equal(canReadSpace(s, agentViewer()), true)
  assert.equal(canReadSpace(s, agentViewer({ id: otherAgentId })), false)
})

test('canReadSpace grants organization-visibility spaces only to org-bound agents', () => {
  const s = space({ visibility: 'organization' })
  assert.equal(canReadSpace(s, agentViewer({ orgBound: true })), true)
  assert.equal(canReadSpace(s, agentViewer({ orgBound: false })), false)
})

test('canReadSpace grants project-visibility spaces only when the agent reaches that project', () => {
  const s = space({ visibility: 'project', projectId })
  assert.equal(canReadSpace(s, agentViewer({ projectIds: new Set([projectId]) })), true)
  assert.equal(canReadSpace(s, agentViewer({ projectIds: new Set([otherProjectId]) })), false)
})

test('canReadSpace grants team-visibility spaces only when the agent reaches that team', () => {
  const s = space({ visibility: 'team', teamId })
  assert.equal(canReadSpace(s, agentViewer({ teamIds: new Set([teamId]) })), true)
  assert.equal(canReadSpace(s, agentViewer({ teamIds: new Set([otherTeamId]) })), false)
  assert.equal(canReadSpace(space({ visibility: 'team', teamId: null }), agentViewer({ teamIds: new Set([teamId]) })), false)
})

test('canReadSpace grants channel-visibility spaces only when the agent reaches that channel', () => {
  const s = space({ visibility: 'channel', channelId })
  assert.equal(canReadSpace(s, agentViewer({ channelIds: new Set([channelId]) })), true)
  assert.equal(canReadSpace(s, agentViewer({ channelIds: new Set([otherChannelId]) })), false)
  assert.equal(
    canReadSpace(space({ visibility: 'channel', channelId: null }), agentViewer({ channelIds: new Set([channelId]) })),
    false,
  )
})

test('canReadSpace denies an agent a private space with no explicit grant', () => {
  const s = space({ visibility: 'private' })
  assert.equal(canReadSpace(s, agentViewer({ orgBound: true, projectIds: new Set([projectId]) })), false)
})

test('canWriteSpace writeRestricted: agent needs an explicit grant, visibility reach is not enough', () => {
  const s = space({ visibility: 'organization', writeRestricted: true })
  assert.equal(canWriteSpace(s, agentViewer({ orgBound: true })), false)
  assert.equal(canWriteSpace(space({ ...s, memberAgentIds: [agentId] }), agentViewer({ orgBound: true })), true)
  assert.equal(
    canWriteSpace(space({ ...s, privateToAgentId: agentId }), agentViewer({ orgBound: true })),
    true,
  )
})

test('canWriteSpace still denies restricted spaces to agents even when writeRestricted grants a member', () => {
  const s = space({
    visibility: 'organization',
    writeRestricted: true,
    sensitivityTier: 'restricted',
    memberAgentIds: [agentId],
  })
  assert.equal(canWriteSpace(s, agentViewer({ orgBound: true })), false)
})

test('canWriteSpace non-writeRestricted: agent write follows the same rules as read', () => {
  const s = space({ visibility: 'project', projectId })
  assert.equal(canWriteSpace(s, agentViewer({ projectIds: new Set([projectId]) })), true)
  assert.equal(canWriteSpace(s, agentViewer({ projectIds: new Set([otherProjectId]) })), false)
})

test('user access semantics are unchanged: creator, org, project-membership, and explicit member arms', () => {
  const userId = 'user-1'
  const userViewer = (overrides: Partial<SpaceViewer> = {}): SpaceViewer => ({
    bypass: false,
    userId,
    projectIds: new Set(),
    ...overrides,
  })

  assert.equal(canReadSpace(space({ createdBy: userId, visibility: 'private' }), userViewer()), true)
  assert.equal(canReadSpace(space({ visibility: 'organization' }), userViewer()), true)
  assert.equal(
    canReadSpace(space({ visibility: 'project', projectId }), userViewer({ projectIds: new Set([projectId]) })),
    true,
  )
  assert.equal(
    canReadSpace(
      space({ visibility: 'project', projectId, createdBy: 'someone-else' }),
      userViewer({ projectIds: new Set([otherProjectId]) }),
    ),
    false,
  )
  assert.equal(canReadSpace(space({ visibility: 'private', memberUserIds: [userId] }), userViewer()), true)
  assert.equal(canReadSpace(space({ visibility: 'private', createdBy: 'someone-else' }), userViewer()), false)
})

test('bypass viewers keep full read/write access regardless of space facts', () => {
  const bypassViewer: SpaceViewer = { bypass: true, userId: null, projectIds: new Set() }
  const s = space({ visibility: 'private', sensitivityTier: 'restricted' })
  assert.equal(canReadSpace(s, bypassViewer), true)
  assert.equal(canWriteSpace(s, bypassViewer), true)
})
