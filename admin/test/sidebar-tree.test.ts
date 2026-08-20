import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChannelRecord, ProjectRecord, TeamRecord } from '../src/lib/api-client.js'
import { buildSidebarTree } from '../src/layouts/admin-shell/useSidebarTree.js'

const IDS = {
  otherProject: '00000000-0000-4000-8000-000000000001',
  otherTeam: '00000000-0000-4000-8000-000000000002',
  workspaceProject: '00000000-0000-4000-8000-000000000003',
  workspaceTeam: '00000000-0000-4000-8000-000000000004',
} as const

const project = (id: string, name: string): ProjectRecord => ({
  createdAt: '2026-08-20T10:00:00.000Z',
  id,
  memberCount: 1,
  name,
  organizationId: '00000000-0000-4000-8000-000000000005',
})

const channel = (id: string, projectId: string, teamId: string, label: string): ChannelRecord => ({
  archivedAt: null,
  createdAt: '2026-08-20T10:00:00.000Z',
  defaultThreadId: '00000000-0000-4000-8000-000000000006',
  description: null,
  id,
  label,
  lastMessageAt: null,
  memberRole: 'owner',
  muted: false,
  organizationId: '00000000-0000-4000-8000-000000000005',
  projectId,
  projectName: projectId === IDS.workspaceProject ? 'Selkie' : 'Other project',
  slug: label,
  teamId,
  teamName: projectId === IDS.workspaceProject ? 'Selkie' : 'Other team',
  topic: null,
  type: 'standard',
  unreadCount: 0,
  updatedAt: '2026-08-20T10:00:00.000Z',
  visibility: 'public',
})

test('the workspace channel list uses the active workspace, not a bootstrap UUID', () => {
  const tree = buildSidebarTree({
    channels: [
      channel('00000000-0000-4000-8000-000000000007', IDS.workspaceProject, IDS.workspaceTeam, 'general'),
      channel('00000000-0000-4000-8000-000000000008', IDS.otherProject, IDS.otherTeam, 'planning'),
    ],
    projects: [project(IDS.workspaceProject, 'Selkie'), project(IDS.otherProject, 'Other project')],
    starredChannelIds: new Set(),
    starredProjectIds: new Set(),
    teams: [
      { createdAt: '2026-08-20T10:00:00.000Z', id: IDS.workspaceTeam, memberCount: 1, name: 'Selkie', projectId: IDS.workspaceProject },
      { createdAt: '2026-08-20T10:00:00.000Z', id: IDS.otherTeam, memberCount: 1, name: 'Other team', projectId: IDS.otherProject },
    ] satisfies TeamRecord[],
    workspaceProjectId: IDS.workspaceProject,
    workspaceTeamId: IDS.workspaceTeam,
  })

  assert.deepEqual(tree.workspaceProjectChannels.map((entry) => entry.label), ['general'])
  assert.equal(tree.workspaceProjectName, 'Selkie')
  assert.equal(tree.workspaceProjectTeamId, IDS.workspaceTeam)
  assert.deepEqual(
    tree.visibleSidebarProjects.map((entry) => [entry.name, entry.channels.map((item) => item.label)]),
    [['Selkie', []], ['Other project', ['planning']]],
  )
})
