import assert from 'node:assert/strict'
import test from 'node:test'

import type { MeResponse } from '@nessie/schemas'
import { teamHostSettling, tenantTeamSwitchNeeded } from '../src/layouts/tenant/tenant-team-switch.js'

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

/**
 * The bug: arriving at a team address drew the app against the team the
 * session was already on, then swapped it when the switch landed. Each case
 * below is one way that happened.
 */
const settlingInput = (over: Partial<Parameters<typeof teamHostSettling>[0]> = {}) => ({
  hasToken: true,
  hostKind: 'team' as const,
  me: me('uoa-team-a'),
  sessionState: 'authenticated',
  switching: false,
  team: hostTeam,
  teamLoading: false,
  ...over,
})

test('a team address whose session is on another team is still settling', () => {
  assert.equal(teamHostSettling(settlingInput()), true)
})

test('it is still settling while the address has not resolved to a team', () => {
  assert.equal(teamHostSettling(settlingInput({ team: null, teamLoading: true })), true)
})

test('it is still settling while the switch itself is in flight', () => {
  // The moment the request is sent the session still names the old team, so
  // "needed" is no longer enough on its own to hold the curtain up.
  assert.equal(
    teamHostSettling(settlingInput({ me: me('uoa-team-b'), switching: true })),
    true,
  )
})

test('once the session is on this host’s team it has settled', () => {
  assert.equal(teamHostSettling(settlingInput({ me: me('uoa-team-b') })), false)
})

test('a signed-out visitor is not settling — they get the tenant sign-in', () => {
  assert.equal(
    teamHostSettling(settlingInput({ hasToken: false, sessionState: 'unauthenticated' })),
    false,
  )
})

test('an organisation portal and an ordinary host never settle', () => {
  assert.equal(teamHostSettling(settlingInput({ hostKind: 'organisation' })), false)
  assert.equal(teamHostSettling(settlingInput({ hostKind: undefined })), false)
})
