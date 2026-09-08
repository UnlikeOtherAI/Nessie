import crypto from 'node:crypto'

import { safeFetch, type PinnedFetch, type ResolveHost } from './url-safety.js'

const REQUEST_TIMEOUT_MS = 10_000

/** Settings needed by the signed product-to-UOA organisation API boundary. */
export type UoaOrgRequestSettings = {
  authBaseUrl: string
  clientSecret: string
  configUrl: string
  sourceDomain: string
}

export type UoaOrgRequestDeps = {
  fetchImpl?: PinnedFetch
  resolveHost?: ResolveHost
  subjectAssertion?: string
}

export type UoaOrgRequestInit = {
  body?: unknown
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  query?: Record<string, string>
}

export class UoaOrgRequestUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UoaOrgRequestUnavailableError'
  }
}

export class UoaOrgRequestRejectedError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly upstreamCode?: string,
  ) {
    super(message)
    this.name = 'UoaOrgRequestRejectedError'
  }
}

const clientHash = (settings: UoaOrgRequestSettings): string =>
  crypto.createHash('sha256')
    .update(settings.sourceDomain + settings.clientSecret)
    .digest('hex')

const urlFor = (
  settings: UoaOrgRequestSettings,
  path: string,
  query: Record<string, string> = {},
): URL => {
  const url = new URL(`${settings.authBaseUrl.replace(/\/$/, '')}${path}`)
  url.searchParams.set('domain', settings.sourceDomain)
  url.searchParams.set('config_url', settings.configUrl)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url
}

/**
 * One pinned `/org/*` call. It has no cache and returns only parsed response
 * data, so callers must make their own authority decision on every boundary.
 */
export const requestUoaOrganization = async (
  settings: UoaOrgRequestSettings,
  path: string,
  init: UoaOrgRequestInit = { method: 'GET' },
  deps: UoaOrgRequestDeps = {},
): Promise<unknown> => {
  let response: Response
  try {
    response = await safeFetch(urlFor(settings, path, init.query), {
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
      maxRedirects: 0,
    })
  } catch {
    throw new UoaOrgRequestUnavailableError('[uoa] the org API is temporarily unavailable')
  }

  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      let upstreamCode: string | undefined
      try {
        const body = JSON.parse(await response.text()) as { code?: unknown }
        upstreamCode = typeof body.code === 'string' ? body.code.trim() || undefined : undefined
      } catch {
        // A refusal is still a refusal when its body is unreadable.
      }
      throw new UoaOrgRequestRejectedError(
        `[uoa] the org API refused the request (${response.status})`,
        response.status,
        upstreamCode,
      )
    }
    throw new UoaOrgRequestUnavailableError(`[uoa] the org API returned ${response.status}`)
  }

  const text = await response.text()
  if (text.trim().length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new UoaOrgRequestUnavailableError('[uoa] the org API returned a malformed body')
  }
}
