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
const childAgentId = '00000000-0000-4000-8000-000000000009'

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
  ownerAgentId: null,
  ...overrides,
})

const agentScopes = (overrides: Partial<SpaceViewerAgentScopes> = {}): SpaceViewerAgentScopes => ({
  id: agentId,
  parentAgentId: null,
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
  visibleAgentIds: new Set(),
  agent: agentScopes(overrides),
})

const userViewer = (overrides: Partial<SpaceViewer> = {}): SpaceViewer => ({
  bypass: false,
  userId: 'user-1',
  projectIds: new Set(),
  visibleAgentIds: new Set(),
  ...overrides,
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

test('an owning agent and its child can read and write the home, while an unrelated agent cannot', () => {
  const home = space({ visibility: 'private', ownerAgentId: agentId })

  assert.equal(canReadSpace(home, agentViewer()), true)
  assert.equal(canWriteSpace(home, agentViewer()), true)
  assert.equal(
    canReadSpace(home, agentViewer({ id: otherAgentId, parentAgentId: agentId })),
    true,
  )
  assert.equal(
    canWriteSpace(home, agentViewer({ id: otherAgentId, parentAgentId: agentId })),
    true,
  )
  assert.equal(canReadSpace(home, agentViewer({ id: otherAgentId })), false)
  assert.equal(canWriteSpace(home, agentViewer({ id: otherAgentId })), false)
})

test('restricted sensitivity still denies the agent that owns the documents home', () => {
  const home = space({
    visibility: 'private',
    ownerAgentId: agentId,
    sensitivityTier: 'restricted',
  })

  assert.equal(canReadSpace(home, agentViewer()), false)
  assert.equal(canWriteSpace(home, agentViewer()), false)
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

test('a user reads an agent-owned space exactly when they can see its agent', () => {
  const owned = space({
    createdBy: agentId,
    ownerAgentId: agentId,
    visibility: 'private',
  })
  assert.equal(
    canReadSpace(owned, userViewer({ visibleAgentIds: new Set([agentId]) })),
    true,
  )
  assert.equal(canReadSpace(owned, userViewer()), false)
  assert.equal(
    canReadSpace(space({ ...owned, memberUserIds: ['user-1'] }), userViewer()),
    true,
  )
})

test('an agent-owned space never falls through to organization or project visibility', () => {
  const facts = { createdBy: otherAgentId, ownerAgentId: agentId }
  assert.equal(
    canReadSpace(space({ ...facts, visibility: 'organization' }), userViewer()),
    false,
  )
  assert.equal(
    canReadSpace(
      space({ ...facts, projectId, visibility: 'project' }),
      userViewer({ projectIds: new Set([projectId]) }),
    ),
    false,
  )
})

test('the owning agent and its subtask child can read and write the documents home', () => {
  const owned = space({
    createdBy: 'provisioner',
    ownerAgentId: agentId,
    visibility: 'private',
  })
  const child = agentViewer({ id: childAgentId, parentAgentId: agentId })
  const unrelated = agentViewer({ id: otherAgentId })

  assert.equal(canReadSpace(owned, agentViewer()), true)
  assert.equal(canWriteSpace(owned, agentViewer()), true)
  assert.equal(canReadSpace(owned, child), true)
  assert.equal(canWriteSpace(owned, child), true)
  assert.equal(canReadSpace(owned, unrelated), false)
  assert.equal(canWriteSpace(owned, unrelated), false)
})

test('restricted sensitivity still denies the owning agent', () => {
  const restricted = space({
    createdBy: 'provisioner',
    ownerAgentId: agentId,
    sensitivityTier: 'restricted',
    visibility: 'private',
  })
  assert.equal(canReadSpace(restricted, agentViewer()), false)
  assert.equal(canWriteSpace(restricted, agentViewer()), false)
})

test('writeRestricted narrows agent-owned human writes to explicit members', () => {
  const restrictedWrite = space({
    createdBy: agentId,
    ownerAgentId: agentId,
    visibility: 'private',
    writeRestricted: true,
  })
  const visible = userViewer({ visibleAgentIds: new Set([agentId]) })
  assert.equal(canReadSpace(restrictedWrite, visible), true)
  assert.equal(canWriteSpace(restrictedWrite, visible), false)
  assert.equal(
    canWriteSpace(space({ ...restrictedWrite, memberUserIds: ['user-1'] }), visible),
    true,
  )
})

test('user access semantics are unchanged: creator, org, project-membership, and explicit member arms', () => {
  const userId = 'user-1'
  const userViewer = (overrides: Partial<SpaceViewer> = {}): SpaceViewer => ({
    bypass: false,
    userId,
    projectIds: new Set(),
    visibleAgentIds: new Set(),
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

test('human read and write access to an agent home follows visible agent ids', () => {
  const userId = 'user-1'
  const home = space({
    createdBy: agentId,
    ownerAgentId: agentId,
    visibility: 'private',
  })
  const visible: SpaceViewer = {
    bypass: false,
    userId,
    projectIds: new Set(),
    visibleAgentIds: new Set([agentId]),
  }
  const hidden: SpaceViewer = {
    ...visible,
    visibleAgentIds: new Set(),
  }

  assert.equal(canReadSpace(home, visible), true)
  assert.equal(canWriteSpace(home, visible), true)
  assert.equal(canReadSpace(home, hidden), false)
  assert.equal(canWriteSpace(home, hidden), false)
})

test('an agent home never falls through organization or project visibility', () => {
  const viewer: SpaceViewer = {
    bypass: false,
    userId: 'user-1',
    projectIds: new Set([projectId]),
    visibleAgentIds: new Set(),
  }

  assert.equal(
    canReadSpace(space({ ownerAgentId: agentId, visibility: 'organization' }), viewer),
    false,
  )
  assert.equal(
    canReadSpace(space({ ownerAgentId: agentId, visibility: 'project' }), viewer),
    false,
  )
})

test('writeRestricted narrows an agent home to explicit human members', () => {
  const userId = 'user-1'
  const viewer: SpaceViewer = {
    bypass: false,
    userId,
    projectIds: new Set(),
    visibleAgentIds: new Set([agentId]),
  }
  const home = space({
    ownerAgentId: agentId,
    visibility: 'private',
    writeRestricted: true,
  })

  assert.equal(canReadSpace(home, viewer), true)
  assert.equal(canWriteSpace(home, viewer), false)
  assert.equal(canWriteSpace({ ...home, memberUserIds: [userId] }, viewer), true)
})

test('bypass viewers keep full read/write access regardless of space facts', () => {
  const bypassViewer: SpaceViewer = {
    bypass: true,
    userId: null,
    projectIds: new Set(),
    visibleAgentIds: new Set(),
  }
  const s = space({ visibility: 'private', sensitivityTier: 'restricted' })
  assert.equal(canReadSpace(s, bypassViewer), true)
  assert.equal(canWriteSpace(s, bypassViewer), true)
})
