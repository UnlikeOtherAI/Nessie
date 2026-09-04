import type { MemberRole } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { isAdminRole } from '@nessie/schemas'
import {
  readUoaOrganizationRoleContext,
  uoaRoleHoldsCapability,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaOrgRosterSubjectAssertion,
  type UoaRoleGrants,
  type UoaRosterDeps,
} from '@nessie/team-admin'

/** The one Nessie capability that opens the Organization section. */
export const NESSIE_ORGANIZATION_MANAGE_CAPABILITY = 'nessie.organisation.manage'

/**
 * This is signed into Nessie's UOA client config and used unchanged here.
 * UOA owns the role vocabulary and answers the caller's live role; Nessie only
 * resolves its own declared capability. `owner` is structural in the shared
 * resolver, so it is intentionally absent from the grant table.
 */
export const NESSIE_UOA_ROLE_GRANTS: UoaRoleGrants = Object.freeze({
  org: Object.freeze({
    admin: Object.freeze([
      'members.manage',
      'teams.manage',
      'organisation.manage',
      NESSIE_ORGANIZATION_MANAGE_CAPABILITY,
    ]),
  }),
  team: Object.freeze({
    admin: Object.freeze(['members.manage', 'teams.manage']),
  }),
})

export const NESSIE_UOA_ORG_CAPABILITIES = Object.freeze([
  NESSIE_ORGANIZATION_MANAGE_CAPABILITY,
])

export type OrganizationAdministrationAccess =
  | { status: 'allowed' }
  | { status: 'forbidden' }
  | { status: 'unavailable' }

type OrganizationBinding = { externalOrgId: string | null }

/**
 * Resolve the Organization-section entitlement without consulting Nessie's
 * UOA membership projection. Local/no-IdP organisations retain the exact
 * owner/admin rule they had before; UOA-bound organisations are fail-closed
 * on a fresh `/org/me` role read.
 */
export const resolveOrganizationAdministrationAccess = async (
  input: {
    actorContext: AuthorizedActionContext
    organization: OrganizationBinding
    localRole?: MemberRole | null
  },
  rosterDeps: UoaRosterDeps = {},
): Promise<OrganizationAdministrationAccess> => {
  if (!input.organization.externalOrgId) {
    return isAdminRole(input.localRole) ? { status: 'allowed' } : { status: 'forbidden' }
  }

  try {
    const context = await readUoaOrganizationRoleContext(
      input.organization.externalOrgId,
      withUoaOrgRosterSubjectAssertion(
        input.organization.externalOrgId,
        input.actorContext.actionContext.uoaIdentity,
        rosterDeps,
      ),
    )
    return uoaRoleHoldsCapability(
      NESSIE_UOA_ROLE_GRANTS,
      'org',
      context.role,
      NESSIE_ORGANIZATION_MANAGE_CAPABILITY,
    ) ? { status: 'allowed' } : { status: 'forbidden' }
  } catch (error) {
    if (error instanceof UoaRosterUnavailableError) return { status: 'unavailable' }
    if (error instanceof UoaRosterIdentityError || error instanceof UoaRosterRejectedError) {
      return { status: 'forbidden' }
    }
    throw error
  }
}
