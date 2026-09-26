import { readUoaOrgMe } from '@nessie/runtime'
import type { UoaSessionIdentity } from '@nessie/schemas'

import {
  toRosterError,
  type UoaRosterDeps,
  UoaRosterRejectedError,
} from './uoa-org-request.js'
import { delegatedSettings, requireOrgSessionIdentity } from './uoa-org-roster.js'

/** UOA's non-configurable recovery role; it holds every declared capability. */
export const UOA_OWNER_ROLE = 'owner'

export type UoaRoleGrantScope = 'org' | 'team'

/** The verified product config's role-to-capability declaration. */
export type UoaRoleGrants = Partial<Record<UoaRoleGrantScope, Record<string, readonly string[]>>>

export type UoaOrganizationRoleContext = {
  organizationId: string
  role: string
  teamRoles: Record<string, string>
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

/**
 * Resolve one declared capability from one live UOA role. This is deliberately
 * generic: the product owns the capability name and signed grant table, while
 * UOA remains the authority for the role string. Unknown roles hold nothing.
 */
export const uoaRoleHoldsCapability = (
  grants: UoaRoleGrants,
  scope: UoaRoleGrantScope,
  role: string | null | undefined,
  capability: string,
): boolean =>
  role === UOA_OWNER_ROLE || grants[scope]?.[role ?? '']?.includes(capability) === true

/**
 * Read the caller's current ORGANISATION role from UOA through the subject
 * assertion path. The response must name precisely the organisation the
 * caller asked Nessie to administer; anything else is a refusal, not a
 * fallback to a local membership projection. Concurrent reads for the same
 * session share the one in flight (`readUoaOrgMe`); nothing outlives it.
 */
export const readUoaOrganizationRoleContext = async (
  organizationId: string,
  identity: UoaSessionIdentity | undefined,
  deps: Omit<UoaRosterDeps, 'subjectAssertion'> = {},
): Promise<UoaOrganizationRoleContext> => {
  const assertionIdentity = requireOrgSessionIdentity(organizationId, identity)
  let payload: unknown
  try {
    payload = await readUoaOrgMe(delegatedSettings(), assertionIdentity, {
      fetchImpl: deps.fetchImpl,
      resolveHost: deps.resolveHost,
    })
  } catch (error) {
    throw toRosterError(error)
  }
  const org = asRecord(asRecord(payload)?.org)
  const resolvedOrganizationId = text(org?.org_id)
  const role = text(org?.org_role)
  if (resolvedOrganizationId !== organizationId || !role) {
    throw new UoaRosterRejectedError(
      '[uoa] the current user has no active role in this organisation',
      403,
      'INSUFFICIENT_ORG_ROLE',
    )
  }
  const rawTeamRoles = asRecord(org?.team_roles)
  const teamRoles = Object.fromEntries(
    Object.entries(rawTeamRoles ?? {}).flatMap(([teamId, value]) => {
      const role = text(value)
      return role ? [[teamId, role]] : []
    }),
  )
  return { organizationId: resolvedOrganizationId, role, teamRoles }
}
