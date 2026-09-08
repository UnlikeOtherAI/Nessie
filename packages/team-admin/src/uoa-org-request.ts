import {
  requestUoaOrganization,
  UoaOrgRequestRejectedError,
  UoaOrgRequestUnavailableError,
  type PinnedFetch,
  type ResolveHost,
} from '@nessie/runtime'

import { isUoaConfigured, loadUoaSettings, type UoaSettings } from './uoa-settings.js'

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
  try {
    return await requestUoaOrganization({
      authBaseUrl: settings.baseUrl,
      clientSecret: settings.clientSecret,
      configUrl: settings.configUrl,
      sourceDomain: settings.domain,
    }, path, init, deps)
  } catch (error) {
    if (error instanceof UoaOrgRequestRejectedError) {
      throw new UoaRosterRejectedError(error.message, error.statusCode, error.upstreamCode)
    }
    if (error instanceof UoaOrgRequestUnavailableError) {
      throw new UoaRosterUnavailableError(error.message)
    }
    throw error
  }
}

export const requireSettings = (): UoaSettings => {
  const settings = rosterSettings()
  if (!settings) {
    throw new UoaRosterUnavailableError('[uoa] this deployment has no UnlikeOtherAI credentials')
  }
  return settings
}
