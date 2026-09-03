import type { MemberRole, Prisma } from '@prisma/client'

import type { ExternalAuthTeam } from './identity-display.js'
import { wouldRemoveLastOwner } from './organization-owner-lock.js'

/**
 * UOA owns org/team membership and roles; the local `organization_members`,
 * `project_members`, and `team_members` rows are a **projection** of the
 * verified `org.org_role` / `org.team_roles[externalTeamId]` claims carried by the
 * signed UOA access token (SSO gap analysis, phase 4). Every path that receives
 * those claims — first login, session refresh, team-switch materialization
 * — re-applies them, so a demotion or promotion in UOA propagates instead of
 * being frozen at first join.
 *
 * Only a *present* claim projects. An absent claim leaves the local row alone,
 * which is what keeps generic (non-UOA) OIDC providers and the local mode
 * byte-identical, and what preserves the first-materializer team-`owner` rule
 * for a team UOA sends no role for.
 *
 * **A role Nessie does not model is not an absent claim, and never a `member`.**
 * `org_roles` is already per-domain configurable in UOA, so a domain can mint
 * `auditor` — or `viewer`, the obvious first custom role — into these claims at
 * any time. Coercing an unrecognised string to `member` handed it *write*
 * capability, which is the opposite of a floor; and there is no local role that
 * grants nothing (Nessie's route gates read `owner` or bare membership, so
 * `viewer` writes exactly as `member` does). So an unrecognised role resolves to
 * no role at all and the login it arrived on is refused — a person whose
 * standing Nessie cannot express gets no session rather than the wrong one.
 * Wave 0 of `UnlikeOtherAuthenticator` `Docs/plans/2026-08-16-configurable-roles-
 * and-capabilities.md`; wave 3 replaces the refusal with a resolved capability
 * set. Behaviour-neutral until a domain configures its first custom role.
 */

/**
 * UOA claimed a role string this deployment cannot resolve to a local standing.
 * Thrown before any membership write, and answered as a refusal at each auth
 * boundary (`auth-login`, `auth-refresh`, `uoa-team-switch`).
 */
export class UoaUnrecognizedRoleError extends Error {
  constructor(
    readonly scope: 'org' | 'team',
    readonly claimedRole: string,
  ) {
    super(
      `UnlikeOtherAI claimed the ${scope} role "${claimedRole}", which this Nessie `
      + 'deployment does not model. Nessie refuses the session rather than guess a standing.',
    )
    this.name = 'UoaUnrecognizedRoleError'
  }
}

/**
 * UOA roles (`owner | admin | member`, plus the legacy spelling `lead`) → Nessie
 * MemberRole. `null` means "not a role this deployment models" — never a
 * fallback tier. `lead` stays mapped: it is a known legacy spelling, not an
 * unknown.
 */
export const mapUoaMemberRole = (role: string | undefined): MemberRole | null => {
  switch ((role ?? '').trim().toLowerCase()) {
    case 'owner':
      return 'owner'
    case 'admin':
    case 'lead':
      return 'admin'
    case 'member':
      return 'member'
    default:
      return null
  }
}

export type UoaRoleClaims = {
  /** UOA's `org.org_role`, mapped; null when the token carried none. */
  orgRole: MemberRole | null
  /** UOA's `org.team_roles[externalTeamId]`, mapped; null when it carried none. */
  teamRole: MemberRole | null
}

export const NO_UOA_ROLE_CLAIMS: UoaRoleClaims = { orgRole: null, teamRole: null }

const claimedRole = (
  value: string | undefined,
  scope: 'org' | 'team',
): MemberRole | null => {
  const claimed = value?.trim() ?? ''
  if (claimed.length === 0) {
    return null
  }
  const mapped = mapUoaMemberRole(claimed)
  if (mapped === null) {
    throw new UoaUnrecognizedRoleError(scope, claimed)
  }
  return mapped
}

/**
 * Read the verified role claims for one team out of the token's `org`
 * claim. Throws `UoaUnrecognizedRoleError` when UOA claimed a role string this
 * deployment does not model; a *missing* claim is still simply `null`.
 */
export const resolveUoaRoleClaims = (
  team: ExternalAuthTeam | undefined,
  externalTeamId: string | undefined,
): UoaRoleClaims => ({
  orgRole: claimedRole(team?.orgRole, 'org'),
  teamRole: externalTeamId ? claimedRole(team?.teamRoles?.[externalTeamId], 'team') : null,
})

/**
 * Project the org role onto the local membership.
 *
 * A per-UOA-org Organization (`externalOrgId` set — the 1:1 model) takes the
 * verified `org_role` claim as a COMPLETE statement: UOA owns that org's
 * membership outright, so a UOA demotion of the last local owner applies —
 * there is no last-owner floor. The floor survives only for a
 * null-`externalOrgId` organization (the legacy shared org before the data
 * partition), where a per-UOA-org claim was never a complete statement about
 * who administers the instance; the local-mode mutation routes keep their own
 * independent last-owner guard either way. The check runs under the same
 * `FOR UPDATE` owner-row lock the local mutators take, so concurrent
 * demotions serialize.
 */
const projectOrgRole = async (
  tx: Prisma.TransactionClient,
  input: { organizationId: string; role: MemberRole; userId: string },
): Promise<MemberRole | null> => {
  const current = await tx.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: input.organizationId,
        userId: input.userId,
      },
    },
    select: { role: true },
  })
  if (!current) {
    return null
  }
  if (current.role === input.role) {
    return current.role
  }
  if (current.role === 'owner') {
    const organization = await tx.organization.findUnique({
      where: { id: input.organizationId },
      select: { externalOrgId: true },
    })
    if (
      organization?.externalOrgId == null
      && await wouldRemoveLastOwner(tx, input.organizationId, input.userId)
    ) {
      return current.role
    }
  }
  await tx.organizationMember.updateMany({
    where: { organizationId: input.organizationId, userId: input.userId },
    data: { role: input.role },
  })
  return input.role
}

/**
 * Re-apply UOA's verified roles to one user's local membership rows for one
 * team. Idempotent, and a no-op for every dimension UOA did not claim.
 * The project row tracks the team claim: a UOA team is exactly one local
 * project + team.
 *
 * Returns the org role that is now in force (null when UOA claimed none), so a
 * caller that already read the pre-projection role does not have to re-query.
 */
export const projectUoaRoles = async (
  tx: Prisma.TransactionClient,
  input: {
    claims: UoaRoleClaims
    organizationId: string
    projectId: string
    teamId: string
    userId: string
  },
): Promise<{ orgRole: MemberRole | null }> => {
  let orgRole: MemberRole | null = null
  if (input.claims.orgRole) {
    orgRole = await projectOrgRole(tx, {
      organizationId: input.organizationId,
      role: input.claims.orgRole,
      userId: input.userId,
    })
  }
  if (input.claims.teamRole) {
    await tx.projectMember.updateMany({
      where: { projectId: input.projectId, userId: input.userId },
      data: { role: input.claims.teamRole },
    })
    await tx.teamMember.updateMany({
      where: { teamId: input.teamId, userId: input.userId },
      data: { role: input.claims.teamRole },
    })
  }
  return { orgRole }
}
