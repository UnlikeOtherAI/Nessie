import {
  orgPath,
  requireSettings,
  rosterRequest,
  type UoaRosterDeps,
  type UoaRosterTeam,
} from './uoa-org-request.js'

/**
 * The organisation's own profile on UnlikeOtherAI's `/org/*` API.
 *
 * UOA owns the organisation object exactly as it owns the people in it, so a
 * rename is a write to UOA — not to the local mirror. Nessie used to write
 * `Organization.name` and stop there, which produced the defect this exists to
 * close: the new name showed inside Nessie, UOA's team chooser (and every
 * other UOA-integrated product) kept the old one, and the next login's
 * directory sync (`syncExternalOrganizationNames`) silently reverted the local
 * row. `Organization.name` stays a non-authoritative mirror; nothing but UOA
 * decides its value.
 *
 * Authorization is UOA's: `PUT /org/organisations/:orgId` requires the
 * `organisation.manage` capability at ORG scope (owner/admin under the default
 * grant table), re-resolved from live membership behind the caller's
 * short-lived subject assertion. Nessie's own owner/admin gate stays the local
 * entitlement check before the mutation is sent upstream.
 */
export const renameUoaOrganization = async (
  team: UoaRosterTeam,
  name: string,
  deps: UoaRosterDeps = {},
): Promise<string> => {
  const payload = await rosterRequest(
    requireSettings(),
    orgPath(team),
    { method: 'PUT', body: { name } },
    deps,
  )
  // UOA echoes the stored organisation record. Its `name` is the authority —
  // UOA normalizes what it accepted — so the mirror is written from the
  // response, falling back to the requested name only when the body carries
  // none.
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null
  const stored = typeof record?.name === 'string' ? record.name.trim() : ''
  return stored.length > 0 ? stored : name
}
