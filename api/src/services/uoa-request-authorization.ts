import type { UoaSessionIdentity } from '@nessie/schemas'
import {
  readUoaOrganizationRoleContext,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaOrgRosterSubjectAssertion,
  type UoaRosterDeps,
} from '@nessie/team-admin'

import { mapUoaMemberRole } from './uoa-roles.js'

export type UoaRequestAuthorization =
  | { status: 'allowed'; role: string }
  | { status: 'forbidden' }
  | { status: 'unavailable' }

/**
 * A local access JWT is not proof of current UOA membership. The signed
 * /org/me path rechecks credential epoch, organisation status and the active
 * team's membership before returning its live organisation role. Nothing is
 * persisted or reused across requests, including upstream failures.
 */
export const authorizeUoaRequest = async (
  organizationId: string,
  identity: UoaSessionIdentity | undefined,
  deps: UoaRosterDeps = {},
): Promise<UoaRequestAuthorization> => {
  try {
    const current = await readUoaOrganizationRoleContext(
      organizationId,
      withUoaOrgRosterSubjectAssertion(organizationId, identity, deps),
    )
    const role = mapUoaMemberRole(current.role)
    return role ? { status: 'allowed', role } : { status: 'forbidden' }
  } catch (error) {
    if (error instanceof UoaRosterUnavailableError) return { status: 'unavailable' }
    if (error instanceof UoaRosterIdentityError || error instanceof UoaRosterRejectedError) {
      return { status: 'forbidden' }
    }
    throw error
  }
}
