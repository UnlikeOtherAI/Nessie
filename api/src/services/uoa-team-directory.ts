import {
  safeFetch,
  type PinnedFetch,
  type ResolveHost,
} from '@nessie/runtime'

import {
  clientHash,
  type UoaSettings,
} from './uoa-auth.js'

export type UoaTeamDirectoryEntry = {
  organizationId: string
  teamId: string
  avatarImageUrl?: string
  label: string
  orgName?: string
}

export type UoaPendingTeamInvite = {
  inviteId: string
  organizationId: string
  teamId: string
  teamName: string
  invitedBy?: string
  expiresAt?: string
}

export type UoaTeamDirectory = {
  entries: UoaTeamDirectoryEntry[]
  pendingInvites: UoaPendingTeamInvite[]
}

export type UoaSessionHttpDeps = {
  fetchImpl?: PinnedFetch
  resolveHost?: ResolveHost
}

const trimString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const parseAvatarImageUrl = (
  value: unknown,
  baseUrl: string,
): string | undefined => {
  const candidate = trimString(value)
  if (!candidate) return undefined

  try {
    // Resolve only a true root-relative path against UOA. Protocol-relative
    // and backslash-host forms must not silently select another origin.
    const rootRelative = candidate.startsWith('/') && !candidate.startsWith('//')
    const base = new URL(baseUrl)
    const url = rootRelative ? new URL(candidate, base) : new URL(candidate)
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || (rootRelative && url.origin !== base.origin)
    ) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * The organisation block of a `/org/me` answer, or null when UOA returned none.
 *
 * `{ ok: true }` with no `org` is UOA saying it could not resolve an
 * organisation context for this token on this domain — a different answer from
 * "you belong to no teams", and the two must not collapse, or a cached empty
 * directory suppresses the local fallback for the whole TTL.
 */
const orgBlock = (payload: unknown): Record<string, unknown> | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const org = (payload as { org?: unknown }).org
  if (!org || typeof org !== 'object' || Array.isArray(org)) return null
  return org as Record<string, unknown>
}

const parseTeamDirectoryEntries = (
  payload: unknown,
  baseUrl: string,
): UoaTeamDirectoryEntry[] => {
  const org = orgBlock(payload)
  if (!org) return []
  /**
   * `team_directory`, NOT `teams`.
   *
   * UOA's `/org/me` carries both, and they are different types. `org.teams` is
   * the legacy array of team ID STRINGS from the JWT `org` claim
   * (`org-context.service.ts`: `teams: string[]`); `org.team_directory` is the
   * list of team objects the picker is built from — `teamId`, `orgId`, `name`,
   * `orgName`, `avatarImageUrl`, and the rest.
   *
   * Reading `teams` here did not fail loudly. Every element is a string, so
   * every element was dropped by the object check below and the directory came
   * back EMPTY, every time, for everyone. Nessie then fell back to a team list
   * derived from its own local rows — so the app showed a different set of
   * teams from the one UnlikeOtherAI shows, which is exactly the parallel
   * structure UOA ownership exists to prevent. UOA's own route comments warn
   * about this pair by name.
   */
  const teams = org.team_directory
  if (!Array.isArray(teams)) return []
  return teams.flatMap((team) => {
    if (!team || typeof team !== 'object' || Array.isArray(team)) return []
    const entry = team as Record<string, unknown>
    const organizationId = trimString(entry.orgId)
    const teamId = trimString(entry.teamId)
    const label = trimString(entry.name)
    const orgName = trimString(entry.orgName)
    const avatarImageUrl = parseAvatarImageUrl(entry.avatarImageUrl, baseUrl)
    if (!organizationId || !teamId || !label) return []
    return [{
      organizationId,
      teamId,
      ...(avatarImageUrl ? { avatarImageUrl } : {}),
      label,
      ...(orgName ? { orgName } : {}),
    }]
  })
}

const parsePendingTeamInvites = (
  payload: unknown,
): UoaPendingTeamInvite[] => {
  const org = orgBlock(payload)
  if (!org) return []
  const pendingInvites = org.pending_invites
  if (!Array.isArray(pendingInvites)) return []
  return pendingInvites.flatMap((invite) => {
    if (!invite || typeof invite !== 'object' || Array.isArray(invite)) return []
    const entry = invite as Record<string, unknown>
    const inviteId = trimString(entry.inviteId)
    const organizationId = trimString(entry.orgId)
    const teamId = trimString(entry.teamId)
    const teamName = trimString(entry.teamName)
    const invitedBy = trimString(entry.invitedBy)
    const expiresAt = trimString(entry.expiresAt)
    if (!inviteId || !organizationId || !teamId || !teamName) return []
    return [{
      inviteId,
      organizationId,
      teamId,
      teamName,
      ...(invitedBy ? { invitedBy } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    }]
  })
}

const parseTeamDirectory = (
  payload: unknown,
  baseUrl: string,
): UoaTeamDirectory => ({
  entries: parseTeamDirectoryEntries(payload, baseUrl),
  pendingInvites: parsePendingTeamInvites(payload),
})

const uoaFetchOptions = (deps: UoaSessionHttpDeps) => ({
  ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
  maxRedirects: 0,
})

/**
 * Fetch the non-authoritative UI directory with the freshly issued access
 * token. `undefined` means the opportunistic read failed and callers must keep
 * their last verified directory; a result (including empty lists) is a verified
 * response. A verified response keeps the team and invitation lists
 * together so an absent invite list is distinguishable from a failed read.
 */
export const fetchUoaTeamDirectory = async (
  settings: UoaSettings,
  configUrl: string,
  accessToken: string,
  deps: UoaSessionHttpDeps = {},
): Promise<UoaTeamDirectory | undefined> => {
  try {
    const directoryUrl = new URL(`${settings.baseUrl}/org/me`)
    directoryUrl.searchParams.set('domain', settings.domain)
    directoryUrl.searchParams.set('config_url', configUrl)
    const response = await safeFetch(directoryUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${clientHash(settings)}`,
        'X-UOA-Access-Token': `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(10_000),
    }, uoaFetchOptions(deps))
    if (!response.ok) {
      console.warn(`[uoa] team directory read failed: HTTP ${response.status}`)
      return undefined
    }

    const payload: unknown = await response.json()
    // No `org` block means UOA could not resolve an organisation context for
    // this token on this domain. Returning `undefined` rather than an empty
    // directory matters: `rememberUoaTeamDirectory` ignores `undefined` and
    // keeps the last verified copy, and the caller falls back to the local
    // team-derived list. Caching an empty one instead would pin "you have no
    // teams" for the whole TTL and suppress that fallback.
    if (!orgBlock(payload)) {
      console.warn('[uoa] team directory read returned no organisation context')
      return undefined
    }

    return parseTeamDirectory(payload, settings.baseUrl)
  } catch (error) {
    // Never silent. A directory read that fails leaves the product showing a
    // locally derived team list, which can disagree with UnlikeOtherAI — the
    // one thing nobody should have to discover from a screenshot.
    console.warn(
      `[uoa] team directory read threw: ${error instanceof Error ? error.message : 'unknown'}`,
    )
    return undefined
  }
}
