import {
  requireSettings,
  rosterRequest,
  type UoaRosterDeps,
  UoaRosterRejectedError,
} from './uoa-org-request.js'

/** UOA's non-configurable recovery role; it holds every declared capability. */
export const UOA_OWNER_ROLE = 'owner'

export type UoaRoleGrantScope = 'org' | 'team'

/** The verified product config's role-to-capability declaration. */
export type UoaRoleGrants = Partial<Record<UoaRoleGrantScope, Record<string, readonly string[]>>>

export type UoaOrganizationRoleContext = {
  organizationId: string
  role: string
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
 * fallback to a local membership projection.
 */
export const readUoaOrganizationRoleContext = async (
  organizationId: string,
  deps: UoaRosterDeps = {},
): Promise<UoaOrganizationRoleContext> => {
  const payload = await rosterRequest(
    requireSettings(),
    '/org/me',
    { method: 'GET' },
    deps,
  )
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
  return { organizationId: resolvedOrganizationId, role }
}
