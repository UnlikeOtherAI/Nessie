import type { SsoTheme } from '../contracts/auth.js'
import type { UoaSessionIdentity } from '@nessie/schemas'
import {
  resolveExternalWorkspaceSelection,
  resolveIdentityDisplayName,
  type ExternalAuthIdentity,
  type ExternalAuthWorkspace,
} from './identity-display.js'
import {
  UOA_SIGN_IN_THEMES,
  clientHash,
  ensureAllowedRedirectUrl,
  loadUoaSettings,
  themedConfigUrl,
  type UoaSettings,
} from './uoa-auth.js'

type UoaTokenResponse = {
  access_token?: unknown
  expires_in?: unknown
  refresh_token?: unknown
  refresh_token_expires_in?: unknown
  token_type?: unknown
}

export type UoaWorkspaceDirectoryEntry = {
  organizationId: string
  teamId: string
  label: string
  orgName?: string
}

export type UoaSessionExchange = {
  configUrl: string
  identity: ExternalAuthIdentity & {
    externalSubject: string
    uoaTokenVersion: number
    workspace: ExternalAuthWorkspace
  }
  refreshToken: string
  refreshTokenExpiresInSeconds: number
  workspaceDirectory: UoaWorkspaceDirectoryEntry[]
}

export class UoaSessionRefreshError extends Error {
  constructor(
    message: string,
    public readonly definitive: boolean,
  ) {
    super(message)
    this.name = 'UoaSessionRefreshError'
  }
}

const trimString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const stringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map(trimString)
    .filter((item): item is string => Boolean(item))
}

const stringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const entries = Object.entries(value)
    .map(([key, item]) => [trimString(key), trimString(item)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[0]) && Boolean(entry[1]))
  return Object.fromEntries(entries)
}

const decodeJwtClaims = (token: string): Record<string, unknown> => {
  const segment = token.split('.')[1]
  if (!segment) {
    throw new Error('[uoa] access token is not a JWT')
  }
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>
}

const parseUoaWorkspace = (claims: Record<string, unknown>): ExternalAuthWorkspace | undefined => {
  const orgClaim = claims.org
  const activeClaim = claims.active
  const org = orgClaim && typeof orgClaim === 'object' && !Array.isArray(orgClaim)
    ? orgClaim as Record<string, unknown>
    : undefined
  const active = activeClaim && typeof activeClaim === 'object' && !Array.isArray(activeClaim)
    ? activeClaim as Record<string, unknown>
    : undefined

  const workspace: ExternalAuthWorkspace = {
    teamIds: stringArray(org?.teams),
    teamRoles: stringRecord(org?.team_roles),
  }
  const activeOrgId = trimString(active?.orgId)
  const activeTeamId = trimString(active?.teamId)
  const orgId = trimString(org?.org_id)
  const orgRole = trimString(org?.org_role)

  if (activeOrgId) workspace.activeOrgId = activeOrgId
  if (activeTeamId) workspace.activeTeamId = activeTeamId
  if (orgId) workspace.orgId = orgId
  if (orgRole) workspace.orgRole = orgRole

  if (
    !workspace.activeOrgId &&
    !workspace.activeTeamId &&
    !workspace.orgId &&
    !workspace.orgRole &&
    workspace.teamIds.length === 0 &&
    Object.keys(workspace.teamRoles).length === 0
  ) {
    return undefined
  }
  return workspace
}

export const resolveUoaIdentityFromAccessToken = (accessToken: string): ExternalAuthIdentity => {
  const claims = decodeJwtClaims(accessToken)
  const email = trimString(claims.email)?.toLowerCase() ?? ''
  if (!email) {
    throw new Error('[uoa] access token did not carry an email claim')
  }
  const name = trimString(claims.name)
  const preferredUsername = trimString(claims.preferred_username)

  const identity: ExternalAuthIdentity = {
    displayName: resolveIdentityDisplayName(email, [name, preferredUsername]),
    email,
  }
  const tokenVersion = claims.tv
  if (tokenVersion !== undefined) {
    if (typeof tokenVersion !== 'number' || !Number.isSafeInteger(tokenVersion) || tokenVersion < 0) {
      throw new Error('[uoa] access token carried an invalid tv claim')
    }
    identity.uoaTokenVersion = tokenVersion
  }
  const externalSubject = trimString(claims.sub)
  const workspace = parseUoaWorkspace(claims)
  if (externalSubject) identity.externalSubject = externalSubject
  if (workspace) identity.workspace = workspace
  return identity
}

const parsePositiveSeconds = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`[uoa] token response carried an invalid ${field}`)
  }
  return value
}

const parseUoaSessionExchange = (
  payload: UoaTokenResponse,
  settings: UoaSettings,
  configUrl: string,
): { accessToken: string; exchange: UoaSessionExchange } => {
  const accessToken = trimString(payload.access_token)
  const refreshToken = trimString(payload.refresh_token)
  if (!accessToken || !refreshToken || payload.token_type !== 'Bearer') {
    throw new Error('[uoa] token response missing a required token field')
  }
  parsePositiveSeconds(payload.expires_in, 'expires_in')
  const refreshTokenExpiresInSeconds = parsePositiveSeconds(
    payload.refresh_token_expires_in,
    'refresh_token_expires_in',
  )
  const claims = decodeJwtClaims(accessToken)
  const identity = resolveUoaIdentityFromAccessToken(accessToken)
  const selectedWorkspace = resolveExternalWorkspaceSelection(identity.workspace)
  if (
    claims.domain !== settings.domain
    || claims.client_id !== clientHash(settings)
    || !identity.externalSubject
    || !identity.workspace
    || identity.uoaTokenVersion === undefined
    || !selectedWorkspace.organizationId
    || !selectedWorkspace.teamId
  ) {
    throw new Error('[uoa] token response carried an incomplete session proof')
  }
  return { accessToken, exchange: {
    configUrl,
    identity: {
      ...identity,
      externalSubject: identity.externalSubject,
      uoaTokenVersion: identity.uoaTokenVersion,
      workspace: identity.workspace,
    },
    refreshToken,
    refreshTokenExpiresInSeconds,
    workspaceDirectory: [],
  } }
}

