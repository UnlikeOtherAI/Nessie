import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExternalAuthTeam } from '../src/services/identity-display.js'
import {
  mapUoaMemberRole,
  NO_UOA_ROLE_CLAIMS,
  projectUoaRoles,
  resolveUoaRoleClaims,
  UoaUnrecognizedRoleError,
} from '../src/services/uoa-roles.js'
import {
  materializeTeamTargetInTransaction,
} from '../src/services/team-target.js'

const TEAM_ID = 'uoa-ws-1'

const teamWith = (
  roles: { orgRole?: string; teamRole?: string },
): ExternalAuthTeam => ({
  orgId: 'uoa-org-1',
  teamIds: [TEAM_ID],
  teamRoles: roles.teamRole === undefined ? {} : { [TEAM_ID]: roles.teamRole },
  ...(roles.orgRole === undefined ? {} : { orgRole: roles.orgRole }),
})

// ── The known vocabulary is unchanged ───────────────────────────────────────

test('the known UOA roles map exactly as before', () => {
  assert.equal(mapUoaMemberRole('owner'), 'owner')
  assert.equal(mapUoaMemberRole('admin'), 'admin')
  assert.equal(mapUoaMemberRole('member'), 'member')
})

test('the legacy spelling `lead` is a known role, not an unknown', () => {
  assert.equal(mapUoaMemberRole('lead'), 'admin')
  assert.equal(mapUoaMemberRole('  LEAD '), 'admin')
})

test('known roles are case- and whitespace-insensitive', () => {
  assert.equal(mapUoaMemberRole('  OWNER '), 'owner')
  assert.equal(mapUoaMemberRole('Admin'), 'admin')
  assert.equal(mapUoaMemberRole('MEMBER'), 'member')
})

test('a claim UOA did not send is absent, not a role', () => {
  assert.equal(mapUoaMemberRole(undefined), null)
  assert.equal(mapUoaMemberRole(''), null)
  assert.equal(mapUoaMemberRole('   '), null)
  assert.deepEqual(resolveUoaRoleClaims(undefined, TEAM_ID), NO_UOA_ROLE_CLAIMS)
  assert.deepEqual(
    resolveUoaRoleClaims(teamWith({}), TEAM_ID),
    NO_UOA_ROLE_CLAIMS,
  )
})

test('known claims resolve to the same local standing they always did', () => {
  assert.deepEqual(
    resolveUoaRoleClaims(teamWith({ orgRole: 'admin', teamRole: 'owner' }), TEAM_ID),
    { orgRole: 'admin', teamRole: 'owner' },
  )
  assert.deepEqual(
    resolveUoaRoleClaims(teamWith({ orgRole: 'lead', teamRole: 'member' }), TEAM_ID),
    { orgRole: 'admin', teamRole: 'member' },
  )
})

// ── An unknown role grants nothing ──────────────────────────────────────────

test('an unrecognised role is never coerced to a local standing', () => {
  for (const role of ['auditor', 'viewer', 'superuser', 'guest', 'Auditor', ' auditor ']) {
    assert.equal(mapUoaMemberRole(role), null, `expected ${role} to resolve to no role`)
  }
})

const refusalFor = (team: ExternalAuthTeam): UoaUnrecognizedRoleError => {
  try {
    resolveUoaRoleClaims(team, TEAM_ID)
  } catch (error) {
    assert.ok(error instanceof UoaUnrecognizedRoleError, `unexpected error: ${String(error)}`)
    return error
  }
  throw new assert.AssertionError({
    message: 'expected an unrecognised role to be refused, not resolved',
  })
}

test('an unrecognised org role refuses the session instead of granting member', () => {
  const error = refusalFor(teamWith({ orgRole: 'auditor' }))
  assert.equal(error.scope, 'org')
  assert.equal(error.claimedRole, 'auditor')
})

test('an unrecognised team role refuses the session instead of granting member', () => {
  const error = refusalFor(teamWith({ teamRole: 'auditor' }))
  assert.equal(error.scope, 'team')
  assert.equal(error.claimedRole, 'auditor')
})

test('`viewer` — the obvious first custom role — is refused, never promoted', () => {
  assert.equal(refusalFor(teamWith({ orgRole: 'viewer' })).claimedRole, 'viewer')
})

test('an unrecognised role for another team does not refuse this one', () => {
  const team: ExternalAuthTeam = {
    orgId: 'uoa-org-1',
    orgRole: 'member',
    teamIds: [TEAM_ID, 'uoa-ws-2'],
    teamRoles: { [TEAM_ID]: 'admin', 'uoa-ws-2': 'auditor' },
  }
  assert.deepEqual(resolveUoaRoleClaims(team, TEAM_ID), {
    orgRole: 'member',
    teamRole: 'admin',
  })
})

// ── Nothing is written on the way to the refusal ────────────────────────────

test('team materialization refuses before it reads or writes anything', async () => {
  // The materializer is where a login turns claims into memberships. An
  // unresolvable claim has to stop it before the first query, so nothing is
  // half-provisioned and no team is joined at a guessed standing.
  const forbidden = (): never => {
    throw new Error('materialization must not touch the database for an unresolved claim')
  }
  const tx = {
    boardColumn: { createMany: forbidden },
    channel: { create: forbidden, findFirst: forbidden },
    project: { create: forbidden },
    team: { create: forbidden, findUnique: forbidden },
  }
  await assert.rejects(
    materializeTeamTargetInTransaction(
      tx as unknown as Parameters<typeof materializeTeamTargetInTransaction>[0],
      'org-1',
      TEAM_ID,
      teamWith({ orgRole: 'member', teamRole: 'auditor' }),
    ),
    UoaUnrecognizedRoleError,
  )
})

test('an absent claim still projects nothing, exactly as before', async () => {
  // The refusal above happens in `resolveUoaRoleClaims`, which the team
  // materialization calls before any write in its transaction — so an
  // unresolvable claim never reaches `projectUoaRoles` at all. What still has
  // to hold is the generic-OIDC / local-mode path: absent claims write nothing.
  const forbidden = (): never => {
    throw new Error('projectUoaRoles must not write for an absent claim')
  }
  const client = {
    organizationMember: { findUnique: forbidden, updateMany: forbidden },
    projectMember: { updateMany: forbidden },
    teamMember: { updateMany: forbidden },
  }
  const result = await projectUoaRoles(
    client as unknown as Parameters<typeof projectUoaRoles>[0],
    {
      claims: NO_UOA_ROLE_CLAIMS,
      organizationId: 'org-1',
      projectId: 'project-1',
      teamId: 'team-1',
      userId: 'user-1',
    },
  )
  assert.deepEqual(result, { orgRole: null })
})
