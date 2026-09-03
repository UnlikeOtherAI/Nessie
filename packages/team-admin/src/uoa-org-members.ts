import { createUoaSubjectAssertion } from '@nessie/runtime'
import type { UoaSessionIdentity, TeamMemberRecord } from '@nessie/schemas'

import {
  orgPath,
  requireSettings,
  rosterRequest,
  type UoaRosterDeps,
} from './uoa-org-request.js'
import {
  delegatedSettings,
  parseOrgMembers,
  UoaRosterIdentityError,
} from './uoa-org-roster.js'

/**
 * Attach an assertion of the signed-in UOA user to an ORG-scoped roster
 * operation. Sibling of `withUoaRosterSubjectAssertion` (uoa-org-roster.ts),
 * which additionally requires an exact TEAM match — an org-scoped call has
 * no single team to check against, so this only requires the session's org
 * to match. The session's active team still has to be somewhere inside this
 * org for the identity to exist at all; UOA re-verifies live membership on
 * every call regardless.
 */
export const withUoaOrgRosterSubjectAssertion = (
  orgId: string,
  identity: UoaSessionIdentity | undefined,
  deps: UoaRosterDeps = {},
): UoaRosterDeps => {
  if (!identity || identity.tokenVersion === null || identity.organizationId !== orgId) {
    throw new UoaRosterIdentityError(
      'A current UnlikeOtherAI session for this organisation is required.',
    )
  }
  const settings = delegatedSettings()
  return {
    ...deps,
    subjectAssertion: createUoaSubjectAssertion(
      settings,
      {
        organizationId: identity.organizationId,
        subject: identity.subject,
        teamId: identity.teamId,
        tokenVersion: identity.tokenVersion,
      },
      `${settings.authBaseUrl}/org`,
    ),
  }
}

/**
 * The organisation-wide roster: every member of the UOA organisation, with
 * their ORG role — never scoped to a single team. This is deliberately
 * distinct from `listTeamMembers` (uoa-org-roster.ts), which joins a
 * team's membership with org identity and is correctly team-scoped for the
 * team-members surface. An "Organization Members" page must read this
 * function, not that one — see docs/plans/2026-08-31-identity-belonging-audit.md
 * (the org-vs-team scope confusion class of bug) for why the distinction
 * matters.
 */
export const listOrganisationMembers = async (
  orgId: string,
  deps: UoaRosterDeps = {},
): Promise<TeamMemberRecord[]> => {
  const settings = requireSettings()
  const payload = await rosterRequest(
    settings,
    `${orgPath({ externalOrgId: orgId })}/members`,
    { method: 'GET', query: { status: 'all' } },
    deps,
  )
  return [...parseOrgMembers(payload).values()]
}

/** Change a member's ORG role (owner | admin | member). */
export const updateOrganisationMemberRole = async (
  orgId: string,
  uoaSub: string,
  role: string,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  await rosterRequest(
    requireSettings(),
    `${orgPath({ externalOrgId: orgId })}/members/${encodeURIComponent(uoaSub)}`,
    { method: 'PUT', body: { role } },
    deps,
  )
}
