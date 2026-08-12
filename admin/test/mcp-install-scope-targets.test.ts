import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ChannelRecord,
  ProjectRecord,
  TeamRecord,
} from '../src/lib/api-client.js'
import {
  defaultScopeTargetId,
  scopeTargetChoices,
  type ScopeTargetSources,
} from '../src/components/features/mcp-app-store/install-scope-targets.js'

const project = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  createdAt: '2026-08-01T00:00:00.000Z',
  id: 'project-1',
  memberCount: 3,
  name: 'Ops',
  organizationId: 'org-1',
  ...overrides,
})

const team = (overrides: Partial<TeamRecord> = {}): TeamRecord => ({
  createdAt: '2026-08-01T00:00:00.000Z',
  id: 'team-1',
  memberCount: 2,
  name: 'Platform',
  projectId: 'project-1',
  ...overrides,
})

const channel = (overrides: Partial<ChannelRecord> = {}): ChannelRecord => ({
  createdAt: '2026-08-01T00:00:00.000Z',
  defaultThreadId: 'thread-1',
  id: 'channel-1',
  label: 'support',
  organizationId: 'org-1',
  projectId: 'project-1',
  projectName: 'Ops',
  teamId: 'team-1',
  teamName: 'Platform',
  type: 'standard',
  unreadCount: 0,
  updatedAt: '2026-08-01T00:00:00.000Z',
  visibility: 'public',
  ...overrides,
})

const sources = (overrides: Partial<ScopeTargetSources> = {}): ScopeTargetSources => ({
  organization: { id: 'org-1', label: 'Acme' },
  currentUser: { id: 'user-1', label: 'Ada Lovelace' },
  projects: [project()],
  teams: [team()],
  channels: [channel()],
  ...overrides,
})

test('organization and user scopes have exactly one target, so no picker', () => {
  // Organisation behaviour is unchanged: the id is still the session's org.
  assert.deepEqual(scopeTargetChoices('organization', sources()), {
    kind: 'fixed',
    target: { id: 'org-1', label: 'Acme' },
  })
  assert.deepEqual(scopeTargetChoices('user', sources()), {
    kind: 'fixed',
    target: { id: 'user-1', label: 'Ada Lovelace' },
  })
})

test('project, team and channel scopes list what the viewer can already see', () => {
  const choices = scopeTargetChoices(
    'project',
    sources({ projects: [project({ id: 'project-2', name: 'Zebra' }), project()] }),
  )
  assert.deepEqual(choices, {
    kind: 'list',
    targets: [
      { id: 'project-1', label: 'Ops' },
      { id: 'project-2', label: 'Zebra' },
    ],
  })

  // A team is ambiguous without its project — two projects can both have "Platform".
  assert.deepEqual(scopeTargetChoices('team', sources()), {
    kind: 'list',
    targets: [{ id: 'team-1', label: 'Ops / Platform' }],
  })

  assert.deepEqual(scopeTargetChoices('channel', sources()), {
    kind: 'list',
    targets: [{ id: 'channel-1', label: '#support · Ops / Platform' }],
  })
})

test('a team whose project is not in the list still names itself', () => {
  const choices = scopeTargetChoices('team', sources({ projects: [] }))
  assert.deepEqual(choices, { kind: 'list', targets: [{ id: 'team-1', label: 'Platform' }] })
})

test('a DM channel is labelled as one rather than as a #channel', () => {
  const choices = scopeTargetChoices(
    'channel',
    sources({ channels: [channel({ label: 'Grace Hopper', type: 'dm' })] }),
  )
  assert.deepEqual(choices, {
    kind: 'list',
    targets: [{ id: 'channel-1', label: 'DM · Grace Hopper' }],
  })
})

test('system scope keeps the raw id — this dialog cannot reach it', () => {
  assert.deepEqual(scopeTargetChoices('system', sources()), { kind: 'freeform' })
})

test('defaultScopeTargetId picks the only target, the first of a list, or nothing', () => {
  assert.equal(defaultScopeTargetId(scopeTargetChoices('organization', sources())), 'org-1')
  assert.equal(defaultScopeTargetId(scopeTargetChoices('project', sources())), 'project-1')
  assert.equal(
    defaultScopeTargetId(scopeTargetChoices('project', sources({ projects: [] }))),
    '',
  )
  assert.equal(defaultScopeTargetId(scopeTargetChoices('system', sources())), '')
})