const parseWorkspaceDirectory = (payload: unknown): UoaWorkspaceDirectoryEntry[] => {
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
    if (!organizationId || !teamId || !label) return []
    return [{ organizationId, teamId, label, ...(orgName ? { orgName } : {}) }]
  })
}

const fetchWorkspaceDirectory = async (
  settings: UoaSettings,
  configUrl: string,
  accessToken: string,
): Promise<UoaWorkspaceDirectoryEntry[]> => {
  try {
    const directoryUrl = new URL(`${settings.baseUrl}/org/me`)
    directoryUrl.searchParams.set('domain', settings.domain)
    directoryUrl.searchParams.set('config_url', configUrl)
    const response = await fetch(directoryUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${clientHash(settings)}`,
        'X-UOA-Access-Token': `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(10_000),
    })
    return response.ok ? parseWorkspaceDirectory(await response.json()) : []
  } catch {
    return []
  }
}

const ensureStoredConfigUrl = (
  settings: UoaSettings,
  storedConfigUrl: string,
): string => {
  try {
    const expected = new URL(settings.configUrl)
    const actual = new URL(storedConfigUrl)
    const theme = actual.searchParams.get('theme')
    actual.searchParams.delete('theme')
    if (
      actual.toString() !== expected.toString()
      || (theme !== null && !(theme in UOA_SIGN_IN_THEMES))
    ) {
      throw new Error('invalid')
    }
    return storedConfigUrl
  } catch {
    throw new UoaSessionRefreshError(
      '[uoa] stored refresh session has an invalid config URL',
      true,
    )
  }
}

/**
 * Exchange the authorization code for tokens and resolve the user identity from
 * the access-token claims.
 */
export const exchangeUoaSession = async (input: {
  code: string
  codeVerifier: string
  redirectUri: string
  theme?: SsoTheme
}): Promise<UoaSessionExchange> => {
  const settings = loadUoaSettings()
  ensureAllowedRedirectUrl(settings, input.redirectUri)

  if (!settings.clientSecret) {
    throw new Error('[uoa] UOA_CLIENT_SECRET is not set — approve the integration and configure the secret')
  }

  const tokenUrl = new URL(`${settings.baseUrl}/auth/token`)
  const configUrl = themedConfigUrl(settings, input.theme)
  tokenUrl.searchParams.set('config_url', configUrl)

  const response = await fetch(tokenUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${clientHash(settings)}`,
    },
    body: JSON.stringify({
      code: input.code,
      redirect_url: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  })
  if (!response.ok) {
    throw new Error(`[uoa] token endpoint returned ${response.status}`)
  }

  const parsed = parseUoaSessionExchange((await response.json()) as UoaTokenResponse, settings, configUrl)
  return {
    ...parsed.exchange,
    workspaceDirectory: await fetchWorkspaceDirectory(settings, configUrl, parsed.accessToken),
  }
}

export const exchangeUoaCode = async (input: {
  code: string
  codeVerifier: string
  redirectUri: string
  theme?: SsoTheme
}): Promise<ExternalAuthIdentity> =>
  (await exchangeUoaSession(input)).identity

export const refreshUoaSession = async (input: {
  configUrl: string
  expectedIdentity: UoaSessionIdentity
  refreshToken: string
  fetchImpl?: typeof fetch
}): Promise<UoaSessionExchange> => {
  const settings = loadUoaSettings()
  const configUrl = ensureStoredConfigUrl(settings, input.configUrl)
  const tokenUrl = new URL(`${settings.baseUrl}/auth/token`)
  tokenUrl.searchParams.set('config_url', configUrl)

  let response: Response
  try {
    response = await (input.fetchImpl ?? fetch)(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${clientHash(settings)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new UoaSessionRefreshError(
      '[uoa] refresh endpoint is temporarily unavailable',
      false,
    )
  }
  if (!response.ok) {
    throw new UoaSessionRefreshError(
      `[uoa] refresh endpoint returned ${response.status}`,
      [400, 401, 403].includes(response.status),
    )
  }

  let refreshed: UoaSessionExchange
  try {
    refreshed = parseUoaSessionExchange(
      await response.json() as UoaTokenResponse,
      settings,
      configUrl,
    ).exchange
  } catch (error) {
    throw new UoaSessionRefreshError(
      error instanceof Error ? error.message : '[uoa] invalid refresh response',
      false,
    )
  }
  const selected = resolveExternalWorkspaceSelection(refreshed.identity.workspace)
  if (
    input.expectedIdentity.tokenVersion === null
    || refreshed.identity.externalSubject !== input.expectedIdentity.subject
    || selected.organizationId !== input.expectedIdentity.organizationId
    || selected.teamId !== input.expectedIdentity.teamId
    || refreshed.identity.uoaTokenVersion < input.expectedIdentity.tokenVersion
  ) {
    throw new UoaSessionRefreshError(
      '[uoa] refresh response changed the bound session identity',
      true,
    )
  }
  return refreshed
}
