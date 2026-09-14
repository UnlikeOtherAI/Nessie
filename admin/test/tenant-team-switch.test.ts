import assert from 'node:assert/strict'
import test from 'node:test'

import type { MeResponse } from '@nessie/schemas'
import { tenantTeamSwitchNeeded } from '../src/layouts/tenant/tenant-team-switch.js'

const me = (activeTeamId: string, providerType = 'uoa'): MeResponse => ({
  auth: { providerId: 'uoa', providerType, autoRedirectToSso: false },
  context: {
    bootstrapMode: false,
    organizationId: 'local-org',
    projectId: 'local-project',
    teamId: `local-${activeTeamId}`,
  },
  user: { id: 'user-a' },
  uoaTeams: ['uoa-team-a', 'uoa-team-b'].map((teamId) => ({
    active: teamId === activeTeamId,
    label: teamId,
    organizationId: 'uoa-org',
    teamId,
  })),
} as unknown as MeResponse)

const hostTeam = { externalOrgId: 'uoa-org', externalTeamId: 'uoa-team-b' }

test('a team host does not re-switch onto the team the session is already on', () => {
  assert.equal(tenantTeamSwitchNeeded(me('uoa-team-b'), hostTeam), false)
})

test('a team host switches when the session is on another team', () => {
  assert.equal(tenantTeamSwitchNeeded(me('uoa-team-a'), hostTeam), true)
  assert.equal(
    tenantTeamSwitchNeeded(me('uoa-team-b'), { ...hostTeam, externalOrgId: 'other-org' }),
    true,
  )
})

test('a session without a UOA directory still switches and lets the server decide', () => {
  assert.equal(tenantTeamSwitchNeeded(me('uoa-team-b', 'local-bootstrap'), hostTeam), true)
  assert.equal(tenantTeamSwitchNeeded(null, hostTeam), true)
})
