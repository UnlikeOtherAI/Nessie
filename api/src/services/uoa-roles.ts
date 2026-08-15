import type { MemberRole, Prisma } from '@prisma/client'

import type { ExternalAuthWorkspace } from './identity-display.js'
import { wouldRemoveLastOwner } from './organization-owner-lock.js'

/**
 * UOA owns org/team membership and roles; the local `organization_members`,
 * `project_members`, and `team_members` rows are a **projection** of the
 * verified `org.org_role` / `org.team_roles[workspaceId]` claims carried by the
 * signed UOA access token (SSO gap analysis, phase 4). Every path that receives
 * those claims — first login, session refresh, workspace-switch materialization
 * — re-applies them, so a demotion or promotion in UOA propagates instead of
 * being frozen at first join.
 *
 * Only a *present* claim projects. An absent claim leaves the local row alone,
 * which is what keeps generic (non-UOA) OIDC providers and the local mode
 * byte-identical, and what preserves the first-materializer team-`owner` rule
 * for a workspace UOA sends no role for.
 */

// UOA roles (`owner | admin | member`, plus legacy `lead`) → Nessie MemberRole.
export const mapUoaMemberRole = (role: string | undefined): MemberRole => {
  switch ((role ?? '').trim().toLowerCase()) {
    case 'owner':
      return 'owner'
    case 'admin':
    case 'lead':
      return 'admin'
    default:
      return 'member'
  }
}

export type UoaRoleClaims = {
  /** UOA's `org.org_role`, mapped; null when the token carried none. */
  orgRole: MemberRole | null
  /** UOA's `org.team_roles[workspaceId]`, mapped; null when it carried none. */
  teamRole: MemberRole | null
}

export const NO_UOA_ROLE_CLAIMS: UoaRoleClaims = { orgRole: null, teamRole: null }

const claimedRole = (value: string | undefined): MemberRole | null =>
  value && value.trim().length > 0 ? mapUoaMemberRole(value) : null

/** Read the verified role claims for one workspace out of the token's `org` claim. */
export const resolveUoaRoleClaims = (
  workspace: ExternalAuthWorkspace | undefined,
  workspaceId: string | undefined,
): UoaRoleClaims => ({
  orgRole: claimedRole(workspace?.orgRole),
  teamRole: workspaceId ? claimedRole(workspace?.teamRoles?.[workspaceId]) : null,
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
 * workspace. Idempotent, and a no-op for every dimension UOA did not claim.
 * The project row tracks the team claim: a UOA workspace is exactly one local
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
