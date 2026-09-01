import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChannelRecord, ProjectRecord, TeamRecord } from '../src/lib/api-client.js'
import { buildSidebarTree } from '../src/layouts/admin-shell/useSidebarTree.js'

const IDS = {
  otherProject: '00000000-0000-4000-8000-000000000001',
  otherTeam: '00000000-0000-4000-8000-000000000002',
  selkieProject: '00000000-0000-4000-8000-000000000003',
  selkieTeam: '00000000-0000-4000-8000-000000000004',
  standaloneProject: '00000000-0000-4000-8000-000000000005',
  standaloneTeam: '00000000-0000-4000-8000-000000000006',
} as const

const project = (id: string, name: string): ProjectRecord => ({
  avatarAttachmentId: null,
  avatarEmoji: null,
  createdAt: '2026-08-20T10:00:00.000Z',
  id,
  memberCount: 1,
  name,
  organizationId: '00000000-0000-4000-8000-000000000007',
})

const channel = (
  id: string,
  projectId: string,
  teamId: string,
  label: string,
  scope: ChannelRecord['scope'] = 'project',
): ChannelRecord => ({
  archivedAt: null,
  createdAt: '2026-08-20T10:00:00.000Z',
  defaultThreadId: '00000000-0000-4000-8000-000000000008',
  description: null,
  id,
  label,
  lastMessageAt: null,
  memberRole: 'owner',
  muted: false,
  organizationId: '00000000-0000-4000-8000-000000000007',
  projectId,
  projectName: projectId === IDS.selkieProject ? 'Selkie' : 'Other project',
  scope,
  slug: label,
  teamId,
  teamName: projectId === IDS.selkieProject ? 'Selkie' : 'Other team',
  topic: null,
  type: 'standard',
  unreadCount: 0,
  updatedAt: '2026-08-20T10:00:00.000Z',
  visibility: 'public',
})

test('standalone channels do not displace channels from their projects', () => {
  const tree = buildSidebarTree({
    channels: [
      channel('00000000-0000-4000-8000-000000000009', IDS.selkieProject, IDS.selkieTeam, 'general'),
      channel('00000000-0000-4000-8000-000000000010', IDS.standaloneProject, IDS.standaloneTeam, 'general', 'standalone'),
      channel('00000000-0000-4000-8000-000000000011', IDS.otherProject, IDS.otherTeam, 'planning'),
    ],
    projects: [project(IDS.selkieProject, 'Selkie'), project(IDS.otherProject, 'Other project')],
    starredChannelIds: new Set(),
    starredProjectIds: new Set(),
    teams: [
      { createdAt: '2026-08-20T10:00:00.000Z', id: IDS.selkieTeam, memberCount: 1, name: 'Selkie', projectId: IDS.selkieProject },
      { createdAt: '2026-08-20T10:00:00.000Z', id: IDS.otherTeam, memberCount: 1, name: 'Other team', projectId: IDS.otherProject },
    ] satisfies TeamRecord[],
  })

  assert.deepEqual(tree.standaloneChannels.map((entry) => entry.label), ['general'])
  assert.deepEqual(
    tree.visibleSidebarProjects.map((entry) => [entry.name, entry.channels.map((item) => item.label)]),
    [['Selkie', ['general']], ['Other project', ['planning']]],
  )
})
