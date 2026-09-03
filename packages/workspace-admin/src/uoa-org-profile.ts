import {
  orgPath,
  requireSettings,
  rosterRequest,
  teamPath,
  type UoaRosterDeps,
  type UoaRosterWorkspace,
} from './uoa-org-request.js'

/**
 * The organisation's own profile on UnlikeOtherAI's `/org/*` API.
 *
 * UOA owns the organisation object exactly as it owns the people in it, so a
 * rename is a write to UOA — not to the local mirror. Nessie used to write
 * `Organization.name` and stop there, which produced the defect this exists to
 * close: the new name showed inside Nessie, UOA's workspace chooser (and every
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
  workspace: UoaRosterWorkspace,
  name: string,
  deps: UoaRosterDeps = {},
): Promise<string> => {
  const payload = await rosterRequest(
    requireSettings(),
    orgPath(workspace),
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

/**
 * The workspace's own name on UnlikeOtherAI's `/org/*` API.
 *
 * A workspace **is** a UOA team (`docs/standards/workspace-model.md`), so its
 * name is UOA's exactly as the organisation's is: `Team.name` is a
 * non-authoritative mirror that `syncExternalWorkspaceNames` heals from UOA's
 * verified directory on every login and rotation. Nessie used to refuse the
 * rename outright — `409 TEAM_NAME_OWNED_BY_IDP`, "rename it there and it will
 * follow here" — which left a person with no way to rename their own workspace
 * from the product they were standing in. Relaying is the fix a local write
 * could never be: UOA stays the authority, and every other UOA-integrated
 * surface sees the new name at the same instant Nessie does.
 *
 * Authorization is UOA's: `PUT /org/organisations/:orgId/teams/:teamId`
 * requires the `teams.manage` capability, re-resolved from live membership
 * behind the caller's short-lived subject assertion. Nessie's own owner/admin
 * check stays the local entitlement gate before the mutation is sent upstream.
 */
export const renameUoaWorkspace = async (
  workspace: UoaRosterWorkspace,
  name: string,
  deps: UoaRosterDeps = {},
): Promise<string> => {
  const payload = await rosterRequest(
    requireSettings(),
    teamPath(workspace),
    { method: 'PUT', body: { name } },
    deps,
  )
  // UOA echoes the stored team record; its `name` is the authority, because UOA
  // normalizes what it accepted. Fall back to the requested name only when the
  // response carries none.
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null
  const stored = typeof record?.name === 'string' ? record.name.trim() : ''
  return stored.length > 0 ? stored : name
}
