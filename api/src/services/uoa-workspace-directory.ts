import {
  safeFetch,
  type PinnedFetch,
  type ResolveHost,
} from '@nessie/runtime'

import {
  clientHash,
  type UoaSettings,
} from './uoa-auth.js'

export type UoaWorkspaceDirectoryEntry = {
  organizationId: string
  teamId: string
  avatarImageUrl?: string
  label: string
  orgName?: string
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

const parseWorkspaceDirectory = (
  payload: unknown,
  baseUrl: string,
): UoaWorkspaceDirectoryEntry[] => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const org = (payload as { org?: unknown }).org
  if (!org || typeof org !== 'object' || Array.isArray(org)) return []
  const workspaces = (org as { workspaces?: unknown }).workspaces
  if (!Array.isArray(workspaces)) return []
  return workspaces.flatMap((workspace) => {
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return []
    const entry = workspace as Record<string, unknown>
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

const uoaFetchOptions = (deps: UoaSessionHttpDeps) => ({
  ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
  maxRedirects: 0,
})

/**
 * Fetch the non-authoritative UI directory with the freshly issued access
 * token. `undefined` means the opportunistic read failed and callers must keep
 * their last verified directory; an array (including empty) is a verified
 * response.
 */
export const fetchUoaWorkspaceDirectory = async (
  settings: UoaSettings,
  configUrl: string,
  accessToken: string,
  deps: UoaSessionHttpDeps = {},
): Promise<UoaWorkspaceDirectoryEntry[] | undefined> => {
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
    return response.ok
      ? parseWorkspaceDirectory(await response.json(), settings.baseUrl)
      : undefined
  } catch {
    return undefined
  }
}
