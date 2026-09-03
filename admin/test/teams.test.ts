import assert from 'node:assert/strict'
import test from 'node:test'

import type { MeResponse } from '@nessie/schemas'
import {
  activeTeam,
  orderTeamsWithActiveFirst,
  teamsFromMe,
  type Team,
} from '../src/lib/teams.js'

const uoaMe = {
  auth: { providerId: 'uoa', providerType: 'uoa', autoRedirectToSso: false },
  context: {
    organizationId: 'local-org',
    projectId: 'local-project',
    teamId: 'local-team',
    bootstrapMode: false,
  },
  memberships: [{
    organizationId: 'local-org',
    organizationName: 'Local organization',
    role: 'member',
    projects: [{
      projectId: 'local-project',
      projectName: 'Local project',
      teams: [{ teamId: 'local-team', teamName: 'Only locally provisioned team' }],
    }],
  }],
  session: { sessionId: 'session', issuedAt: '2026-08-13T00:00:00.000Z' },
  uoaTeams: [
    {
      organizationId: 'uoa-org-current',
      teamId: 'uoa-team-current',
      avatarTeamId: '00000000-0000-4000-8000-000000000003',
      avatarImageUrl: 'https://authentication.example/teams/uoa-team-current/avatar',
      label: 'Current team',
      orgName: 'Nessie Works',
      active: true,
    },
    {
      organizationId: 'uoa-org-other',
      teamId: 'uoa-team-other',
      avatarImageUrl: 'https://authentication.example/teams/uoa-team-other/avatar',
      label: 'Another authorized team',
      orgName: 'Ondrej’s Team',
      active: false,
    },
  ],
  user: {
    id: 'user',
    email: 'person@example.com',
    displayName: 'Person',
    roleIds: ['member'],
    superAdmin: false,
  },
} as unknown as MeResponse

test('UOA sessions render the authoritative directory rather than local provisioning membership', () => {
  assert.deepEqual(teamsFromMe(uoaMe), [
    {
      organizationId: 'uoa-org-current',
      projectId: '',
      teamId: 'uoa-team-current',
      avatarTeamId: '00000000-0000-4000-8000-000000000003',
      avatarImageUrl: 'https://authentication.example/teams/uoa-team-current/avatar',
      label: 'Current team',
      orgName: 'Nessie Works',
      active: true,
      uoaTeam: true,
    },
    {
      organizationId: 'uoa-org-other',
      projectId: '',
      teamId: 'uoa-team-other',
      avatarImageUrl: 'https://authentication.example/teams/uoa-team-other/avatar',
      label: 'Another authorized team',
      orgName: 'Ondrej’s Team',
      active: false,
      uoaTeam: true,
    },
  ])
  assert.equal(activeTeam(uoaMe)?.teamId, 'uoa-team-current')
})

test('the active team leads the picker without separating organizations', () => {
  const teams: Team[] = [
    {
      organizationId: 'org-a',
      projectId: '',
      teamId: 'team-a-1',
      label: 'Design',
      orgName: 'Acme',
    },
    {
      organizationId: 'org-b',
      projectId: '',
      teamId: 'team-b-1',
      label: 'General',
      orgName: 'Beta',
      active: true,
    },
    {
      organizationId: 'org-a',
      projectId: '',
      teamId: 'team-a-2',
      label: 'Engineering',
      orgName: 'Acme',
    },
  ]

  assert.deepEqual(orderTeamsWithActiveFirst(teams, 'team-b-1'), [
    teams[1],
    teams[0],
    teams[2],
  ])
})
