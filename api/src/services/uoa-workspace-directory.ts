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

export type UoaPendingWorkspaceInvite = {
  inviteId: string
  organizationId: string
  teamId: string
  teamName: string
  invitedBy?: string
  expiresAt?: string
}

export type UoaWorkspaceDirectory = {
  entries: UoaWorkspaceDirectoryEntry[]
  pendingInvites: UoaPendingWorkspaceInvite[]
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

const parseWorkspaceDirectoryEntries = (
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

const parsePendingWorkspaceInvites = (
  payload: unknown,
): UoaPendingWorkspaceInvite[] => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const org = (payload as { org?: unknown }).org
  if (!org || typeof org !== 'object' || Array.isArray(org)) return []
  const pendingInvites = (org as { pending_invites?: unknown }).pending_invites
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

const parseWorkspaceDirectory = (
  payload: unknown,
  baseUrl: string,
): UoaWorkspaceDirectory => ({
  entries: parseWorkspaceDirectoryEntries(payload, baseUrl),
  pendingInvites: parsePendingWorkspaceInvites(payload),
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
 * response. A verified response keeps the workspace and invitation lists
 * together so an absent invite list is distinguishable from a failed read.
 */
export const fetchUoaWorkspaceDirectory = async (
  settings: UoaSettings,
  configUrl: string,
  accessToken: string,
  deps: UoaSessionHttpDeps = {},
): Promise<UoaWorkspaceDirectory | undefined> => {
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
