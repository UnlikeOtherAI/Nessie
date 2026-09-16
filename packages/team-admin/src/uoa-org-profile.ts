import {
  orgPath,
  requireSettings,
  rosterRequest,
  teamPath,
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

/**
 * The team's own name on UnlikeOtherAI's `/org/*` API.
 *
 * A team **is** a UOA team (`docs/standards/team-model.md`), so its
 * name is UOA's exactly as the organisation's is: `Team.name` is a
 * non-authoritative mirror that `syncExternalTeamNames` heals from UOA's
 * verified directory on every login and rotation. Nessie used to refuse the
 * rename outright — `409 TEAM_NAME_OWNED_BY_IDP`, "rename it there and it will
 * follow here" — which left a person with no way to rename their own team
 * from the product they were standing in. Relaying is the fix a local write
 * could never be: UOA stays the authority, and every other UOA-integrated
 * surface sees the new name at the same instant Nessie does.
 *
 * Authorization is UOA's: `PUT /org/organisations/:orgId/teams/:teamId`
 * requires the `teams.manage` capability, re-resolved from live membership
 * behind the caller's short-lived subject assertion. Nessie's own owner/admin
 * check stays the local entitlement gate before the mutation is sent upstream.
 */
export const renameUoaTeam = async (
  team: UoaRosterTeam,
  name: string,
  deps: UoaRosterDeps = {},
): Promise<string> => (await updateUoaTeamIdentity(team, { name }, deps)).name ?? name

/**
 * A team's name and its address, both written where they are owned.
 *
 * The address — UOA's `slug` — is the team's DNS label, the left-most part of
 * `<teamSlug>.<orgSlug>.<base>`. It matters that this is the same `PUT` as the
 * rename rather than a second door: UOA validates the label there
 * (`@unlikeotherai/slug` refuses a bad or reserved one with a reason rather
 * than coercing it), checks it is free inside the organisation, and answers
 * with what it stored. A local write, or a direct edit to UOA's database,
 * would skip every one of those.
 *
 * Both fields are optional and only what is supplied is sent: an omitted field
 * leaves UOA's value alone, and sending a slug equal to the current one is a
 * no-op rather than an error.
 */
export const updateUoaTeamIdentity = async (
  team: UoaRosterTeam,
  changes: { name?: string; slug?: string },
  deps: UoaRosterDeps = {},
): Promise<{ name: string | null; slug: string | null }> => {
  const body: Record<string, string> = {}
  if (changes.name !== undefined) body.name = changes.name
  if (changes.slug !== undefined) body.slug = changes.slug
  const payload = await rosterRequest(
    requireSettings(),
    teamPath(team),
    { method: 'PUT', body },
    deps,
  )
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null
  const trimmed = (value: unknown): string | null => {
    const text = typeof value === 'string' ? value.trim() : ''
    return text.length > 0 ? text : null
  }
  // UOA normalizes what it accepted, so its echo is the authority for both.
  return { name: trimmed(record?.name), slug: trimmed(record?.slug) }
}
