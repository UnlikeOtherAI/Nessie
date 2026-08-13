import assert from 'node:assert/strict'
import test from 'node:test'

import type { MeResponse } from '@nessie/schemas'
import { activeWorkspace, workspacesFromMe } from '../src/lib/workspaces.js'

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
  uoaWorkspaces: [
    {
      organizationId: 'uoa-org-current',
      teamId: 'uoa-team-current',
      label: 'Current workspace',
      orgName: 'Nessie Works',
      active: true,
    },
    {
      organizationId: 'uoa-org-other',
      teamId: 'uoa-team-other',
      label: 'Another authorized workspace',
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
  assert.deepEqual(workspacesFromMe(uoaMe), [
    {
      organizationId: 'uoa-org-current',
      projectId: '',
      teamId: 'uoa-team-current',
      label: 'Current workspace',
      orgName: 'Nessie Works',
      active: true,
      uoaWorkspace: true,
    },
    {
      organizationId: 'uoa-org-other',
      projectId: '',
      teamId: 'uoa-team-other',
      label: 'Another authorized workspace',
      orgName: 'Ondrej’s Team',
      active: false,
      uoaWorkspace: true,
    },
  ])
  assert.equal(activeWorkspace(uoaMe)?.teamId, 'uoa-team-current')
})
