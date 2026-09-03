import {
  safeFetch,
  type PinnedFetch,
  type ResolveHost,
} from '@nessie/runtime'

import { clientHash, isUoaConfigured, loadUoaSettings, type UoaSettings } from './uoa-settings.js'

const ROSTER_TIMEOUT_MS = 10_000

/** The upstream could not be consulted, or answered with something unusable. */
export class UoaRosterUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UoaRosterUnavailableError'
  }
}

/** UOA refused the request (4xx). The caller's problem, not an outage. */
export class UoaRosterRejectedError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly upstreamCode?: string,
  ) {
    super(message)
    this.name = 'UoaRosterRejectedError'
  }
}

export type UoaRosterDeps = {
  fetchImpl?: PinnedFetch
  resolveHost?: ResolveHost
  /**
   * A short-lived product-signed assertion of the current UOA user. The
   * credential is intentionally distinct from UOA's own access token: UOA
   * verifies it against this product's JWKS and re-resolves live membership.
   */
  subjectAssertion?: string
}

/** The UOA org + team ids behind a Nessie team. Both are needed for `/org/*`. */
export type UoaRosterTeam = {
  externalOrgId: string
  externalTeamId: string
}

/** Configured UOA settings, or null when this deployment cannot call UOA at all. */
export const rosterSettings = (): UoaSettings | null => {
  if (!isUoaConfigured()) return null
  const settings = loadUoaSettings()
  return settings.clientSecret ? settings : null
}

export const orgPath = (team: Pick<UoaRosterTeam, 'externalOrgId'>): string =>
  `/org/organisations/${encodeURIComponent(team.externalOrgId)}`

export const teamPath = (team: UoaRosterTeam): string =>
  `${orgPath(team)}/teams/${encodeURIComponent(team.externalTeamId)}`

const rosterUrl = (
  settings: UoaSettings,
  path: string,
  query: Record<string, string> = {},
): URL => {
  const url = new URL(`${settings.baseUrl}${path}`)
  url.searchParams.set('domain', settings.domain)
  url.searchParams.set('config_url', settings.configUrl)
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value)
  }
  return url
}

const fetchOptions = (deps: UoaRosterDeps) => ({
  ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
  maxRedirects: 0,
})

/**
 * One `/org/*` call. The domain hash authenticates Nessie; a caller that has a
 * live UOA session also supplies its short-lived subject assertion so UOA can
 * authorize that person rather than treating Nessie as a tenant-wide backend.
 */
export const rosterRequest = async (
  settings: UoaSettings,
  path: string,
  init: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; query?: Record<string, string> },
  deps: UoaRosterDeps,
): Promise<unknown> => {
  let response: Response
  try {
    response = await safeFetch(
      rosterUrl(settings, path, init.query),
      {
        method: init.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${clientHash(settings)}`,
          ...(deps.subjectAssertion
            ? { 'X-UOA-Subject-Assertion': deps.subjectAssertion }
            : {}),
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(ROSTER_TIMEOUT_MS),
      },
      fetchOptions(deps),
    )
  } catch {
    throw new UoaRosterUnavailableError('[uoa] the org API is temporarily unavailable')
  }

  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      let upstreamCode: string | undefined
      try {
        const body = JSON.parse(await response.text()) as unknown
        const record = body && typeof body === 'object' && !Array.isArray(body)
          ? body as Record<string, unknown>
          : null
        upstreamCode = typeof record?.code === 'string'
          ? record.code.trim() || undefined
          : undefined
      } catch {
        // A refusal without a readable code is still a caller-visible 4xx,
        // not an org-directory outage.
      }
      throw new UoaRosterRejectedError(
        `[uoa] the org API refused the request (${response.status})`,
        response.status,
        upstreamCode,
      )
    }
    throw new UoaRosterUnavailableError(`[uoa] the org API returned ${response.status}`)
  }

  const text = await response.text()
  if (text.trim().length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new UoaRosterUnavailableError('[uoa] the org API returned a malformed body')
  }
}

export const requireSettings = (): UoaSettings => {
  const settings = rosterSettings()
  if (!settings) {
    throw new UoaRosterUnavailableError('[uoa] this deployment has no UnlikeOtherAI credentials')
  }
  return settings
}
